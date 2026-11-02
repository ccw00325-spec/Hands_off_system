import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { Projects } from '../src/core/projects.js';
import { Workspace } from '../src/core/workspace.js';
import { validateProject } from '../src/core/validation.js';
async function setup(t) {
  const base=await mkdtemp(join(tmpdir(),'tower-validation-')); t.after(()=>rm(base,{ recursive:true,force:true }));
  const root=join(base,'project'); await mkdir(root);
  const store=new Store(join(base,'data'),{}); await store.init();
  const projects=new Projects(store), id=(await projects.list()).activeId, workspace=new Workspace(projects);
  const pending=await workspace.prepare(id,root); await workspace.consent(id,pending.ticket,true);
  const grant=await workspace.grant(id);
  await writeFile(join(root,'package.json'),JSON.stringify({ private:true,scripts:{ pass:'node pass.cjs',fail:'node fail.cjs',wait:'node wait.cjs' } }));
  await writeFile(join(root,'pass.cjs'),'console.log("checked")');
  await writeFile(join(root,'fail.cjs'),'process.exit(1)');
  await writeFile(join(root,'wait.cjs'),'setTimeout(()=>require("node:fs").writeFileSync("should-not-exist.txt","late"), 3000)');
  return { workspace,root,projectId:id,grantId:grant.grantId };
}
test('validation runs only the user-selected npm script after explicit execution consent',async t=>{
  const f=await setup(t), signal=new AbortController().signal;
  await assert.rejects(validateProject(f.workspace,{ ...f,signal,options:{ validationScript:'pass',allowExecution:false } }));
  const pass=await validateProject(f.workspace,{ ...f,signal,options:{ validationScript:'pass',allowExecution:true } });
  assert.equal(pass.passed,true); assert.match(pass.output,/checked/);
  const fail=await validateProject(f.workspace,{ ...f,signal,options:{ validationScript:'fail',allowExecution:true } });
  assert.equal(fail.passed,false);
  await assert.rejects(validateProject(f.workspace,{ ...f,signal,options:{ validationScript:'test & echo unsafe',allowExecution:true } }));
});
test('cancelling validation terminates its npm process tree',async t=>{
  const f=await setup(t), controller=new AbortController();
  const running=validateProject(f.workspace,{ ...f,signal:controller.signal,options:{ validationScript:'wait',allowExecution:true } });
  const timer=setTimeout(()=>controller.abort(),900); t.after(()=>clearTimeout(timer));
  await assert.rejects(running,/중지/);
  await assert.rejects(readFile(join(f.root,'should-not-exist.txt')),{ code:'ENOENT' });
});
