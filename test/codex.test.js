import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexConnection, codexExecArgs } from "../src/core/codex.js";

function mockServer() {
  return {
    closed: false,
    notify() {},
    close() {
      this.closed = true;
    },
    async request(method) {
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "account/login/start")
        return {
          loginId: "unit-login",
          authUrl: "https://auth.openai.com/authorize?state=unit",
        };
      if (method === "model/list")
        return {
          data: [
            {
              id: "row-id",
              model: "actual-model",
              displayName: "Available model",
              isDefault: true,
            },
          ],
        };
      return {};
    },
  };
}
test("native Codex uses official auth metadata, real model ids and cancels only its pending attempt", async () => {
  let opened;
  const rpc = mockServer();
  const connection = new CodexConnection("unused", () => {}, {
    find: async () => "/official/codex",
    rpcFactory: () => rpc,
    open: async (url) => {
      opened = url;
    },
  });
  assert.equal((await connection.connect()).reused, true);
  assert.equal(opened, undefined);
  assert.deepEqual(await connection.models(), [
    { id: "actual-model", name: "Available model", isDefault: true },
  ]);
  await connection.connect({ forceLogin: true });
  assert.equal(new URL(opened).hostname, "auth.openai.com");
  assert.equal(connection.login.state().waiting, true);
  await connection.cancel();
  assert.equal(connection.login.state().waiting, false);
  assert.equal((await connection.status({ force: true })).connected, true);
  connection.close();
});
test("native Codex rejects a lookalike auth URL without opening a browser", async () => {
  assert.throws(
    () => codexExecArgs("--dangerously-bypass-approvals-and-sandbox"),
    /모델 ID/,
  );
  assert.throws(() => codexExecArgs("model\n--flag"), /모델 ID/);
  const rpc = mockServer(),
    request = rpc.request;
  rpc.request = async (method) =>
    method === "account/login/start"
      ? {
          loginId: "bad",
          authUrl: "https://auth.openai.com.attacker.invalid/oauth",
        }
      : request(method);
  let opened = false;
  const connection = new CodexConnection("unused", () => {}, {
    find: async () => "/official/codex",
    rpcFactory: () => rpc,
    open: async () => {
      opened = true;
    },
  });
  await assert.rejects(connection.connect({ forceLogin: true }), /공식 Codex/);
  assert.equal(opened, false);
  connection.close();
});
test("two native GPT requests have independent empty working directories and retain auth without inherited API keys", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "cw-native-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const requests = [];
  function spawn(executable, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        requests.find((row) => row.child === child).prompt += chunk;
        callback();
      },
      final(callback) {
        setImmediate(() => {
          child.stdout.write(
            JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: '{"ok":true}' },
            }) + "\n",
          );
          child.stdout.write('{"type":"turn.completed"}\n');
          child.stdout.end();
          child.emit("close", 0);
        });
        callback();
      },
    });
    requests.push({ child, executable, args, options, prompt: "" });
    return child;
  }
  const connection = new CodexConnection(base, () => {}, {
    find: async () => "/official/codex",
    rpcFactory: mockServer,
    spawn,
  });
  const controller = new AbortController();
  const options = { gptModel: "actual-model" };
  const result = await Promise.all(
    ["grok", "claude"].map((agentId) =>
      connection.ask(
        "Return JSON",
        { snapshot: { root: "C:/approved-project", files: [] } },
        { ...options, agentId },
        controller.signal,
      ),
    ),
  );
  assert.deepEqual(result, [{ ok: true }, { ok: true }]);
  assert.notEqual(requests[0].options.cwd, requests[1].options.cwd);
  assert.deepEqual(await readdir(join(base, "sessions")), []);
  for (const row of requests) {
    assert.equal(row.options.shell, false);
    assert.ok(row.args.includes("--ephemeral"));
    assert.ok(row.args.includes("--ignore-user-config"));
    assert.ok(row.args.includes("--ignore-rules"));
    assert.ok(row.args.includes("read-only"));
    assert.ok(row.args.includes("actual-model"));
    assert.ok(!row.prompt.includes("C:/approved-project"));
    assert.ok(row.prompt.includes('"root":"."'));
    assert.ok(
      !Object.keys(row.options.env).some((key) =>
        /API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD/i.test(key),
      ),
    );
  }
  assert.ok(codexExecArgs().includes("shell_tool"));
  connection.close();
});
