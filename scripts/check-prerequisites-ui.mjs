import {_electron as electron} from '@playwright/test';
import {mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {workspaceWindow} from './electron-workspace.mjs';
const artifacts=resolve('artifacts'),profile=join(artifacts,'prerequisites-profile-'+Date.now());await mkdir(profile,{recursive:true});
const env={...process.env,TOWER_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const checks=[];let application;
try{
 application=await electron.launch({args:['.'],cwd:resolve('.'),env});
 await application.evaluate(({dialog},url)=>{
  const path=process.getBuiltinModule('url').fileURLToPath(url),require=process.getBuiltinModule('module').createRequire(path);
  globalThis.__toolsReady=false;globalThis.__sites=[];globalThis.__hostApproved=false;
  require(path).Prerequisites.prototype.scan=async function(){
   const ready=globalThis.__toolsReady;
   return this.current={platform:process.platform,arch:process.arch,needsAttention:!ready,rows:[
    {id:'node',label:'Node.js 24+ · npm',required:true,state:ready?'ready':'outdated',version:ready?'24.0.0':'22.0.0',purpose:'프로젝트 테스트·빌드'},
    {id:'git',label:'Git',required:true,state:ready?'ready':'missing',purpose:'GitHub 커밋·푸시'},
    {id:'gpt',label:'Codex CLI',required:true,state:ready?'ready':'missing',purpose:'선택한 AI'},
    {id:'gemini',label:'Gemini CLI',required:false,state:'missing',purpose:'선택 사항 · 이 AI를 사용할 때 설치'},
   ]};
  };
  require(path.replace('prerequisites.js','browser.js')).BrowserOpener.prototype.open=async url=>{globalThis.__sites.push(url);return true;};
  for(const [file,name]of[['codex','CodexConnection'],['claude','ClaudeConnection'],['cursor','CursorConnection'],['gemini','GeminiConnection']])require(path.replace('prerequisites.js',file+'.js'))[name].prototype.status=async()=>({installed:false,connected:false,login:{waiting:false}});
  const show=dialog.showMessageBox;dialog.showMessageBox=(...args)=>args.at(-1)?.title==='현재 PC에서 실행'?Promise.resolve({response:globalThis.__hostApproved?1:0}):show(...args);
 },pathToFileURL(resolve('src/core/prerequisites.js')).href);
 const page=await workspaceWindow(application);page.setDefaultTimeout(30000);
 await page.locator('#prerequisites-dialog[open]').waitFor();
 await page.waitForFunction(()=>window.tower.startupState().then(r=>r.value.mainVisible));
 assert.equal(await page.locator('#first-run-tour').evaluate(el=>el.open),false);
 assert.match(await page.locator('[data-tool=node]').innerText(),/24 이상으로 업데이트/);
 assert.match(await page.locator('[data-tool=gemini]').innerText(),/선택/);
 await page.screenshot({path:join(artifacts,'prerequisites-ui.png')});
 checks.push('Fresh startup finishes the splash and opens a missing/outdated tools dialog before the first-run tour; unused Gemini remains optional');
 await page.locator('[data-tool=node] button').click();
 assert.deepEqual(await application.evaluate(()=>globalThis.__sites),['https://nodejs.org/en/download']);
 const invalid=await page.evaluate(()=>window.tower.openInstallSite('https://untrusted.example/install'));assert.equal(invalid.ok,false);
 checks.push('An install click opens only the fixed official URL; arbitrary installer URLs are rejected and no download script runs');
 await application.evaluate(()=>globalThis.__toolsReady=true);
 await page.locator('#recheck-prerequisites').click();
 await page.locator('#continue-prerequisites').filter({hasText:'준비 완료'}).waitFor();
 assert.match(await page.locator('[data-tool=node]').innerText(),/24.0.0/);
 await page.locator('#continue-prerequisites').click();await page.locator('#first-run-tour[open]').waitFor();await page.locator('#tour-skip').click();
 await page.locator('#settings-dialog[open]').waitFor();
 assert.equal(await page.locator('#execution-backend').inputValue(),'docker');assert.equal(await page.locator('#design-mode').inputValue(),'layout');assert.equal(await page.locator('#mutation-by-default').isChecked(),false);
 checks.push('Rechecking updates readiness and continues onboarding; Docker, text preview and opt-in mutation are the actual new defaults');
 await page.locator('#execution-backend').selectOption('host');await page.locator('#allow-execution').check();await page.locator('#save-settings').click();
 const denied=(await page.evaluate(()=>window.tower.preferences())).value;assert.equal(denied.executionBackend,'docker');assert.equal(denied.allowExecution,false);
 await application.evaluate(()=>globalThis.__hostApproved=true);await page.locator('#save-settings').click();await page.locator('#settings-dialog').waitFor({state:'hidden'});
 const approved=(await page.evaluate(()=>window.tower.preferences())).value;assert.equal(approved.executionBackend,'host');assert.equal(approved.allowExecution,true);
 checks.push('Host execution requires a separate native consent: cancel preserves Docker, explicit approval persists the chosen host setting');
 await writeFile(join(artifacts,'prerequisites-ui-report.json'),JSON.stringify({passed:checks.length,checks,paidCalls:0},null,2));console.log(JSON.stringify({passed:checks.length,checks,paidCalls:0},null,2));
}finally{
 await application?.close().catch(()=>{});
 const actual=await realpath(profile).catch(()=>null);if(actual===profile&&actual.startsWith(join(artifacts,'prerequisites-profile-')))await rm(actual,{recursive:true,force:true,maxRetries:5});
}
