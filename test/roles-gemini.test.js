import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { Projects } from "../src/core/projects.js";
import {
  RoleAssignments,
  roleProviders,
  validateRoles,
} from "../src/core/roles.js";
import {
  GeminiConnection,
  geminiEnvironment,
  geminiModels,
} from "../src/core/gemini.js";
import { CursorConnection } from "../src/core/cursor.js";
import { authorizationURL, LoginFlow } from "../src/core/login-flow.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { planningInstructions } from "../src/core/providers.js";

test("role assignments are project-specific and unknown vendors or partial assignments are rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tower-roles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root, {});
  await store.init();
  const projects = new Projects(store);
  const first = (await projects.list()).activeId;
  const second = (await projects.create("second")).activeId;
  const roles = new RoleAssignments(projects);
  const selected = { gpt: "gemini", grok: "gpt", claude: "claude" };
  await roles.set(first, selected);
  assert.deepEqual(
    await new RoleAssignments(new Projects(store)).get(first),
    selected,
  );
  assert.deepEqual(await roles.get(second), {
    gpt: "gpt",
    grok: "grok",
    claude: "claude",
  });
  assert.throws(() => validateRoles({ gpt: "gemini" }));
  assert.throws(() => validateRoles({ ...selected, grok: "unknown" }));
  assert.throws(() => validateRoles({ ...selected, extra: "gpt" }));
});
test("each role calls the chosen AI, including planning, build and final review; unused vendors are not required", async () => {
  const calls = [];
  const registry = Object.fromEntries(
    ["gpt", "grok", "claude", "gemini"].map((provider) => [
      provider,
      Object.fromEntries(
        ["ready", "plan", "build", "review"].map((method) => [
          method,
          async () => {
            calls.push([provider, method]);
            return method === "ready" ? true : { summary: "fixture" };
          },
        ]),
      ),
    ]),
  );
  registry.grok.ready = () =>
    assert.fail("unassigned Cursor must not be required");
  const roles = roleProviders(registry);
  const options = { roles: { gpt: "gemini", grok: "gpt", claude: "claude" } };
  for (const role of ["gpt", "grok", "claude"])
    assert.equal(await roles[role].ready(options), true);
  await roles.gpt.plan({ options });
  await roles.grok.build({ options });
  await roles.claude.build({ options });
  for (const role of ["gpt", "grok", "claude"])
    await roles[role].review({ options });
  assert.deepEqual(
    calls.filter((row) => row[1] !== "ready"),
    [
      ["gemini", "plan"],
      ["gpt", "build"],
      ["claude", "build"],
      ["gemini", "review"],
      ["gpt", "review"],
      ["claude", "review"],
    ],
  );
  const next = { roles: { gpt: "claude", grok: "gemini", claude: "gpt" } };
  await roles.gpt.plan({ options: next });
  await roles.gpt.review({ options });
  assert.deepEqual(calls.slice(-2), [
    ["claude", "plan"],
    ["gemini", "review"],
  ]);
});
test("planner instructions retain original fun and explain stable role IDs independently of vendors", async () => {
  const prompt = await planningInstructions();
  assert.match(prompt, /Function = Context \+ Trigger/);
  assert.ok(prompt.includes("panel ids, never provider names"));
  assert.match(prompt, /Workers do not receive this skill/);
});
test("Gemini metadata checks never authenticate or open a new login and never copy native credentials", async () => {
  const calls = [];
  let closed = 0;
  const connection = new GeminiConnection("/app", () => {}, {
    authType: async () => "oauth-personal",
    find: async () => ({ executable: "node", prefix: ["official.js"] }),
    rpcFactory: (_exe, args, settings) => {
      assert.deepEqual(args.slice(0, 2), ["official.js", "--acp"]);
      assert.equal(args[args.indexOf("--extensions") + 1], "none");
      assert.match(
        args[args.indexOf("--allowed-mcp-server-names") + 1],
        /^cw-no-mcp-/,
      );
      assert.match(
        args[args.indexOf("--policy") + 1],
        /gemini-readonly\.toml$/,
      );
      assert.equal(settings.env.NO_BROWSER, "true");
      return {
        request: async (method) => {
          calls.push(method);
          if (method === "initialize")
            return { authMethods: [{ id: "oauth-personal" }] };
          return {
            models: {
              availableModels: [
                { modelId: "native-test", name: "Native fixture" },
              ],
            },
          };
        },
        close: () => {
          closed++;
        },
      };
    },
  });
  assert.equal((await connection.status()).connected, true);
  assert.deepEqual(await connection.models(), [
    { id: "native-test", name: "Native fixture" },
  ]);
  assert.deepEqual(calls, ["initialize", "session/new"]);
  assert.equal(closed, 1);
  assert.equal((await connection.connect()).reused, true);
  assert.equal(geminiEnvironment(true).NO_BROWSER, undefined);
  assert.deepEqual(geminiModels({}), []);
});
test("a native Gemini API key configuration is never presented as Google account login", async () => {
  const connection = new GeminiConnection("/app", () => {}, {
    find: async () => ({ executable: "node", prefix: ["official.js"] }),
    authType: async () => "gemini-api-key",
    rpcFactory: () => assert.fail("non-Google credentials must not be used"),
  });
  assert.equal((await connection.status()).connected, false);
  assert.equal((await connection.status()).installed, true);
});
test("Gemini explicit login authenticates with Google only, announces link and can cancel without logout", async () => {
  const events = [],
    requests = [];
  let output;
  const connection = new GeminiConnection(
    "/app",
    (event) => events.push(event),
    {
      find: async () => ({ executable: "node", prefix: ["official.js"] }),
      rpcFactory: (_exe, _args, settings) => {
        output = settings.onOutput;
        return {
          request: async (method) => {
            requests.push(method);
            if (method === "initialize")
              return { authMethods: [{ id: "oauth-personal" }] };
            if (method === "authenticate") {
              output(
                Buffer.from(
                  "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=private",
                ),
              );
              return new Promise(() => {});
            }
            return {};
          },
          close: () => {},
        };
      },
    },
  );
  connection.status = async () => ({ installed: true, connected: false });
  assert.equal((await connection.connect()).waiting, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.loginState().hasBrowserLink, true);
  let opened = "";
  await connection.login.openBrowser(async (url) => {
    opened = url;
  });
  assert.match(opened, /accounts.google.com/);
  assert.ok(!JSON.stringify(events).includes("state=private"));
  connection.cancel();
  assert.equal(connection.loginState().waiting, false);
  assert.deepEqual(requests, ["initialize", "authenticate"]);
});
test("Cursor login button can launch official browser even when native login is already present", async () => {
  let seen;
  const connection = new CursorConnection(() => {}, {
    open: async () => {},
    find: async () => ({ executable: "node", prefix: ["official.js"] }),
    spawn: () => assert.fail("test must intercept login start"),
  });
  connection.status = async () => ({ connected: true });
  connection.login.start = (exe, args, verify, options) => {
    seen = { exe, args, verify, options };
    return { waiting: true };
  };
  assert.equal((await connection.connect({ forceLogin: true })).waiting, true);
  assert.deepEqual(seen.args, ["official.js", "login"]);
  assert.equal(seen.options.env.NO_OPEN_BROWSER, "1");
  assert.equal(typeof seen.options.open, "function");
});
test("cancelling Gemini while ACP initializes prevents a later authentication request", async () => {
  let initialize;
  const calls = [];
  const connection = new GeminiConnection("/app", () => {}, {
    find: async () => ({ executable: "node", prefix: ["official.js"] }),
    rpcFactory: () => ({
      request: async (method) => {
        calls.push(method);
        return new Promise((resolve) => {
          initialize = resolve;
        });
      },
      close: () => {},
    }),
  });
  connection.status = async () => ({ installed: true, connected: false });
  await connection.connect();
  await new Promise((resolve) => setImmediate(resolve));
  connection.cancel();
  initialize({ authMethods: [{ id: "oauth-personal" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["initialize"]);
  assert.equal(connection.loginState().waiting, false);
});
test("Cursor official URL opens once through the selected browser and browser failure remains retryable", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const opened = [];
  const flow = new LoginFlow("cursor", () => {}, { spawn: () => child });
  flow.start("node", ["login"], async () => ({ connected: true }), {
    open: async (url) => opened.push(url),
  });
  const url = "https://cursor.com/loginDeepControl?challenge=fixture";
  child.stdout.write(url + "\n");
  child.stdout.write(url + "\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, [url]);
  assert.equal(flow.state().hasBrowserLink, true);
  flow.cancel();
  assert.equal(
    authorizationURL(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture",
      "gemini",
    )?.startsWith("https://accounts.google.com/"),
    true,
  );
});
