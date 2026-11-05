import test from "node:test";
import assert from "node:assert/strict";
import { validateTeam, teamFor, resizeTeam } from "../src/core/team.js";
import { roleProviders } from "../src/core/roles.js";
import {
  isQuotaExhausted,
  providerFailure,
} from "../src/core/provider-errors.js";
import { Workflow } from "../src/core/workflow.js";
import { AgentChat } from "../src/core/agent-chat.js";
import { readResponseStream } from "../src/core/providers.js";

const team = () => [
  { id: "gpt", provider: "gpt", roles: ["control", "review"] },
  {
    id: "grok",
    provider: "gemini",
    roles: ["feature", "ui"],
    modelId: "primary",
    fallback: { provider: "claude", modelId: "backup" },
  },
];
const quota = () =>
  providerFailure("gemini", { code: "usage_limit_reached" }, "한도 소진");
test("fallback config survives normalization and resize without accepting identical routes or injected model flags", () => {
  assert.deepEqual(validateTeam(team()), team());
  assert.deepEqual(resizeTeam(team(), 4)[1].fallback, team()[1].fallback);
  const value = team();
  value[1].fallback = { provider: "gemini", modelId: "primary" };
  assert.throws(() => validateTeam(value));
  value[1].fallback = { provider: "claude", modelId: "--unsafe" };
  assert.throws(() => validateTeam(value));
  assert.throws(() =>
    teamFor({ team: team(), runtimeRoutes: { grok: { provider: "gpt" } } }),
  );
});
test("quota envelopes are recognized; rate limits, auth, context length, network and model text are not generic exhaustion", () => {
  for (const detail of [
    { code: "insufficient_quota" },
    { rpcMessage: "Daily quota exceeded" },
    { message: "You've hit your usage limit" },
    { rpcData: { reason: "quota_exhausted" } },
  ])
    assert.equal(isQuotaExhausted(detail), true);
  for (const detail of [
    { code: "rate_limit_exceeded" },
    { message: "429 Too many requests, retry later" },
    { code: "unauthorized" },
    { message: "context window token limit exceeded" },
    { message: "network timeout" },
  ])
    assert.equal(isQuotaExhausted(detail), false);
});
for (const action of ["plan", "build", "review", "chat"])
  test(`${action}: quota reroutes only the failed request, preserves context and keeps subsequent calls on the selected backup`, async () => {
    const options = { team: team() },
      context = {
        options,
        signal: new AbortController().signal,
        task: { id: "one", owner: "grok" },
        snapshot: { files: [{ path: "app.js", content: "original" }] },
        spec: "fixed criteria",
        history: [{ content: "previous" }],
      };
    let primary = 0,
      backup = 0,
      switches = 0;
    options.onProviderSwitch = () => switches++;
    const providers = roleProviders({
      gemini: {
        [action]: async () => {
          primary++;
          throw quota();
        },
      },
      claude: {
        ready: async (o) => {
          assert.equal(o.claudeModel, "backup");
          return true;
        },
        [action]: async (c) => {
          backup++;
          assert.equal(c.task, context.task);
          assert.equal(c.snapshot, context.snapshot);
          assert.equal(c.spec, "fixed criteria");
          assert.deepEqual(c.history, context.history);
          assert.equal(c.options.agentId, "grok");
          return { summary: "actual backup", reply: "answer" };
        },
      },
    });
    await providers.grok[action](context);
    await providers.grok[action](context);
    assert.equal(primary, 1);
    assert.equal(backup, 2);
    assert.equal(switches, 1);
    assert.equal(teamFor(options)[1].provider, "claude");
    assert.equal(teamFor(options)[0].provider, "gpt");
    assert.equal(options.team[1].provider, "gemini");
  });
