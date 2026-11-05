import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm,realpath,access} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
if(process.platform!=='darwin')throw Error('Packaged Mac execution must run on macOS.');
const arch=process.argv.find(a=>a.startsWith('--arch='))?.slice(7)??process.arch;
assert.equal(arch,process.arch,'Native package verification requires the matching runner architecture');
const manifest=JSON.parse(await readFile('package.json','utf8'));
const executable=resolve('release-mac',arch==='arm64'?'mac-arm64':'mac','CW_Handsoff_sys.app','Contents','MacOS','CW_Handsoff_sys');
const parent=await realpath(tmpdir()),profile=await mkdtemp(join(parent,'cw-packaged-mac-'));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(executable,['--user-data-dir='+profile],{env,detached:true,stdio:['ignore','ignore','ignore']});
let spawnError;child.on('error',e=>spawnError=e);
try {
 const deadline=Date.now()+150000;let marker;
 while(Date.now()<deadline){
  if(spawnError)throw spawnError;
  if(child.exitCode!==null)throw Error('Mac app exited before startup');
  marker=await readFile(join(profile,'startup-ready.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(marker)break;await new Promise(r=>setTimeout(r,250));
 }
 assert.ok(marker,'Mac app did not finish startup');assert.equal(marker.version,manifest.version);assert.equal(marker.mainVisible,true);assert.equal(marker.splashClosed,true);assert.equal(marker.percent,100);
 assert.equal(await access(join(profile,'vault.enc')).then(()=>true,()=>false),false);
 await mkdir(resolve('artifacts'),{recursive:true});
 const report={passed:true,platform:process.platform,arch,version:manifest.version,mainVisible:true,splashClosed:true,credentialVaultCopied:false,signing:'ad-hoc; no Developer ID notarization'};
 await writeFile(resolve('artifacts/packaged-startup-mac.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {
 try{process.kill(-child.pid,'SIGTERM');}catch{}
 await new Promise(r=>setTimeout(r,500));try{process.kill(-child.pid,'SIGKILL');}catch{}
 const actual=await realpath(profile),part=relative(parent,actual);
 if(part.startsWith('cw-packaged-mac-')&&!part.startsWith('..')&&!isAbsolute(part))await rm(actual,{recursive:true,force:true,maxRetries:5});
}
