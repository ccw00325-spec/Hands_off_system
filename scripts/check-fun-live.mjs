// Opt-in: uses the current OS user's Codex login and consumes real account quota.
// Planning only. No worker code, package installation or project execution is allowed.
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { Projects } from '../src/core/projects.js';
import { Workspace } from '../src/core/workspace.js';
import { Workflow } from '../src/core/workflow.js';
import { GPTProvider } from '../src/core/providers.js';
import { CodexConnection } from '../src/core/codex.js';
import { roleProviders } from '../src/core/roles.js';
import { CallQuota } from '../src/core/call-quota.js';
const parent=resolve('artifacts'),base=join(parent,'fun-live-'+randomUUID()),root=join(base,'project');
await mkdir(root,{recursive:true});const store=new Store(join(base,'data'),{});await store.init();
const native=new CodexConnection(join(base,'sessions'));
const report={passed:false,planningCalls:0,workerCalls:0,deleted:false,paidInference:true};let engine,id,timer;
try {
  if(!(await native.status()).connected) throw new Error('Codex 로그인 필요: 실제 검사는 수행하지 않았습니다.');
  const projects=new Projects(store),workspace=new Workspace(projects);id=(await projects.list()).activeId;
  const ticket=await workspace.prepare(id,root);await workspace.consent(id,ticket.ticket,true);
  const provider=new GPTProvider(null,resolve('src/skills/fun.md'),native),plan=provider.plan.bind(provider);
  provider.plan=async context=>{report.planningCalls++;return plan(context);};
  provider.build=async()=>{report.workerCalls++;throw new Error('Planning-only probe must not invoke implementation.');};
  engine=new Workflow(workspace,roleProviders({gpt:provider}));engine.quota=new CallQuota(store);
  timer=setTimeout(()=>engine.stop(id),120000);
  await engine.start(id,{request:'여러 사람이 쓰는 자료 관리 앱을 만들어줘.',conversationId:'live-planning-probe',
    team:[{id:'gpt',provider:'gpt',roles:['control','debug']},{id:'grok',provider:'gpt',roles:['feature','ui']}],
    funEnabled:true,funContract:true,unattended:false,maxRepairRounds:0,maxAgentCalls:2,maxDailyCalls:2,gptSource:'codex',designApproval:false,allowExecution:false});
  await engine.runs.get(id).promise;
  const state=await engine.current(id);report.status=state.status;report.questions=state.questions;report.skillHash=state.governance?.sha256;
  report.error=state.status!=='needs_input'?state.events.at(-1)?.message:undefined;
  assert.equal(state.status,'needs_input');assert.equal(state.tasks.length,0);assert.equal(report.workerCalls,0);assert.ok(state.questions.length>0);
  report.passed=true;
} catch(error) {report.error=error.message;}
finally {
  clearTimeout(timer);engine?.stopAll();native.close();
  const actual=await realpath(base).catch(()=>null);if(actual===base&&actual.startsWith(join(parent,'fun-live-'))){await rm(actual,{recursive:true,force:true,maxRetries:12,retryDelay:150});report.deleted=true;}
  await writeFile(join(parent,'fun-live-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
if(!report.passed)process.exitCode=1;
