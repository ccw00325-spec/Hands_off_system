import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {Workflow} from '../src/core/workflow.js';
function fixture(){
 const engine=new Workflow({},{}),run={controller:new AbortController(),state:{status:'awaiting_design',request:'UI',options:{conversationId:'c1'},design:{status:'pending',format:'image',feedback:[],specification:{screens:[]}}}};
 let accepted=0;run.acceptDesign=()=>accepted++;engine.runs.set('p',run);engine.record=async()=>{};
 engine.designGenerator=async()=>({artifactId:'image',path:'design/image.png',hash:'approved-image'});
 return{engine,run,accepted:()=>accepted};
}
for(const format of ['image','layout'])test(`a ready ${format} preview approval waits for its pending completion record instead of rejecting the click`,async t=>{
 const f=fixture();let release,writing=false;const gate=new Promise(r=>release=r);t.after(()=>release());
 f.engine.record=async(_run,_actor,message)=>{if(message.includes('한번 확인')||message.includes('구조안을 준비')){writing=true;await gate;}};
 const generating=f.engine.reviseDesign('p','','gpt','c1',format);while(!writing)await tick();
 assert.equal(f.run.state.design.status,'ready');assert.equal(f.run.designBusy,true);
 let settled=false;const approval=f.engine.approveDesign('p','c1').finally(()=>settled=true);
 await tick();assert.equal(settled,false);assert.equal(f.accepted(),0);
 release();await Promise.all([generating,approval]);assert.equal(f.accepted(),1);assert.equal(f.run.state.design.status,'approved');
});
test('a design still generating cannot be approved and a different conversation cannot claim it',async t=>{
 const f=fixture();let release;const gate=new Promise(r=>release=r);t.after(()=>release());f.engine.designGenerator=async()=>{await gate;return{path:'design/image.png',hash:'approved-image'};};
 const generating=f.engine.reviseDesign('p','','gpt','c1','image');await tick();
 await assert.rejects(f.engine.approveDesign('p','c1'),/준비될/);await assert.rejects(f.engine.approveDesign('p','other'),/준비될/);assert.equal(f.accepted(),0);
 release();await generating;await f.engine.approveDesign('p','c1');assert.equal(f.accepted(),1);
});
test('cancelling while a ready design record is pending prevents late approval',async t=>{
 const f=fixture();let release,writing=false;const gate=new Promise(r=>release=r);t.after(()=>release());f.engine.record=async(_run,_actor,message)=>{if(message.includes('한번 확인')){writing=true;await gate;}};
 const generating=f.engine.reviseDesign('p','','gpt','c1','image');while(!writing)await tick();
 const approval=f.engine.approveDesign('p','c1');const rejection=assert.rejects(approval,/cancelled/);f.run.controller.abort(new Error('cancelled'));release();await Promise.all([generating,rejection]);assert.equal(f.accepted(),0);
});
