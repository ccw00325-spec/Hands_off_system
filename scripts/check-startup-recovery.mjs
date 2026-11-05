import { _electron as electron } from '@playwright/test';
import { mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { workspaceWindow } from './electron-workspace.mjs';

const artifacts = resolve('artifacts'), checks = [];
await mkdir(artifacts, { recursive: true });
for (const mode of ['recover', 'persistent', 'cancel']) {
  const profile = join(artifacts, 'startup-recovery-' + mode + '-' + Date.now());
  await mkdir(profile);
  const env = { ...process.env, TOWER_TEST_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await electron.launch({ args: ['.'], cwd: resolve('.'), env });
    await application.evaluate(({ BrowserWindow, dialog }, { mode, url }) => {
      const require = process.getBuiltinModule('module').createRequire(url);
      require(process.getBuiltinModule('url').fileURLToPath(url).replace('codex.js','prerequisites.js')).Prerequisites.prototype.scan=async()=>({rows:[],needsAttention:false,platform:process.platform,arch:process.arch});
      for (const [file, name] of [['codex', 'CodexConnection'], ['cursor', 'CursorConnection'], ['gemini', 'GeminiConnection'], ['claude', 'ClaudeConnection']]) {
        const cls = require(process.getBuiltinModule('url').fileURLToPath(url).replace('codex.js', file + '.js'))[name];
        cls.prototype.status = async () => ({ installed: false, connected: false, login: { waiting: false } });
      }
      globalThis.__recovery = { attempts: {}, dialogs: [], canceled: false };
      dialog.showErrorBox = (title, message) => {
        globalThis.__recovery.dialogs.push({ title, message });
        console.log('RECOVERY_FINAL', JSON.stringify(globalThis.__recovery));
      };
      const original = BrowserWindow.prototype.loadURL;
      BrowserWindow.prototype.loadURL = function (url, ...args) {
        const stage = url.endsWith('/splash.html') ? 'splash' : 'workspace';
        const state = globalThis.__recovery;
        state.attempts[stage] = (state.attempts[stage] || 0) + 1;
        const interrupt = stage === 'workspace' && (mode === 'persistent' || state.attempts[stage] === 1);
        if (interrupt) {
          // Hold the actual file request so stop() interrupts an unfinished load,
          // producing Chromium/Electron ERR_FAILED (-2), not a mocked rejection.
          this.webContents.session.webRequest.onBeforeRequest({ urls: [url] }, (_details, callback) => setTimeout(() => callback({}), 60));
        }
        const pending = original.call(this, url, ...args);
        if (interrupt) {
          setTimeout(() => { if (!this.isDestroyed()) this.webContents.stop(); }, 10);
          if (mode === 'cancel') pending.catch(() => {
            state.canceled = true;
            console.log('RECOVERY_CANCEL', JSON.stringify(state));
            BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('splash.html'))?.close();
          });
        }
        return pending;
      };
    }, { mode, url: pathToFileURL(resolve('src/core/codex.js')).href });
    const messages = [];
    application.on('console', message => messages.push(message.text()));
    if (mode === 'recover') {
      const page = await workspaceWindow(application);
      await page.waitForFunction(() => window.tower.startupState().then(r => r.value.mainVisible), { timeout: 30000 });
      const state = await application.evaluate(() => globalThis.__recovery);
      assert.equal(state.attempts.workspace, 2);
      assert.equal(state.dialogs.length, 0);
      const deadline = Date.now() + 5000;
      while (await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) !== 1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
      const diagnostics = JSON.parse(await readFile(join(profile, 'startup-diagnostics.json'), 'utf8'));
      assert.ok(diagnostics.some(row => row.code === 'ERR_FAILED' && row.errno === -2 && row.attempt === 1));
      assert.ok(diagnostics.every(row => !('message' in row) && !('url' in row)));
      await page.screenshot({ path: join(artifacts, 'startup-recovered.png') });
      checks.push('Actual stopped file navigation reproduces ERR_FAILED (-2), retries once, initializes the real UI and closes the splash without an error dialog');
    } else {
      await application.waitForEvent('close', { timeout: 30000 });
      const diagnostic = JSON.parse(await readFile(join(profile, 'startup-diagnostics.json'), 'utf8'));
      const failures = diagnostic.filter(row => row.stage === 'workspace');
      assert.equal(failures.length, mode === 'persistent' ? 3 : 1);
      if (mode === 'persistent') {
        const final = messages.find(line => line.startsWith('RECOVERY_FINAL '));
        assert.ok(final, messages.join('\n'));
        const state = JSON.parse(final.slice('RECOVERY_FINAL '.length));
        assert.equal(state.attempts.workspace, 3);
        assert.equal(state.dialogs.length, 1);
        checks.push('Persistent interruption stops after three attempts and emits one final actionable error instead of retrying indefinitely');
      } else {
        assert.ok(messages.some(line => line.startsWith('RECOVERY_CANCEL ')));
        assert.ok(!messages.some(line => line.startsWith('RECOVERY_FINAL ')));
        checks.push('Closing the splash during recovery exits without another navigation or an error dialog');
      }
      application = null;
    }
  } finally {
    await application?.close().catch(() => {});
    const actual = await realpath(profile).catch(() => null);
    if (actual === profile && actual.startsWith(join(artifacts, 'startup-recovery-'))) await rm(actual, { recursive: true, force: true });
  }
}
await writeFile(join(artifacts, 'startup-recovery-report.json'), JSON.stringify({ passed: checks.length, checks, paidCalls: 0 }, null, 2));
console.log(JSON.stringify({ passed: checks.length, checks, paidCalls: 0 }, null, 2));
