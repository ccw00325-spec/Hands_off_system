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
 await application.evaluate(({dialog},data)=>{
  const path=process.getBuiltinModule('url').fileURLToPath(data.url),require=process.getBuiltinModule('module').createRequire(path);
  globalThis.__toolsReady=false;globalThis.__sites=[];globalThis.__hostApproved=false;
  const Prerequisites=require(path).Prerequisites, scan=Prerequisites.prototype.scan;
  Prerequisites.prototype.scan=async function(){
   const ready=globalThis.__toolsReady;
   const fixture=new Prerequisites({node:async()=>data.nodePath,find:async name=>ready?'/fixture/'+name:null,
    probe:async(executable,args)=>({code:0,output:args[0]==='--version'?(executable.endsWith('git')?'git version 2.48.0':ready?'v24.0.0':'v22.0.0'):'28.0.0'})});
   return this.current=await scan.call(fixture,{gpt:{installed:ready}},{providers:['gpt'],executionBackend:'docker'});
  };
  const Browser=require(path.replace('prerequisites.js','browser.js')).BrowserOpener,open=Browser.prototype.open;
  Browser.prototype.open=async function(url){this.openDefault=async safe=>{globalThis.__sites.push(safe);return true;};return open.call(this,url);};
  for(const [file,name]of[['codex','CodexConnection'],['claude','ClaudeConnection'],['cursor','CursorConnection'],['gemini','GeminiConnection']])require(path.replace('prerequisites.js',file+'.js'))[name].prototype.status=async()=>({installed:false,connected:false,login:{waiting:false}});
  const show=dialog.showMessageBox;dialog.showMessageBox=(...args)=>args.at(-1)?.title==='현재 PC에서 실행'?Promise.resolve({response:globalThis.__hostApproved?1:0}):show(...args);
 },{url:pathToFileURL(resolve('src/core/prerequisites.js')).href,nodePath:process.execPath});
 const page=await workspaceWindow(application);page.setDefaultTimeout(30000);
 await page.locator('#prerequisites-dialog[open]').waitFor();
 await page.waitForFunction(()=>window.tower.startupState().then(r=>r.value.mainVisible));
 assert.equal(await page.locator('#first-run-tour').evaluate(el=>el.open),false);
 assert.match(await page.locator('[data-tool=node]').innerText(),/24 이상으로 업데이트/);
 assert.match(await page.locator('[data-tool=gemini]').innerText(),/선택/);
  assert.equal(await page.locator('[data-tool=node] .prerequisite-badge').innerText(),'필수');
  assert.equal(await page.locator('[data-tool=gemini] .prerequisite-badge').innerText(),'선택');
  assert.equal(await page.locator('[data-tool=node] .prerequisite-badge').getAttribute('data-required'),'true');
  assert.equal(await page.locator('[data-tool=gemini] .prerequisite-badge').getAttribute('data-required'),'false');
  assert.ok(await page.locator('[data-tool=node] small').innerText());
 assert.equal(await page.locator('[data-tool=git] .prerequisite-badge').innerText(),'선택');
 assert.equal(await page.locator('[data-tool=docker] .prerequisite-badge').innerText(),'필수');
 assert.match(await page.locator('[data-tool=docker] small').innerText(),/현재 Docker.*필수/);
 assert.match(await page.locator('[data-tool=git] small').innerText(),/GitHub.*백업/);
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
