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
    delivery: {
      github: true,
      accounts: { github: "example" },
      revision: "revision",
      grantId: "grant",
    },
  };
  const service = new AuxiliaryServices(
    {
      read: async (key) => records.get(key),
      write: async (key, value) => records.set(key, structuredClone(value)),
    },
    {
      list: async () => project,
      find: (data) => data,
      mutate: async (fn) => fn(project),
    },
    {
      snapshot: async () => snapshot,
      read: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
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
    project,
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
  assert.equal(pushes, 0);
  assert.equal(result().pending.target, "example/focus-timer-abcdefgh");
  await service.publish(state, true, { id: result().pending.id, yes: true });
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
  await service.publish(state, true, { id: result().pending.id, yes: true });
  assert.equal(result().status, "completed");
});

test("decline skips this run and remembering approval applies only to its service", async () => {
  const { service, state, project, result } = fixture();
  let pushes = 0;
  service.pushGitHub = async () => {
    pushes++;
    return { url: "https://github.com/example/timer" };
  };
  await service.publish(state);
  await service.publish(state, true, {
    id: result().pending.id,
    yes: false,
    remember: true,
  });
  assert.equal(pushes, 0);
  assert.equal(project.delivery.always, undefined);
  const next = { ...state, id: "next" };
  await service.publish(next);
  await assert.rejects(
    service.publish(next, true, { id: "stale", yes: true }),
    /만료/,
  );
  await service.publish(next, true, {
    id: result().pending.id,
    yes: true,
    remember: true,
  });
  assert.deepEqual(project.delivery.always, { github: true });
  await service.publish({ ...state, id: "later" });
  assert.equal(pushes, 2);
});

test("declining GitHub still asks separately about the Vercel destination", async () => {
  const { service, state, project, result } = fixture();
  Object.assign(project.delivery, {
    vercel: true,
    scope: "studio",
    target: "timer",
    production: true,
  });
  service.pushGitHub = async () => assert.fail("GitHub was declined");
  await service.publish(state);
  await service.publish(state, true, { id: result().pending.id, yes: false });
  assert.equal(result().pending.service, "vercel");
  assert.equal(result().pending.target, "studio/timer");
  assert.match(result().pending.action, /운영/);
  await service.publish(state, true, { id: result().pending.id, yes: false });
  assert.deepEqual(result().decisions, { github: false, vercel: false });
  assert.equal(result().status, "completed");
});

test("Vercel retry uses the matching deployment and rejects uncertain remote state", async () => {
  const { priorVercelDeployment } = await import("../src/core/services.js");
  const listing = (state, run = "run") => JSON.stringify({ deployments: [
    { state, url: "preview-123.vercel.app", meta: { handsOffRun: run } },
  ] });
  assert.equal(priorVercelDeployment(listing("READY"), "run"), "https://preview-123.vercel.app");
  assert.equal(priorVercelDeployment(listing("ERROR"), "run"), null);
  assert.equal(priorVercelDeployment('{"deployments":[]}', "run"), null);
  assert.throws(() => priorVercelDeployment(listing("BUILDING"), "run"), /처리 중/);
  assert.throws(() => priorVercelDeployment(listing("READY", "other"), "run"), /확인/);
  assert.throws(() => priorVercelDeployment("", "run"), /JSON/);
});

for (const existing of [false, true]) test("Git push interruption preserves the exact commit with existing parent " + existing, async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { Store } = await import("../src/core/store.js");
  const { pushVerifiedCommit } = await import("../src/core/release-commit.js");
  const execute = promisify(execFile);
  try { await execute("git", ["--version"]); }
  catch { t.skip("Git CLI unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "cw-release-test-"));
  t.after(() => rm(root, {recursive:true, force:true, maxRetries:5, retryDelay:100}));
  const { pathToFileURL } = await import("node:url");
  const remote = join(root, "remote.git");
  const url = pathToFileURL(remote).href;
  const store = new Store(join(root, "store"), {});
  await store.init();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(root, "empty-git-config");
  const git = (cwd) => async (...args) => (await execute("git", args, {cwd, env})).stdout.trim();
  await git(root)("init", "--bare", "--initial-branch=main", remote);
  let prior;
  if (existing) {
    const seed = join(root, "seed");
    await mkdir(seed);
    const run = git(seed);
    await run("init", "--initial-branch=main", "--template=");
    await writeFile(join(seed, "index.html"), "<title>Previous</title>");
    await run("add", ".");
    await run("-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "Previous");
    prior = await run("rev-parse", "HEAD");
    await run("push", url, "HEAD:refs/heads/main");
  }
  const identity = ["project", "run", "verified"];
  let pushes = 0;
  let attempted;
  for (const index of [1, 2, 3]) {
    const cwd = join(root, "stage-" + index);
    await mkdir(cwd);
    const real = git(cwd);
    await real("init", "--initial-branch=main", "--template=");
    const parent = index === 3 ? await git(remote)("rev-parse", "main") : prior;
    if (parent) {
      await real("fetch", url, "refs/heads/main");
      await real("reset", "--soft", "FETCH_HEAD");
    }
    await writeFile(join(cwd, "index.html"), "<title>Verified</title>");
    await real("add", ".");
    const gitRun = async (...args) => {
      if (args[0] !== "push") return real(...args);
      pushes++;
      const commit = await real("rev-parse", "HEAD");
      if (index === 1) attempted = commit;
      else {
        assert.equal(commit, attempted);
        await real(...args);
      }
      throw new Error("connection lost");
    };
    const attempt = pushVerifiedCommit({gitRun, url, cwd, store, identity, parent, expectedParent: prior, account: "fixture"});
    if (index < 3) await assert.rejects(attempt, /connection lost/);
    else assert.equal((await attempt).commit, attempted);
  }
  assert.equal(pushes, 2);
  assert.equal(await git(remote)("rev-list", "--count", "main"), existing ? "2" : "1");
});
