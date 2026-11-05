import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {Projects} from '../src/core/projects.js';
import {Workspace} from '../src/core/workspace.js';
import {Workflow,validatePlan} from '../src/core/workflow.js';
import {defaultTeam,resizeTeam,CAPABILITIES} from '../src/core/team.js';
import {reviewOrder,orderDebugTasks} from '../src/core/review-order.js';
import {validateProject} from '../src/core/validation.js';
import {roleProviders} from '../src/core/roles.js';
import {reviewFixturePlan,reviewFixtureBuild} from '../scripts/review-fixture.mjs';
for(const count of [2,4])test(`${count} panels cover all roles, share inspections/tests and avoid automatic Cursor UI assignment`,()=>{
  const team=resizeTeam(defaultTeam(),count);
  assert.deepEqual([...new Set(team.flatMap(agent=>agent.roles))].sort(),Object.keys(CAPABILITIES).sort());
  for(const agent of team)for(const role of ['debug','review','test'])assert.ok(agent.roles.includes(role));
  for(const role of ['control','feature','ui'])assert.equal(team.filter(agent=>agent.roles.includes(role)).length,1);
  assert.notEqual(team.find(agent=>agent.roles.includes('ui')).provider,'grok');
});
test('provider priority is stable for every possible control tower and the control tower is always last',()=>{
  const providers=['grok','gemini','claude','gpt'];
  for(const controller of providers){const remaining=providers.filter(value=>value!==controller);const team=resizeTeam(defaultTeam(),4);
    team.forEach((agent,index)=>agent.provider=index?remaining[index-1]:controller);
    assert.deepEqual(reviewOrder({team}).map(agent=>agent.provider),[...remaining,controller]);
  }
  const team=resizeTeam(defaultTeam({gpt:'gpt',grok:'gpt',claude:'gpt'}),4);
  assert.deepEqual(reviewOrder({team}).map(agent=>agent.id),['grok','claude','reviewer','gpt']);
});
test('unselected inspection roles do not receive calls; original debug dependencies cannot silently become cycles',()=>{
  const team=resizeTeam(defaultTeam(),2);team[1].roles=['feature'];
  assert.deepEqual(reviewOrder({team}).map(agent=>agent.id),['gpt']);
  const tasks=[{id:'a',owner:'gpt',kind:'debug',dependsOn:[],instructions:'Inspect',acceptanceCriteria:['Reviewed']},
    {id:'b',owner:'grok',kind:'debug',dependsOn:['a'],instructions:'Inspect',acceptanceCriteria:['Reviewed']}];
  assert.throws(()=>validatePlan(orderDebugTasks({spec:'debug',tasks},{team}),{team}),/순환|의존/);
});
async function fixture(t){const base=await mkdtemp(join(tmpdir(),'cw-order-'));t.after(()=>rm(base,{recursive:true,force:true,maxRetries:8,retryDelay:100}));
  const root=join(base,'app');await mkdir(root);const store=new Store(join(base,'data'),{});await store.init();const projects=new Projects(store),id=(await projects.list()).activeId,workspace=new Workspace(projects);
  const ticket=await workspace.prepare(id,root);await workspace.consent(id,ticket.ticket,true);return{root,id,workspace};}
for(const count of [2,4])test(`${count} panel workflow repairs a real failing Node test, then hands results through ordered reviewers and controller`,async t=>{
  const f=await fixture(t),team=resizeTeam(defaultTeam(),count);if(count===4)team[3].provider='gemini';
  const calls=[],contexts=[];let featureBuilds=0,active=0,maxActive=0;
  const provider={ready:async()=>true,plan:async()=>reviewFixturePlan(team),build:async context=>reviewFixtureBuild(context,context.task.kind==='feature'&&++featureBuilds===1),
    review:async context=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,8));active--;
      calls.push(context.options.agentId);contexts.push(context);
      return {actor:'untrusted-model-actor',summary:context.validation.passed?'Independent review OK':'Filtering assertion failed',issues:context.validation.passed?[]:[{taskId:'logic',owner:team.find(agent=>agent.roles.includes('feature')).id,file:'filter.cjs',description:'Filter by the selected status; keep original tests.'}]};}};
  const engine=new Workflow(f.workspace,roleProviders(Object.fromEntries(['gpt','grok','claude','gemini'].map(id=>[id,provider]))),()=>{},context=>validateProject(f.workspace,context));
  await engine.start(f.id,{request:'Filter board',team,funContract:true,maxRepairRounds:2,maxAgentCalls:40,allowExecution:true,executionBackend:'host'});
  await engine.runs.get(f.id).promise;const state=await engine.current(f.id);
  assert.equal(state.status,'completed',state.events.at(-1)?.message);assert.equal(state.round,1);assert.equal(featureBuilds,2);assert.equal(maxActive,1);
  const ordered=reviewOrder({team}).map(agent=>agent.id);assert.deepEqual(calls,[ordered[0],...ordered]);
  assert.deepEqual(state.reviews.map(row=>row.actor),ordered,'Review identity must come from the host, not model metadata');
  const last=contexts.at(-1);assert.equal(last.options.agentId,'gpt');assert.equal(last.priorReviews.length,count-1);
  assert.equal(last.validation.cases.filter(row=>row.status==='passed').length,4);assert.match(last.validation.command,/node.*--test/);
  assert.equal(last.priorReviews.every(row=>row.snapshotHash===state.snapshotHash),true);
  assert.equal(state.reviewChain.every(step=>step.status==='passed'),true);
  assert.equal((await readFile(join(f.root,'tests/filter.test.cjs'),'utf8')).includes("assert.equal(render(data,'open'),'Alpha')"),true);
  if(count===2){
    engine.validate=async()=>({configured:true,passed:false,summary:'Fresh revalidation failed',output:'Runner unavailable'});
    await engine.revalidate(f.id,state.id,{allowExecution:true});await engine.runs.get(f.id).promise;
    const stale=await engine.current(f.id);assert.notEqual(stale.status,'completed');assert.deepEqual(stale.reviewChain,[]);
  }
});
test('debug code-change tasks execute in provider order and receive preceding reports without overlapping',async t=>{
  const f=await fixture(t),team=resizeTeam(defaultTeam(),4);team[3].provider='gemini';
  const order=[],previous=[];let active=0,maxActive=0;
  const plan={spec:'Debug workflow',tasks:team.map(agent=>({id:'d-'+agent.id,owner:agent.id,kind:'debug',instructions:'Record diagnostic result',dependsOn:[],acceptanceCriteria:['Result recorded']}))};
  // The project already exists: this probe isolates actual debug task scheduling.
  const provider={ready:async()=>true,plan:async()=>structuredClone(plan),build:async context=>{
    active++;maxActive=Math.max(active,maxActive);await new Promise(resolve=>setTimeout(resolve,6));active--;
    order.push(context.options.agentId);previous.push(context.previousTaskReports.filter(row=>row.kind==='debug').length);
    return{summary:context.task.id,files:[{path:context.task.id+'.txt',content:'diagnosed'}]};},review:async()=>({summary:'OK',issues:[]})};
  const engine=new Workflow(f.workspace,roleProviders(Object.fromEntries(['gpt','grok','claude','gemini'].map(id=>[id,provider]))),()=>{},async()=>({configured:true,passed:true}));
  await engine.start(f.id,{request:'Debug',team,maxRepairRounds:0});await engine.runs.get(f.id).promise;
  assert.equal((await engine.current(f.id)).status,'completed');assert.deepEqual(order,['grok','reviewer','claude','gpt']);assert.deepEqual(previous,[0,1,2,3]);assert.equal(maxActive,1);
});
