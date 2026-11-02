import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { Projects } from '../src/core/projects.js';
import { Workspace } from '../src/core/workspace.js';
import { Workflow, validatePlan, validateReview } from '../src/core/workflow.js';
import { readResponseStream } from '../src/core/providers.js';

async function fixture(t, overrides = {}) {
  const base = await mkdtemp(join(tmpdir(), 'tower-loop-')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'); await mkdir(root);
  const store = new Store(join(base, 'data'), {}); await store.init();
  const projects = new Projects(store); const id = (await projects.list()).activeId;
  const workspace = new Workspace(projects); const pending = await workspace.prepare(id, root); await workspace.consent(id, pending.ticket, true);
  const calls = [], reviewHashes = [];
  const providers = {
    gpt: { ready: async () => true, plan: async () => ({ spec: '# Approved timer spec', questions: [], tasks: [
      { id:'feature', title:'Timer logic', owner:'grok', instructions:'timer', dependsOn:[], acceptanceCriteria:['timer works'] },
      { id:'layout', title:'Timer UI', owner:'claude', instructions:'layout', dependsOn:[], acceptanceCriteria:['UI works'] },
      { id:'connect', title:'Connect timer', owner:'claude', instructions:'integrate', dependsOn:['feature','layout'], acceptanceCriteria:['binding works'] }
    ] }), review: async context => { reviewHashes.push(context.snapshot.hash); return { summary:'GPT checked supplied files', issues:[] }; } },
    grok: { ready: async () => true, build: async context => { calls.push({ task:context.task.id, issues:context.issues }); return { summary:'feature implemented', files:[{ path:'timer.js', content:`export const timer = ${calls.filter(call=>call.task==='feature').length};` }] }; }, review: async context => { reviewHashes.push(context.snapshot.hash); return { summary:'Grok review', issues:[] }; } },
    claude: { ready: async () => true, build: async context => { calls.push({ task:context.task.id, issues:context.issues }); return { summary:'UI connected', files:[{ path:context.task.id==='layout'?'index.html':'app.js', content:context.task.id==='layout'?'<main>Timer</main>':`import {timer} from './timer.js';` }] }; }, review: async context => { reviewHashes.push(context.snapshot.hash); return { summary:'Claude review', issues:[] }; } }
  };
  const workflow = new Workflow(workspace, providers, () => {}, overrides.validate ?? (async () => ({ configured:true, passed:true, summary:'Test fixture validation' })));
  return { base, root, workspace, id, providers, workflow, calls, reviewHashes };
}
const options = { request:'Build a timer app', maxRepairRounds:2, gptModel:'test-fixture-model' };
test('worker completion reports reach GPT; repair goes to its original owner and dependent integration reruns', async t => {
  const f = await fixture(t); let count = 0;
  f.providers.gpt.review = async context => {
    f.reviewHashes.push(context.snapshot.hash); count++;
    return { summary:'Controller review', issues:count===1?[{ taskId:'feature', owner:'grok', description:'Fix the timer boundary condition', file:'timer.js' }]:[] };
  };
  await f.workflow.start(f.id, options); await f.workflow.runs.get(f.id).promise;
  const state = await f.workflow.current(f.id);
  assert.equal(state.status,'completed'); assert.equal(state.round,1);
  assert.equal(f.calls.filter(call=>call.task==='feature').length,2);
  assert.equal(f.calls.filter(call=>call.task==='connect').length,2);
  assert.equal(f.calls.filter(call=>call.task==='layout').length,1);
  assert.match(f.calls.filter(call=>call.task==='feature')[1].issues[0].description,/boundary/);
  assert.ok(state.events.some(event=>event.actor==='grok' && event.message.includes('GPT에 완료 보고')));
  assert.equal(new Set(f.reviewHashes.slice(-3)).size,1);
  assert.equal(await readFile(join(f.root,'timer.js'),'utf8'),'export const timer = 2;');
  assert.ok((await readFile(join(f.root,'.control-tower','runs',state.id,'state.json'),'utf8')).includes('completed'));
});
test('missing execution validation never becomes whole-project completion', async t => {
  const f = await fixture(t,{ validate:async()=>({ configured:false,passed:false }) });
  await f.workflow.start(f.id, options); await f.workflow.runs.get(f.id).promise;
  assert.equal((await f.workflow.current(f.id)).status,'awaiting_validation');
});
test('recurring findings stop at the user-specified repair limit', async t => {
  const f = await fixture(t);
  f.providers.gpt.review = async()=>({ summary:'Still has a bug',issues:[{ taskId:'feature',owner:'grok',description:'Same remaining bug' }] });
  await f.workflow.start(f.id,{ ...options,maxRepairRounds:1 }); await f.workflow.runs.get(f.id).promise;
  const state = await f.workflow.current(f.id); assert.equal(state.status,'needs_attention'); assert.equal(state.round,1);
  assert.equal(f.calls.filter(call=>call.task==='feature').length,2);
});
test('planner questions pause before dispatching or writing application code', async t => {
  const f = await fixture(t); f.providers.gpt.plan = async()=>({ questions:['어떤 타이머 동작이 필요한가요?'] });
  await f.workflow.start(f.id,options); await f.workflow.runs.get(f.id).promise;
  assert.equal((await f.workflow.current(f.id)).status,'needs_input'); assert.equal(f.calls.length,0);
  await assert.rejects(readFile(join(f.root,'timer.js')),{ code:'ENOENT' });
});
test('provider unavailability fails before any model work or output', async t => {
  const f = await fixture(t); f.providers.grok.ready = async()=>false;
  await assert.rejects(f.workflow.start(f.id,options),/GROK/); assert.equal(f.calls.length,0);
});
test('completion claims cannot reassign a defect to a different agent', () => {
  assert.throws(()=>validateReview({ summary:'bad owner',issues:[{ taskId:'a',owner:'claude',description:'wrong' }] },[{ id:'a',owner:'grok' }]));
  assert.throws(()=>validatePlan({ spec:'s',tasks:[{ id:'a',owner:'grok',instructions:'x',dependsOn:['b'],acceptanceCriteria:['x'] }] }));
  assert.throws(()=>validateReview({ summary:'bad task',issues:[{ taskId:'b',owner:'claude',file:'timer.js',description:'wrong file owner' }] },[{ id:'a',owner:'grok' },{ id:'b',owner:'claude' }],{ 'timer.js':{ taskId:'a',owner:'grok' } }));
});
test('edits during validation invalidate an otherwise successful execution result',async t=>{
  const f=await fixture(t);
  f.workflow.validate=async()=>{ await f.workspace.write(f.id,'external.js','export const external = true;'); return { configured:true,passed:true }; };
  await f.workflow.start(f.id,options); await f.workflow.runs.get(f.id).promise;
  const state=await f.workflow.current(f.id); assert.equal(state.status,'awaiting_validation'); assert.equal(state.validation.passed,false);
});
test('edits during a read-only review prevent whole-project completion',async t=>{
  const f=await fixture(t); let edited=false;
  f.providers.gpt.review=async()=>{ if(!edited){ edited=true; await f.workspace.write(f.id,'outside-edit.js','export const changed = true;'); } return { summary:'Review report',issues:[] }; };
  await f.workflow.start(f.id,options); await f.workflow.runs.get(f.id).promise;
  const state=await f.workflow.current(f.id); assert.equal(state.status,'needs_attention');
  assert.ok(state.events.some(event=>event.message.includes('검토 중 파일이 변경')));
});
test('worker failure is reported as attention needed and cannot overwrite control metadata',async t=>{
  const f=await fixture(t);
  f.providers.grok.build=async()=>({ summary:'invalid output',files:[{ path:'.Control-Tower/attack.json',content:'{}' }] });
  await f.workflow.start(f.id,options); await f.workflow.runs.get(f.id).promise;
  assert.equal((await f.workflow.current(f.id)).status,'needs_attention');
});
test('Responses streaming requires a terminal completion and handles split SSE frames', async () => {
  const encoder = new TextEncoder();
  const raw = 'data: {"type":"response.output_text.delta","delta":"hello"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n';
  const body = new ReadableStream({ start(controller) { for (const part of [raw.slice(0,12),raw.slice(12,70),raw.slice(70)]) controller.enqueue(encoder.encode(part)); controller.close(); } });
  assert.equal(await readResponseStream(new Response(body)), 'hello');
  await assert.rejects(readResponseStream(new Response('data: {"type":"response.output_text.delta","delta":"incomplete"}\n\n')),/완료 이벤트/);
  await assert.rejects(readResponseStream(new Response('data: {"type":"response.failed"}\n\n')),/불완전/);
});
