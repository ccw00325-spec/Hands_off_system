import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clarificationQuestions, clarificationAnswers } from '../src/core/clarifications.js';
import { planningInstructions } from '../src/core/providers.js';
import { compileFunPlan } from '../src/core/fun-contract.js';
import { Workflow } from '../src/core/workflow.js';
import { Store } from '../src/core/store.js';
import { Projects } from '../src/core/projects.js';
import { Workspace } from '../src/core/workspace.js';
import { Conversations } from '../src/core/conversations.js';
import { AgentChat } from '../src/core/agent-chat.js';
import { InputNotifications } from '../src/core/input-notifications.js';
import { Preferences } from '../src/core/preferences.js';

const team = [{id:'gpt',provider:'gpt',roles:['control','debug']},{id:'grok',provider:'gpt',roles:['feature','ui']}];
const questions = [{id:'Q1',prompt:'어느 화면에서 시작할까요?',options:['목록 화면','상세 화면']},{id:'Q2',prompt:'누가 볼 수 있나요?',options:[]}];
const finalPlan = () => ({spec:'User-approved scope',tasks:[{id:'feature',owner:'grok',kind:'feature',instructions:'Implement approved scope',dependsOn:[],acceptanceCriteria:['value is approved']} ]});
async function fixture(t) {
  const base=await mkdtemp(join(tmpdir(),'cw-fun-'));t.after(()=>rm(base,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  const root=join(base,'project');await mkdir(root);const store=new Store(join(base,'data'),{});await store.init();
  const projects=new Projects(store),id=(await projects.list()).activeId,workspace=new Workspace(projects);
  const ticket=await workspace.prepare(id,root);await workspace.consent(id,ticket.ticket,true);
  return {base,root,store,projects,id,workspace};
}
test('clarifications accept legacy strings and explicit choices; partial, stale and forged choices are rejected',()=>{
  assert.deepEqual(clarificationQuestions(['Input needed']),[{id:'Q1',prompt:'Input needed',options:[]}]);
  assert.throws(()=>clarificationQuestions([{id:'same',prompt:'A'},{id:'same',prompt:'B'}]));
  assert.throws(()=>clarificationQuestions([{id:'Q',prompt:'A',options:[{}]}]));
  assert.throws(()=>clarificationAnswers(questions,[{id:'Q1',kind:'option',value:'목록 화면'}]));
  assert.throws(()=>clarificationAnswers(questions,[{id:'Q1',kind:'option',value:'forged'},{id:'Q2',kind:'text',value:'me'}]));
  assert.throws(()=>clarificationAnswers(questions,[{id:'Q1',kind:'text',value:'a'},{id:'Q1',kind:'text',value:'b'}]));
  const result=clarificationAnswers(questions,[{id:'Q1',kind:'option',value:'목록 화면'},{id:'Q2',kind:'text',value:'나만 보기'}]);
  assert.equal(result[1].value,'나만 보기');
});
test('disabled fun never reads the skill file; enabled fun prioritizes questions over unattended assumptions',async()=>{
  const disabled=await planningInstructions('/nonexistent/skill.md',{funEnabled:false});
  assert.match(disabled,/disabled \/fun/);assert.doesNotMatch(disabled,/# Fun —/);
  assert.match(disabled,/unsafe or irreversible/);
  const enabled=await planningInstructions(undefined,{funEnabled:true});
  assert.match(enabled,/Function = Context \+ Trigger/);assert.match(enabled,/Do not treat unattended mode as permission/);
  assert.match(enabled,/questionAnswers/);assert.match(enabled,/Workers do not receive this skill/);
});
test('strict fun converts unapproved assumptions and deferred product decisions to questions before compiling tasks',()=>{
  const result=compileFunPlan({decisions:[{source:'assumption',description:'Unchosen storage'}],reviewItems:[],tasks:[{}]}, {funEnabled:true});
  assert.equal(result.tasks.length,0);assert.match(result.questions[0].prompt,/Unchosen storage/);
});
test('real workflow pauses before writes, restores pending questions after restart, resumes the same run with decisions and rejects replay',async t=>{
  const f=await fixture(t);let builds=0;const contexts=[];
  const provider={ready:async()=>true,plan:async context=>{contexts.push(context);return context.options.questionAnswers?.length?finalPlan():{questions,tasks:[]};},
    build:async()=>{builds++;return {summary:'approved implementation',files:[{path:'approved.cjs',content:'exports.value="approved";'}]};},review:async()=>({summary:'checked',issues:[]})};
  const providers={gpt:provider,grok:provider};
  let engine=new Workflow(f.workspace,providers,()=>{},async()=>({configured:true,passed:true}));
  const original=await engine.start(f.id,{request:'Implement feature',team,conversationId:'conversation-a',maxRepairRounds:0,funEnabled:true});
  await engine.runs.get(f.id).promise;const waiting=await engine.current(f.id);assert.equal(waiting.status,'needs_input');assert.equal(builds,0);
  assert.equal((await f.workspace.snapshot(f.id)).files.some(file=>file.path==='approved.cjs'),false);
  engine=new Workflow(f.workspace,providers,()=>{},async()=>({configured:true,passed:true}));
  const restored=await engine.current(f.id,original.id);assert.equal(restored.questionBatchId,waiting.questionBatchId);
  const answers=[{id:'Q1',kind:'option',value:'목록 화면'},{id:'Q2',kind:'text',value:'나만 보기'}];
  await assert.rejects(engine.answerQuestions(f.id,original.id,waiting.questionBatchId,answers,'wrong-conversation'));
  await assert.rejects(engine.answerQuestions(f.id,original.id,'stale-batch',answers,'conversation-a'));
  await assert.rejects(engine.answerQuestions(f.id,original.id,waiting.questionBatchId,answers.slice(0,1),'conversation-a'));
  await engine.answerQuestions(f.id,original.id,waiting.questionBatchId,answers,'conversation-a');
  await engine.runs.get(f.id).promise;const completed=await engine.current(f.id);
  assert.equal(completed.id,original.id);assert.equal(completed.status,'completed');assert.equal(builds,1);
  assert.equal(contexts[1].options.questionAnswers[0].answers[1].value,'나만 보기');
  assert.equal(contexts[1].handoff.userDecisions[0].batchId,waiting.questionBatchId);
  assert.equal(await readFile(join(f.root,'approved.cjs'),'utf8'),'exports.value="approved";');
  assert.ok(completed.usage.calls>waiting.usage.calls);
  await assert.rejects(engine.answerQuestions(f.id,original.id,waiting.questionBatchId,answers,'conversation-a'));
});
test('fun-off work skips skill governance and its Function document but retains validation and mandatory questions',async t=>{
  const f=await fixture(t);let validation=0;
  const provider={ready:async()=>true,plan:async()=>finalPlan(),build:async()=>({summary:'done',files:[{path:'x.cjs',content:'exports.x=1;'}]}),review:async()=>({summary:'ok',issues:[]})};
  const engine=new Workflow(f.workspace,{gpt:provider,grok:provider},()=>{},async()=>{validation++;return {configured:true,passed:true};});
  const run=await engine.start(f.id,{request:'Work directly',team,maxRepairRounds:0,funEnabled:false});await engine.runs.get(f.id).promise;
  const done=await engine.current(f.id);assert.equal(done.status,'completed');assert.equal(done.governance.enabled,false);assert.equal(done.governance.sha256,null);assert.ok(validation>0);
  await assert.rejects(readFile(join(f.root,`Function/${run.id}_fun.md`)));
  assert.equal(await readFile(join(f.root,`.control-tower/runs/${run.id}/spec.md`),'utf8'),'User-approved scope');
  provider.plan=async()=>({questions:['Need permission'],tasks:[]});
  await engine.start(f.id,{request:'Unsafe scope',team,maxRepairRounds:0,funEnabled:false});await engine.runs.get(f.id).promise;
  assert.equal((await engine.current(f.id)).status,'needs_input');
});
test('chat checkbox controls only new work, preserves default fun and passes explicit off mode',async t=>{
  const f=await fixture(t),conversations=new Conversations(f.store,f.projects),chat=await conversations.create(f.id);const seen=[];
  const workflow={runs:new Map(),isActive:()=>false,start:async(id,options)=>{seen.push(options);return {id:'bfb4a3f1-4e32-4ad1-89bd-a3ece2bbb051'};},current:async()=>null};
  const agent=new AgentChat({conversations,workspace:f.workspace,workflow,optionsFor:async()=>({team,unattended:true})});
  await agent.send(f.id,chat.id,'gpt','Build it','work',false,'gpt');
  await agent.send(f.id,chat.id,'gpt','Build directly','work',false,'gpt',false);
  assert.equal(seen[0].funEnabled,true);assert.equal(seen[0].unattended,false);assert.equal(seen[1].funEnabled,false);assert.equal(seen[1].unattended,true);
});
test('native answer notification requests sound, contains no project secrets, deduplicates and activates exact project/conversation',async()=>{
  const created=[],saved=[],activated=[],failures=[];
  class FakeNotification extends EventEmitter {static isSupported(){return true;}constructor(options){super();this.options=options;created.push(this);}show(){this.shown=true;}}
  const attention=new InputNotifications({Notification:FakeNotification,persist:async row=>saved.push(row),activate:row=>activated.push(row),failed:row=>failures.push(row)});
  const state={id:'r',projectId:'p',status:'needs_input',questionBatchId:'batch1',questions:[{prompt:'private secret'}],request:'private request',options:{conversationId:'c'}};
  await Promise.all([attention.observe(state),attention.observe(state)]);assert.equal(created.length,1);assert.equal(created[0].shown,true);assert.equal(created[0].options.silent,false);
  assert.doesNotMatch(JSON.stringify(created[0].options),/private|secret/);created[0].emit('click');assert.deepEqual(activated,[{projectId:'p',conversationId:'c',action:'questions'}]);
  await attention.observe({...state,questionBatchId:'batch2'});assert.equal(created.length,2);assert.equal(saved.length,2);
  created[1].emit('failed');assert.equal(failures.length,1);
  await attention.observe({...state,status:'completed',questionBatchId:'batch3'});assert.equal(created.length,2);
});
test('unsupported native notifications retain actionable in-app history instead of failing work',async()=>{
  let saved=0,failed=0;
  const attention=new InputNotifications({Notification:{isSupported:()=>false},persist:async()=>saved++,failed:()=>failed++});
  await attention.observe({id:'r',projectId:'p',status:'needs_input',questionBatchId:'b',options:{conversationId:'c'}});
  assert.equal(saved,1);assert.equal(failed,1);
});
test('a delayed OS registration never posts a stale question after the user already answered',async()=>{
  let ready,created=0;const waiting=new Promise(resolve=>{ready=resolve;});
  class Fake extends EventEmitter {static isSupported(){return true;}constructor(){super();created++;}show(){}}
  const attention=new InputNotifications({Notification:Fake,register:()=>waiting});
  const state={id:'r',projectId:'p',status:'needs_input',questionBatchId:'b',options:{conversationId:'c'}};
  const first=attention.observe(state);await attention.observe({...state,status:'planning',questionBatchId:null});ready();await first;
  assert.equal(created,0);
});
test('turning fun off persists across preferences reload without granting execution or completing onboarding',async t=>{
  const f=await fixture(t),preferences=new Preferences(f.store,async()=> 'test-device');
  const before=await preferences.get();assert.equal(before.funByDefault,true);
  await preferences.setFunDefault(false);
  const restored=await new Preferences(f.store,async()=> 'test-device').get();
  assert.equal(restored.funByDefault,false);assert.equal(restored.allowExecution,false);assert.equal(restored.onboardingComplete,false);
  await assert.rejects(preferences.setFunDefault('false'));
});
test('repeated question rounds get fresh batch IDs, reject racing answers and append distinct assistant questions once each',async t=>{
  const f=await fixture(t),conversations=new Conversations(f.store,f.projects),conversation=await conversations.create(f.id);let rounds=0;
  const provider={ready:async()=>true,plan:async()=>({questions:[{id:'Q1',prompt:`정할 조건 ${++rounds}`,options:['선택 A','선택 B']}],tasks:[]})};
  const engine=new Workflow(f.workspace,{gpt:provider,grok:provider});
  const chat=new AgentChat({conversations,workspace:f.workspace,workflow:engine,optionsFor:async()=>({team})});
  await engine.start(f.id,{request:'Clarify in rounds',team,conversationId:conversation.id,maxRepairRounds:0,funEnabled:true});
  await engine.runs.get(f.id).promise;const first=await engine.current(f.id);await chat.finishedRun(first);
  const answers=[{id:'Q1',kind:'option',value:'선택 A'}];
  const requests=await Promise.allSettled([engine.answerQuestions(f.id,first.id,first.questionBatchId,answers,conversation.id),engine.answerQuestions(f.id,first.id,first.questionBatchId,answers,conversation.id)]);
  assert.equal(requests.filter(row=>row.status==='fulfilled').length,1);
  await engine.runs.get(f.id).promise;const second=await engine.current(f.id);assert.equal(second.status,'needs_input');assert.notEqual(second.questionBatchId,first.questionBatchId);
  await chat.finishedRun(second);await chat.finishedRun(second);
  const stored=await conversations.read(f.id,conversation.id);assert.equal(stored.messages.length,2);
  assert.match(stored.messages[0].content,/정할 조건 1/);assert.match(stored.messages[1].content,/정할 조건 2/);
});