test("auth errors never fail over; unavailable and exhausted backups stop without loops", async () => {
  let backup = 0;
  const config = {
    gemini: {
      build: async () => {
        throw new Error("authentication expired");
      },
    },
    claude: { ready: async () => true, build: async () => backup++ },
  };
  await assert.rejects(
    roleProviders(config).grok.build({
      options: { team: team() },
      signal: new AbortController().signal,
    }),
    /authentication/,
  );
  assert.equal(backup, 0);
  config.gemini.build = async () => {
    throw quota();
  };
  config.claude.ready = async () => false;
  await assert.rejects(
    roleProviders(config).grok.build({ options: { team: team() } }),
    /로그인|모델/,
  );
  assert.equal(backup, 0);
  config.claude.ready = async () => true;
  config.claude.build = async () => {
    backup++;
    throw quota();
  };
  await assert.rejects(
    roleProviders(config).grok.build({ options: { team: team() } }),
    /한도/,
  );
  assert.equal(backup, 1);
});
test("workflow counts failed and replacement attempts, emits provider history and preserves task identity", async () => {
  const options = { team: team(), maxAgentCalls: 4 },
    events = [];
  const engine = new Workflow(
    {},
    roleProviders({
      gemini: {
        build: async () => {
          throw quota();
        },
      },
      claude: {
        ready: async () => true,
        build: async (c) => ({ summary: c.task.id, executedProvider: "gpt" }),
      },
    }),
  );
  engine.record = async (_run, _actor, _message, details) =>
    events.push(details);
  const run = { state: { projectId: "p", options } },
    task = { id: "owned-task", owner: "grok" };
  const result = await engine.callAgent(run, "grok", "build", {
    task,
    options,
    snapshot: { files: [] },
    signal: new AbortController().signal,
  });
  assert.equal(result.summary, task.id);
  assert.equal(run.state.usage.calls, 2);
  assert.deepEqual(run.state.usage.byPanel.grok.providers, {
    gemini: 1,
    claude: 1,
  });
  assert.equal(events[0].activity, "fallback");
  assert.equal(events[0].taskId, task.id);
  assert.equal(events[0].provider, "claude");
  assert.equal(result.executedProvider, "claude");
});
test("replacement attempt obeys call and API price budgets before sending the paid request", async () => {
  const value = team();
  value[1].fallback = { provider: "gpt", modelId: "paid" };
  let paid = 0;
  const engine = new Workflow(
    {},
    roleProviders({
      gemini: {
        build: async () => {
          throw quota();
        },
      },
      gpt: {
        ready: async () => true,
        build: async () => {
          paid++;
          return { summary: "paid" };
        },
      },
    }),
  );
  engine.record = async () => {};
  for (const extra of [
    { maxAgentCalls: 1 },
    {
      maxAgentCalls: 10,
      gptSource: "api",
      apiBudgetUsd: 1,
      apiRateModel: "different",
    },
  ]) {
    const options = { team: value, ...extra },
      run = { state: { projectId: "p", options } };
    await assert.rejects(
      engine.callAgent(run, "grok", "build", {
        options,
        snapshot: { files: [] },
        signal: new AbortController().signal,
      }),
      /한도|단가/,
    );
  }
  assert.equal(paid, 0);
});
test("readiness quota exhaustion selects the registered backup without bypassing authentication failures", async () => {
  let primary = 0;
  const options = { team: team() },
    providers = roleProviders({
      gemini: {
        ready: async () => {
          primary++;
          throw quota();
        },
      },
      claude: { ready: async () => true },
    });
  assert.equal(await providers.grok.ready(options), true);
  assert.equal(options.runtimeRoutes.grok.provider, "claude");
  assert.equal(options.preflightSwitches.length, 1);
  assert.equal(await providers.grok.ready(options), true);
  assert.equal(primary, 1);
  const auth = roleProviders({
    gemini: {
      ready: async () => {
        throw new Error("authentication expired");
      },
    },
    claude: { ready: async () => true },
  });
  await assert.rejects(auth.grok.ready({ team: team() }), /authentication/);
});
test("aborting during backup readiness prevents any route change or replacement request", async () => {
  const abort = new AbortController();
  let resolveReady,
    enteredReady,
    switched = 0,
    called = 0;
  const pendingReady = new Promise((resolve) => (resolveReady = resolve));
  const startedReady = new Promise((resolve) => (enteredReady = resolve));
  const providers = roleProviders({
    gemini: {
      build: async () => {
        throw quota();
      },
    },
    claude: {
      ready: async () => {
        enteredReady();
        return pendingReady;
      },
      build: async () => called++,
    },
  });
  const promise = providers.grok.build({
    options: { team: team(), onProviderSwitch: () => switched++ },
    signal: abort.signal,
  });
  await startedReady;
  abort.abort();
  resolveReady(true);
  await assert.rejects(promise, /abort/i);
  assert.equal(switched, 0);
  assert.equal(called, 0);
});
test("HTTP quota and rate-limit responses keep distinct typed errors for the routing layer", async () => {
  await assert.rejects(readResponseStream(new Response(JSON.stringify({error:{code:"insufficient_quota"}}),{status:401})), error => !error.quotaExhausted);
  assert.equal(isQuotaExhausted({code:"rate_limit_exceeded",message:"Token quota limit exceeded, please retry"}),false);
  assert.equal(isQuotaExhausted({message:"Quota exceeded for RequestsPerMinute"}),false);
  await assert.rejects(
    readResponseStream(
      new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), {
        status: 429,
      }),
    ),
    (error) => error.quotaExhausted === true,
  );
  await assert.rejects(
    readResponseStream(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
        status: 429,
      }),
    ),
    (error) => !error.quotaExhausted,
  );
  assert.equal(
    isQuotaExhausted({
      rpcMessage: "You have exhausted your daily quota on this model.",
    }),
    true,
  );
  assert.equal(
    isQuotaExhausted({
      message: "HTTP 401 unauthorized: insufficient permission for quota",
    }),
    false,
  );
});
test("questions keep a completed run's actual backup; a new work run starts a separate routing context", async () => {
  const cfg = team(),
    conversation = {
      id: "c",
      runId: "r1",
      messages: [],
      routing: { teamKey: JSON.stringify(cfg), runtimeRoutes: {} },
    };
  let primary = 0,
    backup = 0;
  const workspace = {
    grant: async () => ({}),
    snapshot: async () => ({ root: ".", files: [] }),
  };
  const engine = new Workflow(
    workspace,
    roleProviders({
      gemini: {
        ready: async () => true,
        chat: async () => {
          primary++;
          return { reply: "primary" };
        },
      },
      claude: {
        ready: async () => true,
        chat: async () => {
          backup++;
          return { reply: "backup" };
        },
      },
    }),
  );
  const state = {
    status: "completed",
    tasks: [],
    options: {
      team: cfg,
      runtimeRoutes: { grok: { provider: "claude", modelId: "backup" } },
    },
  };
  engine.current = async () => state;
  const conversations = {
    read: async () => conversation,
    append: async (_p, _c, agentId, role, content, _status, meta) => {
      const message = { agentId, role, content, provider: meta?.provider };
      conversation.messages.push(message);
      return message;
    },
    setRouting: async (_p, _c, options, usage) => {
      conversation.routing = {
        teamKey: JSON.stringify(cfg),
        runtimeRoutes: structuredClone(options.runtimeRoutes ?? {}),
        usage,
      };
    },
  };
  const chat = new AgentChat({
    workspace,
    workflow: engine,
    conversations,
    optionsFor: async () => ({ team: cfg }),
  });
  await chat.send("p", "c", "grok", "question");
  await chat.pending.get("p:grok").promise;
  assert.equal(primary, 0);
  assert.equal(backup, 1);
  assert.equal(conversation.messages.at(-1).provider, "claude");
  conversation.runId = "r2";
  conversation.routing = { teamKey: JSON.stringify(cfg), runtimeRoutes: {} };
  state.options = { team: cfg };
  await chat.send("p", "c", "grok", "new run question");
  await chat.pending.get("p:grok").promise;
  assert.equal(primary, 1);
  assert.equal(backup, 1);
  assert.equal(conversation.messages.at(-1).provider, "gemini");
});
