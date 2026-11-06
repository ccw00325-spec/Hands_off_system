import test from 'node:test';
import assert from 'node:assert/strict';
import { CallQuota, reserveTextCost } from '../src/core/call-quota.js';
import { stateHandoff } from '../src/core/handoff.js';
import { layoutPreview } from '../src/core/layout-preview.js';
import { Prerequisites, INSTALL_SITES } from '../src/core/prerequisites.js';
import { toolRoots, nativeToolPath } from '../src/core/tool-paths.js';
import { dockerArgs, validateInDocker } from '../src/core/docker-execution.js';
import { macLoginScript } from '../src/core/mac-terminal.js';
import { DEFAULT_PREFERENCES } from '../src/core/preferences.js';
import { GPTProvider } from '../src/core/providers.js';
import { officialExternalURL } from '../src/core/browser.js';
import { Workflow } from '../src/core/workflow.js';
import { resolve } from 'node:path';

const memory = () => { let value = null; return {read:async()=>structuredClone(value), write:async(_key,next)=>{await new Promise(r=>setTimeout(r,1));value=structuredClone(next);}}; };
test('daily admission is atomic across concurrent projects and persists across ledger instances', async () => {
  const store = memory(), quota = new CallQuota(store), options = {maxDailyCalls:5,maxAgentCalls:10};
  const result = await Promise.allSettled(Array.from({length:20},(_,i)=>quota.admit({runId:'project-'+i,options})));
  assert.equal(result.filter(row=>row.status==='fulfilled').length,5);
  await assert.rejects(new CallQuota(store).admit({runId:'new',options}),/호출 한도/);
  assert.equal((await quota.snapshot()).calls,5);
});
test('parallel API reservations cannot each spend the same remaining budget', async () => {
  const quota = new CallQuota(memory()), options = {maxDailyCalls:10,maxAgentCalls:10,dailyApiBudgetUsd:1};
  const tickets = await Promise.all([quota.admit({runId:'a',options}),quota.admit({runId:'b',options})]);
  const result = await Promise.allSettled(tickets.map(ticket=>quota.reserve(ticket,.7,options)));
  assert.equal(result.filter(row=>row.status==='fulfilled').length,1);
  assert.equal((await quota.snapshot()).reservedOrSpentUsd,.7);
  const successful = result.findIndex(row=>row.status==='fulfilled');
  await quota.settle(tickets[successful],undefined);
  assert.equal((await quota.snapshot()).reservedOrSpentUsd,.7);
});
test('daily settings apply to already-running callers and newly enabled unpriced budgets fail closed', async () => {
  const data=new Map(), store={read:async name=>structuredClone(data.get(name)??{}),write:async(name,value)=>data.set(name,structuredClone(value))};
  const quota=new CallQuota(store), frozen={maxDailyCalls:10,maxAgentCalls:10,dailyApiBudgetUsd:0};
  const ticket=await quota.admit({runId:'running',options:frozen});
  data.set('preferences',{maxDailyCalls:1,dailyApiBudgetUsd:1});
  await assert.rejects(quota.admit({runId:'running',options:frozen}),/호출 한도/);
  await assert.rejects(quota.reserve(ticket,null,frozen),/예약 비용/);
  data.set('preferences',{maxDailyCalls:10,dailyApiBudgetUsd:.1});
  await assert.rejects(quota.reserve(ticket,.2,frozen),/예약 비용/);
});
test('actual usage refunds unused reservation while new-day counters start fresh', async () => {
  let date = new Date('2026-11-06T12:00:00Z');
  const quota = new CallQuota(memory(),()=>date), options = {maxDailyCalls:5,maxAgentCalls:5,apiBudgetUsd:1};
  const ticket = await quota.admit({runId:'a',options,reserveUsd:.8});
  await quota.settle(ticket,.2); assert.ok(Math.abs((await quota.snapshot()).reservedOrSpentUsd-.2)<1e-8);
  date = new Date('2026-11-07T00:00:00Z'); assert.equal((await quota.snapshot()).calls,0);
});
test('image quota blocks before a second image is admitted', async () => {
  const quota = new CallQuota(memory()), options = {maxImageCallsPerDay:1,maxDailyCalls:5,maxAgentCalls:5};
  await quota.admit({runId:'image',options,image:true});
  await assert.rejects(quota.admit({runId:'image',options,image:true}),/이미지 생성 횟수/);
});
test('API reservation requires a matching priced text model and caps output tokens', () => {
  const options = {apiBudgetUsd:1,gptModel:'model',apiRateModel:'model',apiInputRate:1,apiOutputRate:2,maxOutputTokens:1024};
  assert.ok(reserveTextCost('hello',{message:'world'},options) > .002);
  assert.throws(()=>reserveTextCost('x',{designImage:'base64'},options),/이미지 입력/);
  assert.throws(()=>reserveTextCost('x',{}, {...options,gptModel:'other'}),/현재 텍스트 모델/);
});
test('the real GPT adapter reserves before fetch and sends the configured output ceiling', async t => {
  const events=[], original=globalThis.fetch;let body;
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async (_url,request)=>{
    events.push('fetch');body=JSON.parse(request.body);
    return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'{"reply":"ok"}'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:8,output_tokens:4}}})+'\n\n');
  };
  const provider=new GPTProvider({access:async()=> 'test-only-token'});
  const result=await provider.ask('Instructions',{message:'Question'},{gptSource:'api',gptModel:'priced',apiRateModel:'priced',apiBudgetUsd:1,apiInputRate:1,apiOutputRate:2,maxOutputTokens:1024,onApiReservation:async amount=>{assert.ok(amount>0);events.push('reserve');}},new AbortController().signal);
  assert.equal(result.reply,'ok');assert.deepEqual(events,['reserve','fetch']);assert.equal(body.max_output_tokens,1024);
});
test('handoff preserves file hashes, criteria, reports and unresolved findings without private reasoning', () => {
  const state = {id:'run',request:'Build app',spec:'v1',options:{conversationHistory:[{role:'user',content:'Keep compact'}]},tasks:[{id:'done',status:'reported',report:{summary:'Implemented'}}],events:[{actor:'gpt',message:'T1 failed'}],validation:{passed:false,summary:'T1 failed'}};
  const handoff = stateHandoff(state,'grok','build',{task:{id:'t1',owner:'grok',acceptanceCriteria:['T1 passes']},snapshot:{hash:'baseline',files:[{path:'a.js',hash:'a1',content:'not copied'}]},issues:[{description:'Fix boundary'}]});
  assert.equal(handoff.source.hash,'baseline'); assert.equal(handoff.completedTasks[0].summary,'Implemented');
  assert.deepEqual(handoff.task.criteria,['T1 passes']); assert.equal(handoff.source.files[0].content,undefined); assert.match(handoff.constraint,/not vendor session/);
});
test('recreated runs cannot overwrite or collide with an earlier factual handoff', async () => {
  const files=new Set(), workspace={write:async(_id,path)=>{assert.ok(!files.has(path),'handoffs must not collide after run reconstruction');files.add(path);}};
  const provider={chat:async()=>({reply:'ok'})}, workflow=new Workflow(workspace,{gpt:provider});
  const make=()=>({state:{id:'00000000-0000-0000-0000-000000000001',projectId:'p',grantId:'g',options:{maxAgentCalls:10},events:[],tasks:[]}});
  const run=make(), context={message:'Progress?',snapshot:{root:'.',files:[]},options:run.state.options,signal:new AbortController().signal};
  await workflow.callAgent(run,'gpt','chat',context);
  const reconstructed=make();await workflow.callAgent(reconstructed,'gpt','chat',{...context,options:reconstructed.state.options});
  assert.equal(files.size,2);
});
test('revalidation of a legacy host session uses the current Docker execution boundary', async () => {
  let backend;
  const state={id:'run',projectId:'p',grantId:'g',snapshotHash:'same',options:{executionBackend:'host'},testing:{plan:{}},reviews:[],ownership:{}};
  const workflow=new Workflow({snapshot:async()=>({hash:'same'})},{},()=>{},async context=>{backend=context.options.executionBackend;return{configured:true,passed:false,requiresSetup:true,summary:'Docker required'};});
  workflow.current=async()=>state;workflow.record=async()=>{};workflow.testingResult=async()=>{};
  await workflow.revalidate('p','run',{allowExecution:true,executionBackend:'docker',dockerImage:'node:24-bookworm-slim'});
  await workflow.runs.get('p').promise;
  assert.equal(backend,'docker');assert.equal(state.options.dockerImage,'node:24-bookworm-slim');
});
test('default UI is a text structure and mutation is opt-in; no API is needed to revise layout', () => {
  assert.equal(DEFAULT_PREFERENCES.designMode,'layout'); assert.equal(DEFAULT_PREFERENCES.executionBackend,'docker'); assert.equal(DEFAULT_PREFERENCES.mutationByDefault,false);
  const preview = layoutPreview('Timer',{screens:[{name:'Focus'}]},['Make digits larger']);
  assert.match(preview,/Focus/);assert.match(preview,/Make digits larger/);assert.match(preview,/이미지 API 호출 없음/);
});
test('missing optional AI CLIs do not require installing all providers', async () => {
  const check = new Prerequisites({find:async name=>name==='git'?'git':null,node:async()=>null,probe:async()=>({code:0,output:'git version 2.50.0'})});
  const result = await check.scan({gpt:{installed:true}}, {providers:['gpt'],executionBackend:'host'});
  assert.equal(result.rows.find(row=>row.id==='claude').required,false);
  assert.equal(result.rows.find(row=>row.id==='node').state,'missing');
  assert.equal(result.rows.find(row=>row.id==='git').required,false);
  assert.equal(result.rows.find(row=>row.id==='docker').required,false);
  assert.match(result.rows.find(row=>row.id==='git').purpose,/GitHub.*백업/);
  const isolated = await check.scan({gpt:{installed:true}}, {providers:['gpt'],executionBackend:'docker'});
  assert.equal(isolated.rows.find(row=>row.id==='docker').required,true);
  assert.match(isolated.rows.find(row=>row.id==='docker').purpose,/현재 Docker.*필수/);
  assert.ok(Object.values(INSTALL_SITES).every(url=>new URL(url).protocol==='https:'));
  for(const url of Object.values(INSTALL_SITES))assert.equal(officialExternalURL(url),url);
  assert.throws(()=>officialExternalURL('https://nodejs.org.attacker.example/download'));
});
test('macOS Finder paths include Homebrew and the native user CLI location', async () => {
  const paths = await toolRoots('agent',{platform:'darwin',env:{PATH:''},home:'/Users/fixture'});
  assert.ok(paths.includes('/opt/homebrew/bin'));assert.ok(paths.includes('/usr/local/bin'));assert.ok(paths.includes('/Users/fixture/.local/bin'));
  const environment = nativeToolPath({PATH:'/usr/bin:/bin'},'darwin','/Users/fixture');
  assert.ok(environment.includes('/opt/homebrew/bin'));assert.ok(environment.includes('/usr/local/bin'));
});
test('Docker receives only a read-only sanitized input mount and strict resource/network restrictions', () => {
  const args = dockerArgs({name:'cw-test-00000000-0000-0000-0000-000000000000',image:'node:24-bookworm-slim',input:resolve('artifacts/input'),command:['node','--test']});
  for (const flag of ['--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=1g','--pids-limit=128']) assert.ok(args.includes(flag));
  assert.equal(args.filter(arg=>arg==='--mount').length,1);assert.ok(args.some(arg=>arg.endsWith('dst=/input,readonly')));
  assert.ok(!args.includes('--privileged'));assert.ok(!args.some(arg=>arg.includes('docker.sock')));
});
test('unavailable Docker and remote Docker contexts never fall back to host execution', async () => {
  const context = {options:{executionBackend:'docker'}};
  const missing = await validateInDocker({},context,{find:async()=>null});assert.equal(missing.passed,false);assert.equal(missing.requiresSetup,true);
  const remote = await validateInDocker({},context,{find:async()=>'/docker',exec:async()=>({stdout:'ssh://remote'})});assert.equal(remote.passed,false);assert.match(remote.summary,/로컬 Docker/);
});
test('Mac terminal login arguments quote shell metacharacters rather than interpolating commands', () => {
  const result = macLoginScript([resolve('official cli')],['login',"a'$(touch ignored)"]);
  assert.match(result.at(-1),/do script/);assert.ok(result.at(-1).includes("'\\\\''"));
  assert.throws(()=>macLoginScript(['relative'],['login']),/공식 로그인/);
});
