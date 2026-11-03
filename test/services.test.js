import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AuxiliaryServices, repositoryName } from "../src/core/services.js";
import { digest } from "../src/core/workspace.js";

function fixture() {
  const records = new Map();
  const files = [
    { path: "index.html", content: "<title>Timer</title>" },
    { path: ".github/workflows/deploy.yml", content: "test fixture" },
  ].map((file) => ({ ...file, hash: digest(file.content) }));
  const snapshot = { grantId: "grant", hash: "hash", files };
  const project = {
    title: "Timer App",
    delivery: { github: true, revision: "revision", grantId: "grant" },
  };
  const service = new AuxiliaryServices(
    {
      read: async (key) => records.get(key),
      write: async (key, value) => records.set(key, structuredClone(value)),
    },
    { list: async () => project, find: (data) => data },
    {
      snapshot: async () => snapshot,
      grant: async () => ({ grantId: "grant" }),
    },
    () => {},
  );
  const state = {
    projectId: "abcdefgh-001",
    id: "run",
    status: "completed",
    grantId: "grant",
    snapshotHash: "hash",
    validation: { passed: true },
    options: { deliveryRevision: "revision" },
    repositoryName: "focus-timer",
  };
  return {
    service,
    state,
    snapshot,
    result: () => records.get(`delivery-${state.projectId}`),
  };
}

test("only verified source is exported, and completed runs do not push twice", async () => {
  const { service, state, result } = fixture();
  let pushes = 0;
  service.pushGitHub = async (id, config, directory, suggestion) => {
    pushes++;
    assert.deepEqual(await readdir(directory), ["index.html"]);
    assert.equal(
      await readFile(join(directory, "index.html"), "utf8"),
      "<title>Timer</title>",
    );
    assert.equal(repositoryName(suggestion, id), "focus-timer-abcdefgh");
    return { url: "https://github.com/example/timer" };
  };
  await service.publish({ ...state, status: "needs_attention" });
  assert.equal(pushes, 0);
  await service.publish(state);
  await service.publish(state);
  await service.publish(state, true);
  assert.equal(pushes, 1);
  assert.equal(result().status, "completed");
});

test("publishing blocks changed files and retries only the same verified snapshot", async () => {
  const { service, state, snapshot, result } = fixture();
  snapshot.hash = "changed";
  service.pushGitHub = async () =>
    assert.fail("Changed snapshot must not be uploaded");
  await service.publish(state);
  assert.equal(result().status, "failed");
  assert.match(result().message, /파일이 달라졌습니다/);
  snapshot.hash = "hash";
  service.pushGitHub = async () => ({
    url: "https://github.com/example/timer",
  });
  await service.publish(state, true);
  assert.equal(result().status, "completed");
});
