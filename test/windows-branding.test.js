import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cacheWindowsIcon, windowsTaskbarDetails, WINDOWS_APP_ID, WINDOWS_DEV_APP_ID, LEGACY_WINDOWS_APP_ID } from '../src/core/windows-branding.js';

const settings = { packaged: true, executable: 'D:\\Apps\\Hands off.exe', iconPath: 'C:\\Users\\fixture\\branding\\mascot.ico' };
test('portable taskbar metadata points to the real launcher with the full relaunch property set', () => {
  const details = windowsTaskbarDetails(settings);
  assert.equal(details.relaunchCommand, '"D:\\Apps\\Hands off.exe"');
  assert.equal(details.relaunchDisplayName, 'CW_Handsoff_sys');
  assert.equal(details.appIconPath, settings.iconPath);
  assert.equal(details.appId, WINDOWS_APP_ID);
  assert.notEqual(details.appId, LEGACY_WINDOWS_APP_ID);
});
test('development and isolated profiles retain their entrypoint without sharing the production taskbar identity', () => {
  const details = windowsTaskbarDetails({ ...settings, packaged: false, executable: 'D:\\Tools\\electron.exe', appPath: 'D:\\My Agent', profileDirectory: 'D:\\Profiles\\QA' });
  assert.equal(details.appId, WINDOWS_DEV_APP_ID);
  assert.notEqual(details.appId, WINDOWS_APP_ID);
  assert.equal(details.relaunchCommand, '"D:\\Tools\\electron.exe" "D:\\My Agent" --user-data-dir="D:\\Profiles\\QA"');
});
test('relaunch metadata rejects network, relative and command-breaking paths', () => {
  for (const executable of ['\\\\server\\share\\app.exe', 'relative.exe', 'D:\\Apps\\bad" --remote.exe', 'D:\\Apps\\bad\n.exe'])
    assert.throws(() => windowsTaskbarDetails({ ...settings, executable }));
  assert.throws(() => windowsTaskbarDetails({ ...settings, iconPath: '\\\\server\\share\\icon.ico' }));
});
test('the approved ICO survives extraction cleanup in a stable per-profile content-addressed cache', async () => {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'hands-off-branding-'));
  try {
    const source = join(root, 'extracted.ico'), profile = join(root, 'profile');
    const bytes = await readFile(new URL('../build/app.ico', import.meta.url));
    await writeFile(source, bytes);
    const cached = await cacheWindowsIcon(source, profile);
    assert.equal(cached, await cacheWindowsIcon(source, profile));
    await rm(source); assert.deepEqual(await readFile(cached), bytes);
    await writeFile(source, Buffer.concat([bytes, Buffer.from([0])]));
    assert.notEqual(await cacheWindowsIcon(source, profile), cached);
    const other = await cacheWindowsIcon(source, join(root, 'other-profile')); assert.notEqual(other, cached);
    const linkSource = join(root, 'link-source.ico'); await writeFile(linkSource, bytes);
    await rm(cached); await symlink(process.platform === 'win32' ? root : linkSource, cached, process.platform === 'win32' ? 'junction' : undefined);
    await assert.rejects(cacheWindowsIcon(linkSource, profile), /저장/);
    assert.deepEqual(await readFile(linkSource), bytes);
  } finally {
    const actual = await realpath(root);
    assert.equal(actual, root); assert.ok(actual.startsWith(join(base, 'hands-off-branding-')));
    await rm(actual, {recursive: true, force: true});
  }
});
