import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadLocalWindow } from "../src/core/window-loader.js";

const file = fileURLToPath(new URL('../src/renderer/index.html', import.meta.url));
function fixture(load) {
  return { isDestroyed: () => false, webContents: { isDestroyed: () => false }, loadURL: load };
}
const failed = (code) => Object.assign(new Error('injected load failure'), { code });

test('interrupted local loads retry with a canonical file URL and finally succeed', async () => {
  const attempts = [], failures = [], retries = [];
  const window = fixture(async (url) => {
    attempts.push(url);
    if (attempts.length < 3) throw failed(attempts.length === 1 ? 'ERR_FAILED' : 'ERR_ABORTED');
  });
  assert.equal(await loadLocalWindow(window, file, {
    retryDelays: [0, 0], onFailure: (error, attempt) => failures.push([error.code, attempt]), onRetry: n => retries.push(n),
  }), true);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(url => !url.includes('\\') && url.startsWith('file:///')));
  assert.deepEqual(failures, [['ERR_FAILED', 1], ['ERR_ABORTED', 2]]);
  assert.deepEqual(retries, [2, 3]);
});

test('persistent failures stop after three attempts instead of looping forever', async () => {
  let calls = 0;
  await assert.rejects(loadLocalWindow(fixture(async () => { calls++; throw failed('ERR_FAILED'); }), file, { retryDelays: [0, 0] }), { code: 'ERR_FAILED' });
  assert.equal(calls, 3);
});

test('blocked files are not retried and the real failure reaches the caller', async () => {
  let calls = 0;
  await assert.rejects(loadLocalWindow(fixture(async () => { calls++; throw failed('ERR_ACCESS_DENIED'); }), file), { code: 'ERR_ACCESS_DENIED' });
  assert.equal(calls, 1);
});

test('a missing entry file fails before trying to navigate', async () => {
  let calls = 0;
  await assert.rejects(loadLocalWindow(fixture(async () => { calls++; }), file + '.missing'), { code: 'ENOENT' });
  assert.equal(calls, 0);
});

test('closing during recovery prevents further navigation or an error dialog', async () => {
  let closing = false, calls = 0;
  assert.equal(await loadLocalWindow(fixture(async () => { calls++; throw failed('ERR_FAILED'); }), file, {
    retryDelays: [0, 0], isClosing: () => closing, onRetry: () => { closing = true; },
  }), false);
  assert.equal(calls, 1);
});

test('a window destroyed during loading is an intentional cancellation', async () => {
  let destroyed = false;
  const window = fixture(async () => { destroyed = true; throw failed('ERR_FAILED'); });
  window.isDestroyed = () => destroyed;
  assert.equal(await loadLocalWindow(window, file), false);
});
