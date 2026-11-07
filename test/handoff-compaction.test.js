import test from 'node:test';
import assert from 'node:assert/strict';
import { compactHandoff } from '../src/core/handoff.js';

test('provider handoff references exact duplicate long text without changing the persisted facts', () => {
  const context = { request: '요구사항 '.repeat(100), spec: '검증할 명세 '.repeat(200), task: { instructions: '담당 파일만 수정 '.repeat(100) } };
  const handoff = { request: context.request, specification: context.spec, task: { id:'T1', instructions:context.task.instructions }, validation:{ passed:false } };
  const before=structuredClone(handoff), result=compactHandoff(context,handoff);
  assert.deepEqual(handoff,before);
  assert.equal(result.requestRef,'request'); assert.equal(result.specificationRef,'spec'); assert.equal(result.task.instructionsRef,'task.instructions');
  assert.equal(result.request,undefined); assert.equal(result.specification,undefined); assert.equal(result.task.instructions,undefined);
  assert.deepEqual(result.validation,handoff.validation);
  assert.ok(JSON.stringify(result).length < JSON.stringify(handoff).length / 4);
  for(const [key,ref] of [['request','request'],['specification','spec']]) assert.equal(context[result[key+'Ref']],before[key]);
});

test('different requirements, short text and absent canonical fields retain their original content', () => {
  const handoff={request:'짧은 요청', specification:'원래 명세 '.repeat(80),task:{instructions:'원래 지침 '.repeat(80)}};
  const result=compactHandoff({request:handoff.request,spec:'다른 명세 '.repeat(80),task:{instructions:'다른 지침 '.repeat(80)}},handoff);
  assert.deepEqual(result,handoff);
  assert.deepEqual(compactHandoff({},handoff),handoff);
});
