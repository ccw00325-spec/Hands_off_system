import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { claudeMeters,codexMeters,minimumRemaining,CodexUsage,UsageService,readClaudeUsage } from '../src/core/usage.js';

test('official quota percentages are remaining allowance, not token or context counts',()=>{
  const report={rate_limits:{limits:[{kind:'session',group:'session',percent:25,resets_at:'2026-11-02T15:00:00Z',is_active:true},{kind:'weekly_all',group:'weekly',percent:60,resets_at:null,is_active:true},{kind:'weekly_scoped',percent:99,is_active:false}]}};
  const meters=claudeMeters(report);assert.equal(meters[0].remainingPercent,75);assert.equal(minimumRemaining(meters),40);
  assert.equal(meters[0].resetsAt,'2026-11-02T15:00:00.000Z');assert.equal(meters[1].resetsAt,null);
});
test('absent or malformed usage is never converted into 100% remaining',()=>{
  assert.equal(claudeMeters({}),null);assert.equal(minimumRemaining(null),null);assert.equal(codexMeters({}),null);
  assert.equal(claudeMeters({rate_limits:{limits:[{percent:null},{percent:'0'},{percent:-1},{percent:101}]}}),null);
  assert.equal(codexMeters({rateLimits:{primary:{usedPercent:20},secondary:{usedPercent:null}}}),null);
  assert.equal(minimumRemaining(claudeMeters({rate_limits:{limits:[{percent:0}]}})),100);
});
test('Codex source keeps its account identity separate and makes metadata requests only',async()=>{
  const requests=[];const codex=new CodexUsage(()=>{}, {find:async()=>'/official/codex',rpcFactory:()=>({
    notify(){},close(){},request:async(method)=>{requests.push(method);if(method==='account/read')return {account:{type:'chatgpt',email:'separate@example.test'}};if(method==='account/rateLimits/read')return {rateLimits:{limitId:'codex',primary:{usedPercent:30,windowDurationMins:300,resetsAt:1800000000}}};return {};}
  })});
  const usage=await codex.read();codex.close();
  assert.equal(usage.remainingPercent,70);assert.equal(usage.accountLabel,'separate@example.test');assert.match(usage.message,/같다고 가정하지/);
  assert.deepEqual(requests,['initialize','account/read','account/rateLimits/read']);
});
test('refreshes coalesce; GPT and Grok never borrow native Codex quota',async()=>{
  let queries=0;
  const service=new UsageService({claude:{},codex:{read:async()=>{queries++;await new Promise(resolve=>setTimeout(resolve,10));return {provider:'codex',state:'available',remainingPercent:70,meters:[]};},close(){}},
    claudeReader:async()=>({provider:'claude',state:'available',remainingPercent:80,meters:[]})});
  const [one,two]=await Promise.all([service.refresh({force:true}),service.refresh({force:true})]);
  assert.equal(queries,1);assert.equal(one.providers.gpt.remainingPercent,null);assert.equal(one.providers.grok.remainingPercent,null);assert.equal(two.providers.claude.remainingPercent,80);
});
test('a failed refresh clears numbers instead of showing stale quota as live',async()=>{
  let success=true;
  const service=new UsageService({claude:{},codex:{read:async()=>({provider:'codex',state:'unavailable',remainingPercent:null,meters:[]}),close(){}},claudeReader:async()=>{if(!success)throw new Error('offline');return {provider:'claude',state:'available',remainingPercent:90,meters:[]};}});
  await service.refresh({force:true});success=false;const value=await service.refresh({force:true});assert.equal(value.providers.claude.remainingPercent,null);
});
test('official Claude /usage structured output is parsed without copying credentials',async()=>{
  let args;const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{};
  const promise=readClaudeUsage({status:async()=>({connected:true}),executable:async()=>'/official/claude'}, {spawnProcess:(_executable,argv)=>{args=argv;return child;}});
  await new Promise(resolve=>setImmediate(resolve));
  child.stdout.write(JSON.stringify({type:'assistant',usage_report:{rate_limits:{limits:[{kind:'session',percent:18,is_active:true}]}}})+'\n');
  child.emit('close',0);const value=await promise;assert.equal(value.remainingPercent,82);assert.ok(args.includes('/usage'));assert.ok(!args.includes('--disable-slash-commands'));
  assert.ok(!args.includes('--bare'),'bare mode must never disable the original CLI OAuth cache');
});
test('natural-language or context output cannot be mistaken for account quota',async()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{};
  const promise=readClaudeUsage({status:async()=>({connected:true}),executable:async()=>'/official/claude'}, {spawnProcess:()=>child});
  await new Promise(resolve=>setImmediate(resolve));
  child.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'You have 99% remaining'}]},context_usage:{percentage:1}})+'\n');child.emit('close',0);
  const value=await promise;assert.equal(value.remainingPercent,null);assert.equal(value.state,'unsupported');
});
