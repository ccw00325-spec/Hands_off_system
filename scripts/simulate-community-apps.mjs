import { mkdir, readFile, writeFile, realpath, rm, access, readdir } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { Store } from '../src/core/store.js';
import { Projects } from '../src/core/projects.js';
import { Workspace } from '../src/core/workspace.js';
import { Workflow } from '../src/core/workflow.js';
import { GPTProvider } from '../src/core/providers.js';
import { roleProviders } from '../src/core/roles.js';
import { CodexConnection } from '../src/core/codex.js';
import { projectEnvironment } from '../src/core/child-env.js';
import { communityApps } from './community-app-specs.mjs';
import { validationResult } from '../src/core/validation-result.js';

const parent = resolve('artifacts/community-apps'); await mkdir(parent, { recursive:true });
const selected = process.argv.find(arg=>arg.startsWith('--case='))?.slice(7);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function runNode(root, file, authored = false) {
  return new Promise(resolveResult => {
    const args = ['--permission', `--allow-fs-read=${root}`, ...(authored ? ['--test-isolation=none','--test','--test-reporter=tap'] : []), file];
    const child=spawn(process.execPath,args,{cwd:root,env:projectEnvironment(),windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',settled=false;
    const finish = result => { if(settled)return;settled=true;clearTimeout(timer);resolveResult({...result,output}); };
    const timer=setTimeout(()=>{child.kill();finish({passed:false,exitCode:null});},20000);
    child.stdout.on('data',chunk=>{output+=chunk; if(output.length>100000){child.kill();finish({passed:false,exitCode:null});}});
    child.stderr.on('data',chunk=>{output+=chunk;});
    child.once('error',error=>finish({passed:false,exitCode:null,summary:error.message}));
    child.once('close',exitCode=>finish({passed:exitCode===0,exitCode}));
  });
}
async function browserCheck(app,root,profile) {
  const results=[],errors=[]; let application,page;
  const server=createServer(async(req,res)=>{
    try {
      const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html';
      if(!['index.html','app.js','styles.css','core.cjs'].includes(path)){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type',extname(path)==='.css'?'text/css; charset=utf-8':/\.(?:cjs|js)$/.test(path)?'application/javascript; charset=utf-8':'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'");
      res.end(await readFile(join(root,path)));
    } catch {res.writeHead(404);res.end();}
  });
  await new Promise(resolveReady=>server.listen(0,'127.0.0.1',resolveReady));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const entry=join(profile,'ui-host.cjs');
  await writeFile(entry,`const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(profile,'browser'))});app.whenReady().then(()=>{session.defaultSession.setPermissionRequestHandler((_w,_p,cb)=>cb(false));session.defaultSession.webRequest.onBeforeRequest({urls:['*://*/*']},(r,cb)=>cb({cancel:!r.url.startsWith(${JSON.stringify(origin+'/')})}));session.defaultSession.on('will-download',event=>event.preventDefault());const w=new BrowserWindow({show:false,skipTaskbar:true,width:1440,height:1000,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(${JSON.stringify(origin+'/')}))event.preventDefault();});w.loadURL(${JSON.stringify(origin)});});`);
  try {
    const env=projectEnvironment();delete env.ELECTRON_RUN_AS_NODE;
    application=await electron.launch({args:[entry],cwd:root,env});
    page=await application.firstWindow();page.setDefaultTimeout(12000);
    page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    await page.addInitScript(()=>{const original=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{if(blob instanceof Blob)void blob.text().then(text=>window.__exportedCSV=text);return original(blob);};});
    await page.evaluate(()=>localStorage.clear());await page.reload();await page.locator('#entry-form').waitFor();
    const fill=async values=>{for(const [id,value]of Object.entries(values)){const field=page.locator('#'+id);if(await field.evaluate(el=>el.tagName==='SELECT'))await field.selectOption(value);else await field.fill(String(value));}};
    const save=async values=>{await fill(values);await page.locator('#save').click();};
    const count=async number=>{await page.waitForFunction(n=>document.querySelectorAll('#rows [data-id]').length===n,number);};
    const row=name=>page.locator('#rows [data-id]').filter({hasText:name}).first();
    const numberText=async selector=>(await page.locator(selector).innerText()).replaceAll(',','').replaceAll('₩','');
    if(app.id==='expense') {
      await page.locator('#month').fill('2026-11');
      await save({title:'커피',amount:4500,date:'2026-11-07',category:'food'});await count(1);
      await save({title:'교통카드',amount:1500,date:'2026-11-07',category:'transport'});await count(2);
      assert.match(await numberText('#total'),/6000/);results.push('UI1 지출 생성과 합계');
      await row('커피').locator('[data-action=edit]').click();await save({amount:5000});await count(2);assert.match(await numberText('#total'),/6500/);
      await fill({'budget-input':6000});await page.locator('#save-budget').click();assert.match(await numberText('#budget-remaining'),/(?:-500|500\s*(?:원\s*)?초과)/);results.push('UI2 수정과 예산 초과');
      await page.locator('#category-filter').selectOption('transport');await count(1);await page.locator('#search').fill('커피');await count(0);
      await page.locator('#category-filter').selectOption('');await page.locator('#search').fill('');await count(2);results.push('UI3 복합 필터와 빈 결과');
      await save({title:'잘못된 금액',amount:0,date:'2026-11-07',category:'food'});await count(2);
      assert.ok(await page.locator('#amount').evaluate(el=>!el.checkValidity()) || (await page.locator('#error').innerText()).trim());results.push('UI4 입력 오류');
      await row('교통카드').locator('[data-action=delete]').click();await count(1);await page.reload();await page.locator('#month').fill('2026-11');await count(1);assert.match(await numberText('#total'),/5000/);results.push('UI5 삭제와 새로고침 복원');
      await page.locator('#export').click();await page.waitForFunction(()=>window.__exportedCSV?.includes('커피'));assert.match(await page.evaluate(()=>window.__exportedCSV),/5000/);results.push('UI6 실제 CSV 내용');
      await save({title:'업무용 도서',amount:28000,date:'2026-11-06',category:'shopping'});await save({title:'작업실 장보기',amount:18500,date:'2026-11-05',category:'food'});
    } else if(app.id==='habit') {
      await page.locator('#date').fill('2026-11-07');await save({name:'20분 독서'});await save({name:'점심 산책'});await count(2);
      await row('20분 독서').locator('[data-action=toggle]').click();assert.match(await page.locator('#summary').innerText(),/1\s*[/／]\s*2/);results.push('UI1 습관 생성과 오늘 체크');
      await row('20분 독서').locator('[data-action=edit]').click();await save({name:'매일 20분 독서'});await count(2);assert.match(await page.locator('#summary').innerText(),/1\s*[/／]\s*2/);results.push('UI2 이름 수정 시 체크 보존');
      await page.locator('#date').fill('2026-11-06');await row('매일 20분 독서').locator('[data-action=toggle]').click();await page.locator('#date').fill('2026-11-07');assert.match(await row('매일 20분 독서').innerText(),/2\s*일/);results.push('UI3 날짜별 기록과 연속 달성');
      await page.locator('#search').fill('없는 습관');await count(0);assert.match(await page.locator('#summary').innerText(),/1\s*[/／]\s*2/);await page.locator('#search').fill('');results.push('UI4 검색과 전체 진행률');
      await row('점심 산책').locator('[data-action=delete]').click();await count(1);await page.reload();await page.locator('#date').fill('2026-11-07');await count(1);assert.match(await page.locator('#summary').innerText(),/1\s*[/／]\s*1/);results.push('UI5 삭제와 새로고침 복원');
      await save({name:'가벼운 스트레칭'});await save({name:'하루 한 줄 회고'});
    } else {
      await save({name:'미라 스튜디오',email:'mira@example.test',status:'new',value:100000,notes:'첫 상담'});await save({name:'노아 디자인',email:'noah@example.test',status:'won',value:200000,notes:'계약 완료'});await count(2);assert.match(await numberText('#summary'),/200000/);results.push('UI1 고객 생성과 수주 합계');
      await row('미라 스튜디오').locator('[data-action=edit]').click();await save({status:'proposal',notes:'다음 주 미팅'});await count(2);await page.locator('#status-filter').selectOption('proposal');await count(1);await page.locator('#search').fill('미팅');await count(1);results.push('UI2 단계·메모 수정과 복합 검색');
      await page.locator('#status-filter').selectOption('');await page.locator('#search').fill('');await row('미라 스튜디오').locator('[data-action=edit]').click();await save({status:'won'});assert.match(await numberText('#summary'),/300000/);results.push('UI3 수주 전환과 대시보드');
      await save({name:'중복 고객',email:'MIRA@example.test',status:'new',value:1,notes:''});await count(2);assert.ok((await page.locator('#error').innerText()).trim());results.push('UI4 중복 이메일 거부');
      await row('노아 디자인').locator('[data-action=delete]').click();await count(1);await page.reload();await count(1);assert.match(await row('미라 스튜디오').innerText(),/미라/);results.push('UI5 삭제와 새로고침 복원');
      const unsafe='<img src=x onerror=alert(1)>';await save({name:unsafe,email:'safe@example.test',status:'new',value:0,notes:''});await count(2);assert.equal(await page.locator('#rows img').count(),0);assert.ok((await page.locator('#rows').innerText()).includes(unsafe));await row(unsafe).locator('[data-action=delete]').click();results.push('UI6 사용자 입력을 HTML로 실행하지 않음');
      await save({name:'라이트웍스',email:'light@example.test',status:'proposal',value:480000,notes:'랜딩 페이지 제안서 검토 중'});
    }
    assert.deepEqual(errors,[]);results.push('브라우저 실행 오류 없음');
    await page.screenshot({path:join(parent,app.id+'-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.screenshot({path:join(parent,app.id+'-mobile.png'),fullPage:true});results.push('모바일 가로 넘침 없음');
    return {passed:true,checks:results,screenshots:[app.id+'-desktop.png',app.id+'-mobile.png']};
  } catch(error) {
    const screenshot=app.id+'-failure.png';
    const captured=await page?.screenshot({path:join(parent,screenshot),fullPage:true}).then(()=>true,()=>false);
    return {passed:false,checks:results,error:error.message,screenshots:captured?[screenshot]:[]};
  }
  finally { await application?.close().catch(()=>{});await new Promise(resolveClosed=>server.close(resolveClosed)); }
}

for(const app of communityApps.filter(item=>!selected||item.id===selected)) {
  const id=randomUUID(),root=join(parent,`${app.id}-app-${id}`),data=join(parent,`${app.id}-profile-${id}`);
  await mkdir(root);await mkdir(data);await writeFile(join(root,'.simulation-owned'),id);await writeFile(join(data,'.simulation-owned'),id);
  await writeFile(join(root,'host-checks.cjs'),app.checks);const trustedHash=hash(app.checks);
  const store=new Store(data,{});await store.init();const projects=new Projects(store),projectId=(await projects.list()).activeId,workspace=new Workspace(projects);
  const ticket=await workspace.prepare(projectId,root);await workspace.consent(projectId,ticket.ticket,true);
  const native=new CodexConnection(data),calls=[],validations=[];const report={id:app.id,title:app.title,idea:app.idea,provider:'real Codex ChatGPT subscription',startedAt:new Date().toISOString(),paidApiCalls:0,passed:false};
  const ask=native.ask.bind(native);
  native.ask=async(instructions,payload,options,signal,image)=>{
    const call={actor:options.agentId,task:payload.task?.id,kind:payload.task?.kind,startedAt:new Date().toISOString(),inputBytes:Buffer.byteLength(instructions+JSON.stringify(payload)),snapshotFiles:payload.snapshot?.files?.length};calls.push(call);
    console.log(JSON.stringify({app:app.id,call:calls.length,actor:call.actor,task:call.task,kind:call.kind}));
    try {const result=await ask(instructions,payload,{...options,onUsage:(input,output,...rest)=>{call.inputTokens=input;call.outputTokens=output;options.onUsage?.(input,output,...rest);}},signal,image);call.paths=result.files?.map(file=>file.path);return result;}
    finally {call.finishedAt=new Date().toISOString();}
  };
  try {
    if(!(await native.status()).connected)throw new Error('Existing Codex ChatGPT login unavailable');
    const catalog=await native.models(),model=catalog.find(row=>row.isDefault)??catalog.find(row=>/sol/i.test(row.id))??catalog[0];
    if(!model)throw new Error('No actual account model catalog');report.model=model.id;
    const validate=async context=>{
      const result={configured:true,passed:false,command:'restricted Node host checks + assigned node:test + Chromium UI',exitCode:1};
      try {
        if(hash(await readFile(join(root,'host-checks.cjs')))!==trustedHash)throw new Error('Immutable host checks were modified');
        const core=await runNode(root,'host-checks.cjs');result.output=core.output;if(!core.passed)throw new Error('Host business checks failed: '+core.output.slice(-9000));
        let authoredOutput='';
        for(const file of context.options.testPlan?.files??[]) {const authored=await runNode(root,file,true);authoredOutput+='\n'+authored.output;result.output+='\n'+authored.output;if(!authored.passed)throw new Error('AI-authored tests failed: '+authored.output.slice(-6000));}
        const observed=validationResult({code:0,output:authoredOutput,testPlan:context.options.testPlan});
        result.cases=observed.cases;
        if(!observed.passed)throw new Error('Planned test cases were not all observed in actual TAP output');
        const ui=await browserCheck(app,root,data);validations.push({corePassed:true,ui});if(!ui.passed){result.cases.push({id:'BROWSER_UI',title:'Actual app.js browser interactions',status:'failed'});throw new Error('UI app.js validation failed: '+ui.error);}
        result.passed=true;result.exitCode=0;result.summary='6 independent business tests, assigned tests and '+ui.checks.length+' actual browser checks passed';
      } catch(error) {result.summary=error.message;result.output=(result.output??'')+'\n'+error.stack;validations.push({failed:error.message});}
      return result;
    };
    const provider=new GPTProvider(null,resolve('src/skills/fun.md'),native);
    const engine=new Workflow(workspace,roleProviders({gpt:provider}),event=>{if(event.type==='workflow'&&['needs_attention','needs_input','completed'].includes(event.state.status))console.log(JSON.stringify({app:app.id,status:event.state.status,last:event.state.events.at(-1)?.message}));},validate);
    const request=`/fun ${app.idea}\nThis is an authorized, temporary local single-user simulation. All product decisions are specified below; no payment, external services, irreversible actions or real user data are allowed. Reversible typography/spacing choices within the stated visual direction are approved. Initial data is empty. UI generates UUID string ids. Unknown IDs in mutators throw. No migration/import/sync requirements. Default monthly expense budget is 300000 KRW, category food, date local today; other filters start empty except month. Habit summary renders numeric done/total such as 1/2; habit names max 80 characters. CRM default status new, value 0, notes empty; summary always uses all records. These simulation defaults are explicitly approved. Return genuine questions only for a missing requirement; do not manufacture decisions.\n${app.spec}\nUse exactly three tasks with role-isolated file scopes: feature (grok) writes core.cjs only; UI/integration (claude) writes index.html,app.js,styles.css only and depends on feature; tests (gpt) writes tests/domain.test.cjs only and depends on both. Controller gpt handles specification, test authoring and final read-only review; it must not write product code. The host runs independent immutable host-checks.cjs plus your Node tests and actual browser interactions. Tests must execute real exported behavior, cover each requirement, and be named with test plan case IDs. Produce a complete structured Fun contract, a node-test plan and no empty assertions. Keep implementations compact. No tools or package installation. Never claim execution before host validation. Do not add redundant review/debug implementation tasks. Every response is JSON, max one file for feature and test tasks; UI task max three files. Do not rewrite unrelated files in repair.`;
    report.limits={maxAgentCalls:10,maxRepairRounds:1};
    await engine.start(projectId,{request,gptSource:'codex',gptModel:model.id,funContract:true,unattended:true,designApproval:false,maxRepairRounds:1,maxAgentCalls:10,maxOutputTokens:12000,allowExecution:true,executionBackend:'host',mutation:false,team:[{id:'gpt',provider:'gpt',roles:['control','review','test']},{id:'grok',provider:'gpt',roles:['feature']},{id:'claude',provider:'gpt',roles:['ui']}],roles:{gpt:'gpt',grok:'gpt',claude:'gpt'}});
    const deadline=setTimeout(()=>{void engine.stop(projectId);},900000);
    await engine.runs.get(projectId).promise;clearTimeout(deadline);const state=await engine.current(projectId);
    Object.assign(report,{passed:state.status==='completed',status:state.status,rounds:state.round,usage:state.usage,testing:state.testing,validation:state.validation,reviewChain:state.reviewChain,tasks:state.tasks.map(task=>({id:task.id,owner:task.owner,kind:task.kind,status:task.status,writePaths:task.writePaths,report:task.report?.summary})),events:state.events.map(event=>({actor:event.actor,activity:event.activity,message:event.message}))});
  } catch(error) {report.error=error.message;}
  finally {
    native.close();report.calls=calls;report.validations=validations;report.finishedAt=new Date().toISOString();report.inputTokens=calls.reduce((sum,call)=>sum+(call.inputTokens??0),0);report.outputTokens=calls.reduce((sum,call)=>sum+(call.outputTokens??0),0);
    report.unmeasuredCalls=calls.filter(call=>!Number.isSafeInteger(call.inputTokens)||!Number.isSafeInteger(call.outputTokens)).length;
    report.deleted=[];for(const candidate of [root,data]){const actual=await realpath(candidate),base=await realpath(parent),part=relative(base,actual);if(!part||part.startsWith('..')||isAbsolute(part)||!part.startsWith(app.id+'-')||(await readFile(join(actual,'.simulation-owned'),'utf8'))!==id)throw new Error('Unsafe simulation cleanup refused');await rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:150});report.deleted.push(await access(candidate).then(()=>false,()=>true));}
    const serialized=JSON.stringify(report,null,2);await writeFile(join(parent,app.id+'-report-'+id+'.json'),serialized);await writeFile(join(parent,app.id+'-report.json'),serialized);console.log(JSON.stringify({app:app.id,passed:report.passed,status:report.status,error:report.error,calls:calls.length,input:report.inputTokens,output:report.outputTokens,deleted:report.deleted}));
  }
}
