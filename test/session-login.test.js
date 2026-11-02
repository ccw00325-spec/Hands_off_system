import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { PersistentSession } from "../src/core/session.js";
import { authorizationURL, LoginFlow } from "../src/core/login-flow.js";
import { ClaudeConnection } from "../src/core/claude.js";
import { GrokProvider } from "../src/core/providers.js";

function memoryStore() {
  const values = new Map();
  return {
    read: async (key, fallback) => structuredClone(values.get(key) ?? fallback),
    write: async (key, value) => {
      values.set(key, structuredClone(value));
    },
  };
}
test("same installation persists sign-in policy and checks seven days without revoking CLI auth", async () => {
  let time = 1_800_000_000_000;
  const store = memoryStore();
  const one = new PersistentSession(store, () => time);
  const first = await one.open();
  await one.verified();
  assert.equal(first.firstLaunch, true);
  assert.equal(first.recheckRequired, false);
  time += 6 * 24 * 60 * 60 * 1000;
  const second = await new PersistentSession(store, () => time).open();
  assert.equal(second.deviceId, first.deviceId);
  assert.equal(second.recheckRequired, false);
  time += 8 * 24 * 60 * 60 * 1000;
  const three = new PersistentSession(store, () => time);
  const idle = await three.open();
  assert.equal(idle.recheckRequired, true);
  assert.equal(idle.policy, "recheck-and-reuse");
  const pending = await new PersistentSession(store, () => time).open();
  assert.equal(pending.recheckRequired, true);
  await three.verified();
  assert.equal(
    (await new PersistentSession(store, () => time).open()).recheckRequired,
    false,
  );
});
test("returning to a long-running idle app also marks connection recheck due", async () => {
  let time = 1_800_000_000_000;
  const session = new PersistentSession(memoryStore(), () => time);
  await session.open();
  await session.verified();
  time += 7 * 24 * 60 * 60 * 1000;
  await session.touch();
  assert.equal(session.state().recheckRequired, true);
});
test("cached Claude connection skips browser sign-in", async () => {
  let spawns = 0;
  const connection = new ClaudeConnection(() => {}, {
    spawn: () => {
      spawns++;
    },
  });
  connection.status = async () => ({ installed: true, connected: true });
  assert.equal((await connection.connect()).reused, true);
  assert.equal(spawns, 0);
});
test("Grok existing CLI login is verified with ACP metadata only; no session or prompt is sent", async () => {
  const requests = [];
  let spawns = 0;
  const provider = new GrokProvider(() => {}, {
    findExecutable: async () => "/official/grok",
    spawn: () => {
      spawns++;
    },
    rpcFactory: () => ({
      request: async (method, params) => {
        requests.push({ method, params });
        return method === "initialize"
          ? { authMethods: [{ id: "cached_token" }] }
          : {};
      },
      close() {},
    }),
  });
  const result = await provider.connect();
  assert.equal(result.reused, true);
  assert.equal(spawns, 0);
  assert.deepEqual(
    requests.map((row) => row.method),
    ["initialize", "authenticate"],
  );
  assert.equal(requests[1].params.methodId, "cached_token");
});
test("only official authorization links are accepted and credential-bearing URLs are rejected", () => {
  assert.ok(
    authorizationURL(
      "Open https://claude.ai/oauth/authorize?state=state&code_challenge=challenge",
      "claude",
    ),
  );
  assert.equal(
    authorizationURL("https://evil.example/oauth/authorize", "claude"),
    null,
  );
  assert.equal(
    authorizationURL(
      "https://claude.ai.evil.example/oauth/authorize",
      "claude",
    ),
    null,
  );
  assert.equal(
    authorizationURL(
      "https://claude.ai/oauth/authorize?access_token=secret",
      "claude",
    ),
    null,
  );
  assert.equal(
    authorizationURL("https://claude.ai/oauth/authorize", "grok"),
    null,
  );
});
test("CLI browser and code fallback remains ephemeral, exposes no URL and verifies completion once", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {};
  let submitted = "";
  child.stdin.on("data", (chunk) => {
    submitted += chunk.toString();
  });
  const events = [];
  const flow = new LoginFlow("claude", (event) => events.push(event), {
    spawn: () => child,
  });
  let verified = 0;
  flow.start("/official/claude", ["auth", "login"], async () => {
    verified++;
    return { connected: true };
  });
  child.stdout.write(
    "https://claude.ai/oauth/authorize?state=private-state\nPaste code here if prompted",
  );
  assert.equal(flow.state().hasBrowserLink, true);
  assert.equal(flow.state().codeRequired, true);
  assert.ok(!JSON.stringify(events).includes("private-state"));
  await assert.rejects(
    flow.openBrowser(async (url) => {
      assert.match(url, /claude\.ai/);
      throw new Error("test browser failure");
    }),
  );
  assert.throws(() => flow.code("a\nb"));
  flow.code("one-time-code");
  assert.equal(submitted, "one-time-code\n");
  child.emit("close", 0);
  child.emit("error", new Error("late error"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(verified, 1);
  assert.equal(flow.state().waiting, false);
  assert.equal(events.at(-1).state, "connected");
  assert.ok(!JSON.stringify(events).includes("one-time-code"));
});
