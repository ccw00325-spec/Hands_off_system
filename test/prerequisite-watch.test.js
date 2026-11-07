import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrerequisiteWatch } from '../src/renderer/prerequisite-watch.js';
const report = state => ({ rows: [{ id: 'node', state, required: true }], needsAttention: state !== 'ready' });
function harness(scan) {
  const timers = new Map(), frames = [], ready = []; let counter = 0;
  const watch = createPrerequisiteWatch({ scan, visible: () => true, render: (value, state) => frames.push({ value, state: {checking: state.checking, intents: [...state.intents]} }),
    becameReady: rows => ready.push(...rows), schedule: fn => { const id = ++counter; timers.set(id, fn); return id; }, cancel: id => timers.delete(id) });
  return { watch, timers, frames, ready };
}
test('installation is ready only after the actual host reports ready, then polling stops', async () => {
  let state = 'missing', calls = 0; const h = harness(async () => { calls++; return report(state); });
  h.watch.open(report('missing')); await h.watch.installing('node', async () => {});
  assert.equal(h.frames.at(-1).value.rows[0].state, 'missing');
  await h.watch.check(); assert.equal(h.ready.length, 0);
  state = 'ready'; await h.watch.check();
  assert.equal(h.ready.length, 1); assert.equal(h.frames.at(-1).value.rows[0].state, 'ready'); assert.equal(h.timers.size, 0);
  h.watch.close(); assert.equal(calls, 2);
});
test('overlapping checks share one host scan and a closed dialog ignores a delayed response', async () => {
  let finish, calls = 0; const h = harness(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  h.watch.open(report('missing')); const first = h.watch.check(), second = h.watch.check();
  assert.equal(calls, 1); h.watch.close(); finish(report('ready')); await Promise.all([first, second]);
  assert.equal(h.ready.length, 0); assert.equal(h.timers.size, 0);
});
test('unused optional tools do not poll until the user opens their install guide; failed opens do not invent progress', async () => {
  const optional = { rows: [{ id:'gemini', required:false, state:'missing' }], needsAttention:false };
  const h = harness(async () => optional); h.watch.open(optional); assert.equal(h.timers.size, 0);
  await assert.rejects(h.watch.installing('gemini', async () => { throw new Error('browser unavailable'); }));
  assert.equal(h.frames.at(-1).state.intents.length, 0); assert.equal(h.timers.size, 0);
  await h.watch.installing('gemini', async () => {}); assert.equal(h.timers.size, 1); h.watch.close();
});
