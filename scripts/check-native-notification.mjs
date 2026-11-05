// Manual Windows probe: sends one real OS toast; does not infer whether audio was audible.
import { _electron as electron } from '@playwright/test';
import { mkdir, writeFile, rm, lstat, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
if(process.platform!=='win32') throw new Error('Run this native Windows probe on Windows.');
const artifacts=resolve('artifacts'),stamp=Date.now(),entry=join(artifacts,`native-notification-${stamp}.cjs`),profile=join(artifacts,`native-notification-profile-${stamp}`);
await mkdir(artifacts,{recursive:true});
await writeFile(entry,`const {app}=require('electron');app.setName('CW_Handsoff_sys notification check');app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(profile)});app.setAppUserModelId('dev.agent.controltower');app.setToastActivatorCLSID('{7A709E29-B21D-4D27-8344-B21C6A963D8E}');app.whenReady().then(()=>{});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;let application,shortcut;
try {
  application=await electron.launch({args:[entry],env});
  const report=await application.evaluate(async({app,shell,Notification},url)=>{
    const file=process.getBuiltinModule('url').fileURLToPath(url),require=process.getBuiltinModule('module').createRequire(file);
    const {registerNotificationShortcut}=require(file);
    const path=require('node:path');
    const target=path.join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs',`CW_Handsoff_sys QA ${Date.now()}.lnk`);
    globalThis.__nativeProbeShortcut=target;
    await registerNotificationShortcut(app,{readShortcutLink:file=>shell.readShortcutLink(file),writeShortcutLink:(_file,_operation,details)=>shell.writeShortcutLink(target,'create',details)});
    const saved=shell.readShortcutLink(target);
    if(!Notification.isSupported()) throw new Error('Native Notification unsupported.');
    const notification=new Notification({title:'CW_Handsoff_sys · 알림 동작 확인',body:'답변 요청 알림과 기본 알림 소리를 확인하는 테스트입니다.',silent:false});
    globalThis.__nativeProbe=notification;
    return await new Promise(resolve=>{
      const timer=setTimeout(()=>resolve({shown:false,reason:'no native show event',shortcut:target}),15000);
      notification.once('show',()=>{clearTimeout(timer);resolve({shown:true,silent:notification.silent,appUserModelId:saved.appUserModelId,toastActivatorClsid:saved.toastActivatorClsid,shortcut:target});});
      notification.once('failed',(_event,error)=>{clearTimeout(timer);resolve({shown:false,reason:String(error),shortcut:target});});
      notification.show();
    });
  },pathToFileURL(resolve('src/core/input-notifications.js')).href);
  shortcut=report.shortcut;delete report.shortcut;
  await writeFile(join(artifacts,'native-notification-report.json'),JSON.stringify({...report,physicalAudioVerified:false,notes:'A real Windows show event and sound-enabled flag are checked; Windows settings/Do Not Disturb control actual audibility.'},null,2));
  assert.equal(report.shown,true,report.reason);assert.equal(report.silent,false);assert.equal(report.appUserModelId,'dev.agent.controltower');
  console.log(JSON.stringify(report,null,2));
} finally {
  if(application) shortcut??=await application.evaluate(()=>globalThis.__nativeProbeShortcut).catch(()=>null);
  await application?.close().catch(()=>{});
  if(shortcut&&dirname(shortcut).endsWith(join('Microsoft','Windows','Start Menu','Programs'))&&/^CW_Handsoff_sys QA \d+\.lnk$/.test(shortcut.split(/[\\/]/).at(-1))) {
    const info=await lstat(shortcut).catch(()=>null);if(info?.isFile()&&!info.isSymbolicLink())await rm(shortcut);
  }
  await rm(entry,{force:true});
  if(dirname(profile)===artifacts&&/^native-notification-profile-\d+$/.test(profile.split(/[\\/]/).at(-1))) {
    const actual=await realpath(profile).catch(()=>null),info=await lstat(profile).catch(()=>null);
    if(actual===profile&&info?.isDirectory()&&!info.isSymbolicLink())await rm(actual,{recursive:true,force:true,maxRetries:5});
  }
}
