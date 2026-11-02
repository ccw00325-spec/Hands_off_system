import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseCursorModels,parseCursorStatus,cursorACPModels,CursorConnection } from '../src/core/cursor.js';
import { CursorProvider } from '../src/core/cursor-provider.js';
import { RpcProcess } from '../src/core/rpc-process.js';

test('Cursor metadata exposes only connection status, never native credentials or identity',()=>{
  const result=parseCursorStatus({isAuthenticated:true,hasAccessToken:true,userInfo:{email:'private@example.test'},accessToken:'private'});
  assert.deepEqual(result,{installed:true,connected:true,state:'connected',source:'cursor'});
  assert.equal(parseCursorStatus({isAuthenticated:true},1).connected,false);
  assert.equal(parseCursorStatus({hasAccessToken:true}).connected,false);
});
test('Cursor catalog retains exact Grok and cursor-grok model IDs without inventing aliases',()=>{
  assert.deepEqual(parseCursorModels('\u001b[32mgrok-4.7-high - Grok 4.7 High\u001b[0m\ncursor-grok-4.6-low - Grok 4.6 Low\nsonnet - Sonnet\ngrok-4.7-high - duplicate'),[
    {id:'grok-4.7-high',name:'Grok 4.7 High'},{id:'cursor-grok-4.6-low',name:'Grok 4.6 Low'}
  ]);
  assert.deepEqual(parseCursorModels('{"models":[{"id":"grok-test","displayName":"Grok test"},{"id":"auto"}]}'),[{id:'grok-test',name:'Grok test'}]);
});
test('existing Cursor login is reused without spawning a new login or model prompt',async()=>{
  const calls=[];const connection=new CursorConnection(()=>{},{find:async()=>({executable:'node',prefix:['official-cli.js']}),capture:async(_launch,args)=>{calls.push(args);return {code:0,text:'{"isAuthenticated":true}'};},spawn:()=>assert.fail('unexpected login')});
  assert.equal((await connection.connect()).reused,true);assert.deepEqual(calls,[['status','--format','json']]);
});
test('Grok model selection validates native catalog and each run freezes its selected model',async()=>{
  let saved={};const calls=[];const store={read:async()=>saved,write:async(_key,value)=>{saved=value;}};
  const connection={status:async()=>({connected:true}),models:async()=>[{id:'grok-a'},{id:'grok-b'}],ask:async(_instruction,_context,model)=>{calls.push(model);return {summary:'ok',files:[]};}};
  const provider=new CursorProvider(store,()=>{},connection);
  await assert.rejects(()=>provider.selectModel('auto'));
  await provider.selectModel('grok-a');const options={grokRoute:await provider.selection()};await provider.selectModel('grok-b');
  assert.equal(await provider.ready(options),true);await provider.build({options});await provider.review({options});
  assert.deepEqual(calls,['grok-a','grok-a']);assert.equal((await provider.selection()).modelId,'grok-b');
  assert.equal(await provider.ready({grokRoute:{source:'cursor',modelId:'missing'}}),false);
  await assert.rejects(()=>provider.build({options:{}}),/지정되지/);
});
test('Cursor ACP selects ask mode and exact frozen model before a prompt; propagates errors',async()=>{
  const calls=[];let closed=false;
  const connection=new CursorConnection(()=>{},{find:async()=>({executable:'node',prefix:['official-cli.js']}),rpcFactory:(_exe,args,settings)=>{
    assert.deepEqual(args,['official-cli.js','acp']);return {
    request:async(method,params)=>{calls.push({method,params});
      if(method==='initialize')return {authMethods:[{id:'cursor_login'}]};
      if(method==='session/new')return {sessionId:'test',modes:{availableModes:[{id:'ask'}]},models:{currentModelId:'grok-test[effort=high]',availableModels:[{modelId:'grok-test[effort=high]'}]}};
      if(method==='session/prompt'){settings.onNotification('session/update',{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"summary":"ok","files":[]}'}}});return {stopReason:'end_turn'};}
      return {};
    },close:()=>{closed=true;}
  };}});
  assert.equal((await connection.ask('return manifest',{snapshot:{root:'/fixture'},signal:new AbortController().signal},'grok-test[effort=high]')).summary,'ok');
  assert.deepEqual(calls.map(row=>row.method),['initialize','authenticate','session/new','session/set_mode','session/set_model','session/prompt']);
  assert.equal(calls[0].params.clientCapabilities.terminal,false);assert.equal(calls[3].params.modeId,'ask');assert.equal(calls[4].params.modelId,'grok-test[effort=high]');assert.equal(closed,true);
});
test('ACP catalog uses canonical model IDs rather than incompatible CLI aliases',()=>{
  assert.deepEqual(cursorACPModels({models:{availableModels:[{modelId:'grok-test[effort=high]',name:'Grok test'},{modelId:'default[]',name:'Auto'},{modelId:'claude-test[]'}]}}),[{id:'grok-test[effort=high]',name:'Grok test'}]);
});
test('ACP permission, plan approval and questions are explicitly cancelled; native tools never run',async()=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};let output='';child.stdin.on('data',chunk=>{output+=chunk;});
  const rpc=new RpcProcess('fixture',[],{spawn:()=>child});
  for(const [index,method] of ['session/request_permission','cursor/create_plan','cursor/ask_question','terminal/create'].entries())child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:index,method,params:{}})+'\n');
  await new Promise(resolve=>setImmediate(resolve));const rows=output.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,4);for(const row of rows.slice(0,3))assert.deepEqual(row.result,{outcome:{outcome:'cancelled'}});assert.equal(rows[3].error.code,-32601);rpc.close();
});
