import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { Projects } from '../src/core/projects.js';
import { Workspace, relativeFile, digest } from '../src/core/workspace.js';

export async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'tower-workspace-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project'), outside = join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  const store = new Store(join(base, 'data'), {}); await store.init();
  const projects = new Projects(store); const id = (await projects.list()).activeId;
  const workspace = new Workspace(projects);
  const ticket = await workspace.prepare(id, root);
  await workspace.consent(id, ticket.ticket, true);
  return { base, root, outside, projects, workspace, id };
}
test('workspace authorization requires the main-process ticket and explicit consent', async t => {
  const { workspace, projects, id, root } = await fixture(t);
  await projects.revoke(id);
  await assert.rejects(workspace.write(id, 'code.js', 'x'));
  await assert.rejects(workspace.consent(id, 'invented-ticket', true));
  const ticket = await workspace.prepare(id, root);
  await assert.rejects(workspace.consent(id, ticket.ticket, false));
  await assert.rejects(workspace.consent(id, ticket.ticket, true));
});
test('generated outputs go to the granted folder and stop after revocation', async t => {
  const { workspace, projects, id, root } = await fixture(t);
  const grant = await workspace.grant(id);
  await workspace.write(id, 'src/app.js', 'export const ready = true;', { newOnly: true, grantId: grant.grantId });
  assert.equal(await readFile(join(root, 'src/app.js'), 'utf8'), 'export const ready = true;');
  const persisted = await projects.list(); assert.equal(persisted.items[0].workspace.root, root);
  await projects.revoke(id);
  await assert.rejects(workspace.write(id, 'src/blocked.js', 'no', { grantId: grant.grantId }));
  assert.equal(await readFile(join(root, 'src/app.js'), 'utf8'), 'export const ready = true;');
});
test('path traversal, Windows alternate streams, private files and workflow metadata are refused', () => {
  for (const path of ['../outside', 'src/../../outside', 'C:\\outside', '\\server\\file', 'file:stream', '.git/config', '.GIT/config', '.env', 'src/.env.local', 'file.', 'CON.txt', '.control-tower/state.json', '.Control-Tower/state.json']) assert.throws(() => relativeFile(path), path);
  assert.deepEqual(relativeFile('src/main.js'), ['src','main.js']);
});
test('directory junctions cannot escape the selected root', async t => {
  const { workspace, root, outside, id } = await fixture(t);
  await writeFile(join(outside, 'private.txt'), 'private');
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.read(id, 'linked/private.txt'));
  await assert.rejects(workspace.write(id, 'linked/new.txt', 'escape'));
  assert.ok(!(await workspace.tree(id)).files.some(file => file.path.startsWith('linked')));
});
test('optimistic hashes preserve edits made by another process', async t => {
  const { workspace, root, id } = await fixture(t);
  await writeFile(join(root, 'app.js'), 'original');
  const before = digest('original'); await writeFile(join(root, 'app.js'), 'user edit');
  await assert.rejects(workspace.write(id, 'app.js', 'AI replacement', { baseHash: before }));
  assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'user edit');
});
test('an old grant cannot save delayed output into a newly connected folder', async t => {
  const { workspace, outside, id } = await fixture(t);
  const old = await workspace.grant(id); const ticket = await workspace.prepare(id, outside);
  await workspace.consent(id, ticket.ticket, true);
  await assert.rejects(workspace.write(id, 'design/delayed.png', Buffer.from('late'), { grantId: old.grantId }));
});
test('snapshots exclude environment credentials and vendor folders', async t => {
  const { workspace, root, id } = await fixture(t);
  await writeFile(join(root, '.env'), 'PRIVATE=secret');
  await writeFile(join(root, 'app.js'), 'export default 1;');
  await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules/vendor.js'), 'vendor');
  const snapshot = await workspace.snapshot(id);
  assert.deepEqual(snapshot.files.map(file => file.path), ['app.js']); assert.equal(snapshot.truncated, false);
});
