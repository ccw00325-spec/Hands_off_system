import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { Projects } from "../src/core/projects.js";

test("unavailable encryption never falls back to a plaintext credential file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tower-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory, { isEncryptionAvailable: () => false });
  await assert.rejects(
    store.mutateSecrets((vault) => {
      vault.secret = "must-not-write";
    }),
  );
  await assert.rejects(readFile(join(directory, "vault.enc")), {
    code: "ENOENT",
  });
});
test("parallel vault updates retain both connections", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tower-vault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A deterministic test codec; production always uses Electron's OS-backed safeStorage.
  const codec = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text),
    decryptString: (buffer) => buffer.toString(),
  };
  const store = new Store(directory, codec);
  await store.init();
  await Promise.all([
    store.mutateSecrets((vault) => {
      vault.account = "a";
    }),
    store.mutateSecrets((vault) => {
      vault.imageKey = "b";
    }),
  ]);
  assert.deepEqual(await store.secrets(), { account: "a", imageKey: "b" });
});
test("project names and selected project persist independently of credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tower-projects-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory, {});
  await store.init();
  const projects = new Projects(store);
  const initial = await projects.list();
  const data = await projects.create("타이머 앱");
  await projects.rename(data.activeId, "집중 타이머");
  const reloaded = new Projects(store);
  assert.equal((await reloaded.list()).items[1].title, "집중 타이머");
  await reloaded.select(initial.activeId);
  assert.equal((await reloaded.list()).activeId, initial.activeId);
  await assert.rejects(projects.rename("../escape", "No"));
});
