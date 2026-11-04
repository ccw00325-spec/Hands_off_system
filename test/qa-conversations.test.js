import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { Projects } from "../src/core/projects.js";
import { Workspace, relativeFile } from "../src/core/workspace.js";
import { Preferences } from "../src/core/preferences.js";
import { Conversations } from "../src/core/conversations.js";
import { compileFunPlan } from "../src/core/fun-contract.js";
import { Workflow } from "../src/core/workflow.js";
import { roleProviders } from "../src/core/roles.js";
import { validateProject } from "../src/core/validation.js";
import { quotaWindows } from "../src/core/quota-view.js";
import { AgentChat } from "../src/core/agent-chat.js";
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "cw-qa-"));
  t.after(() =>
    rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
  );
  const root = join(base, "app");
  await mkdir(root);
  const store = new Store(join(base, "data"), {});
  await store.init();
  const projects = new Projects(store);
  const id = (await projects.list()).activeId;
  const workspace = new Workspace(projects);
  const ticket = await workspace.prepare(id, root);
  await workspace.consent(id, ticket.ticket, true);
  return { base, root, store, projects, workspace, id };
}
const team = [
  { id: "gpt", provider: "gpt", roles: ["control", "debug", "test"] },
  { id: "grok", provider: "gpt", roles: ["feature", "ui"] },
];
function plan() {
  return {
    contractVersion: 1,
    version: "1.0.0",
    questions: [],
    requirements: [
      {
        id: "R1",
        title: "Counter",
        context: "Loaded counter",
        trigger: "Read value",
        reaction: "Value equals 2",
        acceptanceCriteria: ["Counter returns 2"],
      },
    ],
    decisions: [],
    reviewItems: [],
    design: {
      screens: [
        { name: "Main", layout: "One counter", states: ["idle", "error"] },
      ],
      palette: ["mint on black"],
      spacing: "8px",
      typography: "system",
    },
    testPlan: {
      runner: "node-test",
      files: ["tests/counter.test.cjs"],
      cases: [
        {
          id: "T1",
          requirementId: "R1",
          type: "unit",
          title: "Counter equals 2",
          given: "Counter module loaded",
          when: "Read counter value",
          expected: "2",
          steps: ["Load counter.cjs", "Read value", "Compare to 2"],
        },
      ],
    },
    tasks: [
      {
        id: "impl",
        owner: "grok",
        kind: "feature",
        title: "Implement",
        instructions: "Export value 2",
        requirementIds: ["R1"],
        acceptanceCriteria: ["Value is 2"],
        dependsOn: [],
      },
      {
        id: "qa",
        owner: "gpt",
        kind: "test",
        title: "Test",
        instructions: "Verify T1 with node:test",
        requirementIds: ["R1"],
        acceptanceCriteria: ["T1 passed"],
        dependsOn: [],
      },
    ],
  };
}
test("project snapshots and direct paths cannot expose the app's conversation/auth storage", async (t) => {
  const f = await fixture(t);
  await f.store.write("private-conversation", { text: "local-only" });
  await assert.rejects(
    f.workspace.prepare(f.id, f.store.directory),
    /대화·인증/,
  );
  const ticket = await f.workspace.prepare(f.id, f.base);
  await f.workspace.consent(f.id, ticket.ticket, true);
  const snapshot = await f.workspace.snapshot(f.id);
  assert.equal(
    snapshot.files.some((file) => file.path.startsWith("data/")),
    false,
  );
  await assert.rejects(
    f.workspace.read(f.id, "data/private-conversation.json"),
    /대화·설정/,
  );
  await assert.rejects(
    f.workspace.write(f.id, "data/overwritten.json", "{}"),
    /대화·설정/,
  );
  assert.throws(() => relativeFile(".runtime/conversation.json"), /허용되지/);
});
test("execution consent is opt-in and cannot be copied to another OS identity", async (t) => {
  const f = await fixture(t);
  const prefs = new Preferences(f.store, async () => "A");
  const first = await prefs.get();
  assert.equal(first.allowExecution, false);
  assert.equal(first.onboardingComplete, false);
  await prefs.save({ ...first, allowExecution: true });
  assert.equal((await prefs.get()).allowExecution, true);
  assert.equal(
    (await new Preferences(f.store, async () => "B").get()).allowExecution,
    false,
  );
  await assert.rejects(prefs.save({ ...first, maxRepairRounds: 999 }));
});
test("folder-first project creation commits only after consent and refuses duplicate roots", async (t) => {
  const f = await fixture(t);
  const other = join(f.base, "other");
  await mkdir(other);
  const before = (await f.projects.list()).items.length;
  const ticket = await f.workspace.prepare(null, other);
  assert.equal((await f.projects.list()).items.length, before);
  await assert.rejects(f.workspace.consent(null, ticket.ticket, false));
  const accepted = await f.workspace.prepare(null, other);
  const data = await f.workspace.consent(null, accepted.ticket, true);
  assert.equal(data.items.length, before + 1);
  assert.equal(data.items.at(-1).title, "other");
  const duplicate = await f.workspace.prepare(null, other);
  await assert.rejects(
    f.workspace.consent(null, duplicate.ticket, true),
    /이미 프로젝트/,
  );
});
test("folder conversation history persists, isolates project/panel, and selects existing chats", async (t) => {
  const f = await fixture(t);
  const chats = new Conversations(f.store, f.projects);
  const a = await chats.create(f.id);
  await chats.append(f.id, a.id, "gpt", "user", "Create my timer");
  await chats.append(f.id, a.id, "grok", "assistant", "Feature notes");
  const b = await chats.create(f.id);
  await chats.select(f.id, a.id);
  const restored = new Conversations(f.store, new Projects(f.store));
  assert.equal((await restored.active(f.id)).id, a.id);
  assert.equal((await restored.read(f.id, a.id)).messages.length, 2);
  assert.equal((await restored.read(f.id, a.id)).title, "Create my timer");
  assert.equal((await restored.read(f.id, b.id)).messages.length, 0);
  const other = await f.projects.create("Other");
  await assert.rejects(restored.read(other.activeId, a.id), /이 프로젝트/);
  await assert.rejects(restored.read(f.id, "../../auth"));
});
test("QA checkbox requires coverage, reproducible cases, matching role and tests after implementation", () => {
  const value = compileFunPlan(plan(), { team });
  assert.deepEqual(value.tasks[1].dependsOn, ["impl"]);
  const missing = plan();
  delete missing.testPlan;
  assert.throws(() => compileFunPlan(missing, { team }), /테스트/);
  const wrong = plan();
  wrong.testPlan.cases[0].requirementId = "missing";
  assert.throws(() => compileFunPlan(wrong, { team }), /요구사항/);
  const escape = plan();
  escape.testPlan.files = ["../app.cjs"];
  assert.throws(() => compileFunPlan(escape, { team }));
  const parallel = plan();
  parallel.testPlan.files.push("tests/second.test.cjs");
  parallel.tasks[1].testFiles = ["tests/counter.test.cjs"];
  parallel.tasks.push({
    ...parallel.tasks[1],
    id: "qa-second",
    testFiles: ["tests/second.test.cjs"],
  });
  assert.equal(compileFunPlan(parallel, { team }).tasks.length, 3);
  parallel.tasks[2].testFiles = ["tests/counter.test.cjs"];
  assert.throws(() => compileFunPlan(parallel, { team }), /서로 다른/);
});
test("source changes during QA invalidate green results and interrupted tasks stop working", async (t) => {
  const f = await fixture(t);
  const provider = {
    ready: async () => true,
    plan: async () => plan(),
    build: async (c) => ({
      summary: "fixture",
      files: [
        {
          path:
            c.task.kind === "test" ? "tests/counter.test.cjs" : "counter.cjs",
          content: "// fixture",
        },
      ],
    }),
    review: async () => ({ summary: "fixture", issues: [] }),
  };
  const engine = new Workflow(
    f.workspace,
    roleProviders({ gpt: provider }),
    () => {},
    async () => {
      await f.workspace.write(
        f.id,
        "counter.cjs",
        "// externally changed during tests",
      );
      return {
        configured: true,
        passed: true,
        cases: [{ id: "T1", status: "passed" }],
      };
    },
  );
  await engine.start(f.id, {
    request: "Test source integrity",
    team,
    funContract: true,
    maxRepairRounds: 0,
    allowExecution: true,
  });
  await engine.runs.get(f.id).promise;
  const state = await engine.current(f.id);
  assert.equal(state.status, "awaiting_validation");
  assert.equal(state.testing.stale, true);
  assert.equal(state.testing.result.passed, false);
  provider.build = async () => {
    throw new Error("interrupted provider");
  };
  await engine.start(f.id, {
    request: "Interrupted build",
    team,
    funContract: true,
    maxRepairRounds: 0,
  });
  await engine.runs.get(f.id).promise;
  const interrupted = await engine.current(f.id);
  assert.equal(interrupted.status, "needs_attention");
  assert.equal(
    interrupted.tasks.some((task) => task.status === "working"),
    false,
  );
});
for (const permission of [false, true])
  test(
    "QA creates code, records actual TAP cases, and respects execution consent " +
      permission,
    async (t) => {
      const f = await fixture(t);
      let reviews = 0;
      const provider = {
        ready: async () => true,
        plan: async () => plan(),
        build: async (context) => ({
          summary: "Included fixture implementation",
          files:
            context.task.kind === "test"
              ? [
                  {
                    path: "tests/counter.test.cjs",
                    content:
                      "const {test}=require('node:test');const assert=require('node:assert/strict');test('T1 counter equals 2',()=>assert.equal(require('../counter.cjs').value,2));",
                  },
                ]
              : [{ path: "counter.cjs", content: "exports.value=2;" }],
        }),
        review: async () => {
          reviews++;
          return { summary: "Fixture review", issues: [] };
        },
      };
      const engine = new Workflow(
        f.workspace,
        roleProviders({ gpt: provider }),
        () => {},
        (context) => validateProject(f.workspace, context),
      );
      await engine.start(f.id, {
        request: "Build counter and verify it",
        team,
        funContract: true,
        maxRepairRounds: 0,
        allowExecution: permission,
      });
      await engine.runs.get(f.id).promise;
      let state = await engine.current(f.id);
      assert.equal(state.testing.plan.cases.length, 1);
      if (permission) {
        assert.equal(state.status, "completed");
        assert.equal(state.testing.result.cases[0].status, "passed");
        assert.match(state.testing.result.command, /node --test/);
      } else {
        assert.equal(state.status, "awaiting_validation");
        assert.equal(state.testing.status, "permission");
        const prior = reviews;
        await engine.revalidate(f.id, state.id, { allowExecution: true });
        await engine.runs.get(f.id).promise;
        state = await engine.current(f.id);
        assert.equal(state.status, "completed");
        assert.equal(reviews, prior);
      }
      const report = await f.workspace.read(
        f.id,
        `.control-tower/runs/${state.id}/test-report.md`,
        { internal: true },
      );
      assert.match(report.toString(), /T1: passed/);
      assert.match(report.toString(), /Load counter.cjs/);
    },
  );
test("QA role cannot rewrite app code to make tests pass", async (t) => {
  const f = await fixture(t);
  const provider = {
    ready: async () => true,
    plan: async () => plan(),
    build: async (context) => ({
      summary: "fixture",
      files: [
        {
          path: "counter.cjs",
          content:
            context.task.kind === "test"
              ? "exports.value=999;"
              : "exports.value=2;",
        },
      ],
    }),
    review: async () => ({ summary: "fixture", issues: [] }),
  };
  const engine = new Workflow(f.workspace, roleProviders({ gpt: provider }));
  await engine.start(f.id, {
    request: "Check counter",
    team,
    funContract: true,
    maxRepairRounds: 0,
  });
  await engine.runs.get(f.id).promise;
  assert.equal((await engine.current(f.id)).status, "needs_attention");
  assert.equal(
    await readFile(join(f.root, "counter.cjs"), "utf8"),
    "exports.value=2;",
  );
});
test("quota strip preserves 5h and weekly independently and never fabricates missing windows", () => {
  assert.equal(
    quotaWindows({
      meters: [
        { windowMinutes: 300, remainingPercent: 96 },
        { windowMinutes: 10080, remainingPercent: 43 },
      ],
    }).text,
    "96%/43%",
  );
  assert.equal(
    quotaWindows({ meters: [{ id: "weekly_all", remainingPercent: 3 }] }).text,
    "—/3%",
  );
  assert.equal(
    quotaWindows({
      meters: [{ id: "session", remainingPercent: 94, active: false }],
    }).text,
    "94%/—",
  );
  assert.equal(quotaWindows(null).text, "—/—");
});
test("test process exit 0 cannot pass missing or skipped planned cases", async (t) => {
  const f = await fixture(t);
  for (const [name, content] of [
    ["unmapped", "const {test}=require('node:test');test('Unrelated',()=>{});"],
    [
      "skipped",
      "const {test}=require('node:test');test.skip('T1 not run',()=>{});",
    ],
  ]) {
    await f.workspace.write(f.id, "tests/check.test.cjs", content);
    const result = await validateProject(f.workspace, {
      projectId: f.id,
      grantId: (await f.workspace.grant(f.id)).grantId,
      options: {
        allowExecution: true,
        testPlan: { ...plan().testPlan, files: ["tests/check.test.cjs"] },
      },
      signal: new AbortController().signal,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.passed, false);
    assert.equal(
      result.cases[0].status,
      name === "skipped" ? "skipped" : "not-observed",
    );
  }
});
test("worker questions preserve panel/conversation history and never bind unrelated previous runs", async (t) => {
  const f = await fixture(t);
  const conversations = new Conversations(f.store, f.projects);
  const one = await conversations.create(f.id);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const requests = [];
  const provider = {
    ready: async () => true,
    chat: async (context) => {
      requests.push(context);
      await pending;
      return { reply: "Read-only answer" };
    },
  };
  const workflow = {
    providers: roleProviders({ gpt: provider }),
    current: () => assert.fail("new conversation must not read prior run"),
    isActive: () => false,
  };
  const chat = new AgentChat({
    conversations,
    workspace: f.workspace,
    workflow,
    optionsFor: async () => ({ team }),
  });
  await chat.send(f.id, one.id, "grok", "Explain this module");
  await assert.rejects(chat.send(f.id, one.id, "grok", "Duplicate"), /응답 중/);
  const job = chat.pending.get(f.id + ":grok").promise;
  release();
  await job;
  assert.equal(requests[0].history.length, 0);
  assert.equal(requests[0].activity, null);
  assert.equal((await conversations.read(f.id, one.id)).messages.length, 2);
  const two = await conversations.create(f.id);
  await chat.send(f.id, two.id, "grok", "New topic");
  await chat.pending.get(f.id + ":grok").promise;
  assert.equal(requests[1].history.length, 0);
  assert.equal(
    (await conversations.read(f.id, two.id)).messages[1].content,
    "Read-only answer",
  );
});

test("Fun and mutation repair rerun only the assigned test task before completion", async (t) => {
  const f = await fixture(t);
  const manifest = { scripts: { "test:mutation": "node mock-mutation.cjs" } };
  await f.workspace.write(f.id, "package.json", JSON.stringify(manifest));
  await f.workspace.write(f.id, "mock-mutation.cjs", `
    const fs = require("node:fs");
    const repaired = fs.readFileSync("tests/counter.test.cjs", "utf8").includes("T1 exact");
    const mutants = [{
      status: repaired ? "Killed" : "Survived",
      location: { start: { line: 1, column: 1 } },
      mutatorName: "NumberLiteral",
      replacement: "3"
    }];
    fs.writeFileSync(process.env.TOWER_MUTATION_REPORT,
      JSON.stringify({files:{"counter.cjs":{mutants}}}));
  `);
  const builds = [];
  const provider = {
    ready: async () => true,
    plan: async () => plan(),
    build: async ({ task, issues }) => {
      builds.push(task.id);
      return {
        summary: "Fixture",
        files: task.kind === "test"
          ? [{path: "tests/counter.test.cjs", content:
            `require('node:test')('T1 ${issues.length ? "exact" : "smoke"}',()=>require('node:assert/strict').equal(require('../counter.cjs').value,2));`}]
          : [{path: "counter.cjs", content: "exports.value=2;"}],
      };
    },
    review: async ({ validation }) => ({
      summary: "Fixture review",
      issues: validation.mutation?.counts.Survived
        ? [{ taskId: "qa", owner: "gpt", mutationGap: true, description: "Assert the exact value" }]
        : [],
    }),
  };
  const engine = new Workflow(
    f.workspace,
    roleProviders({gpt: provider}),
    () => {},
    (context) => validateProject(f.workspace, context),
  );
  await engine.start(f.id, {
    request: "/fun Build a counter",
    team, funContract: true, mutation: true, maxRepairRounds: 1, allowExecution: true,
  });
  await engine.runs.get(f.id).promise;
  const state = await engine.current(f.id);
  assert.equal(state.status, "completed");
  assert.equal(state.mutation.counts.Killed, 1);
  assert.deepEqual(builds, ["impl", "qa", "qa"]);
});

test("a conflicted batch leaves every file untouched and checkpoint restore preserves external edits", async (t) => {
  const { applyBatch, restoreCheckpoint, listCheckpoints } = await import("../src/core/checkpoints.js");
  const { digest } = await import("../src/core/workspace.js");
  const f = await fixture(t);
  const grant = (await f.workspace.grant(f.id)).grantId;
  await f.workspace.write(f.id, "existing.js", "before");
  const change = [
    { path: "existing.js", baseHash: digest("before"), content: "after" },
    { path: "new.js", baseHash: null, content: "generated" },
  ];
  await f.workspace.write(f.id, "new.js", "external");
  await assert.rejects(applyBatch(f.workspace, f.id, grant, change, "fixture"), /외부/);
  assert.equal(String(await f.workspace.read(f.id, "existing.js")), "before");
  const id = await applyBatch(f.workspace, f.id, grant, [change[0], {
    path: "other.js", baseHash: null, content: "generated",
  }], "fixture");
  assert.equal((await listCheckpoints(f.workspace, f.id, grant))[0].id, id);
  const preview = await restoreCheckpoint(f.workspace, f.id, grant, id, null);
  assert.deepEqual(preview.preview.map((row) => row.action), ["restore", "delete"]);
  await f.workspace.write(f.id, "other.js", "user edit");
  assert.equal((await restoreCheckpoint(f.workspace, f.id, grant, id, preview.token)).id, null);
  assert.equal(String(await f.workspace.read(f.id, "existing.js")), "after");
  await f.workspace.write(f.id, "other.js", "generated");
  assert.ok((await restoreCheckpoint(f.workspace, f.id, grant, id, preview.token)).id);
  assert.equal(String(await f.workspace.read(f.id, "existing.js")), "before");
  await assert.rejects(f.workspace.read(f.id, "other.js"), { code: "ENOENT" });
});

test("cross-review blocks risky changes before writing and charges the reviewer call", async (t) => {
  const f = await fixture(t);
  const provider = {
    ready: async () => true,
    plan: async () => plan(),
    build: async () => ({ summary: "risk", files: [{ path: "auth.js", content: "export const enabled = true;" }] }),
    review: async (context) => {
      assert.deepEqual(context.validation.riskyPaths, ["auth.js"]);
      assert.ok(context.snapshot.files.some((file) => file.path === "auth.js"));
      await assert.rejects(f.workspace.read(f.id, "auth.js"), { code: "ENOENT" });
      context.options.onUsage(20, 5);
      return { summary: "blocked", issues: [{ owner: "grok", taskId: "impl", description: "missing auth check" }] };
    },
  };
  const engine = new Workflow(f.workspace, roleProviders({ gpt: provider }));
  await engine.start(f.id, {
    request: "Review auth", team, funContract: true, maxRepairRounds: 0, maxAgentCalls: 5, crossReview: true,
  });
  await engine.runs.get(f.id).promise;
  const state = await engine.current(f.id);
  assert.equal(state.status, "needs_attention");
  assert.equal(state.usage.calls, 3);
  assert.equal(state.usage.byPanel.gpt.input, 20);
  await assert.rejects(f.workspace.read(f.id, "auth.js"), { code: "ENOENT" });
});

test("API budget stops the next provider request after measured spending reaches the threshold", async (t) => {
  const f = await fixture(t);
  let builds = 0;
  const provider = {
    ready: async () => true,
    plan: async ({ options }) => {
      options.onUsage(1000, 1000, "priced");
      return plan();
    },
    build: async () => { builds++; },
  };
  const engine = new Workflow(f.workspace, roleProviders({gpt: provider}));
  await engine.start(f.id, {
    request: "Budget test", team, funContract: true, maxRepairRounds: 0,
    gptSource: "api", gptModel: "priced", apiRateModel: "priced",
    apiBudgetUsd: 0.01, apiInputRate: 10, apiOutputRate: 10,
  });
  await engine.runs.get(f.id).promise;
  const state = await engine.current(f.id);
  assert.equal(state.status, "needs_attention");
  assert.equal(state.usage.estimatedUsd, 0.02);
  assert.equal(state.usage.calls, 1);
  assert.equal(builds, 0);
});

test("recognized secrets are masked before planning and generated secrets are refused", async (t) => {
  const f = await fixture(t);
  const secret = "sk-" + "fixture0123456789abcdef";
  await f.workspace.write(f.id, "legacy.js", `const key = "${secret}";`);
  const provider = {
    ready: async () => true,
    plan: async ({ snapshot }) => {
      assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
      return plan();
    },
    build: async () => ({ summary: "fixture", files: [{ path: "leak.js", content: secret }] }),
  };
  const engine = new Workflow(f.workspace, roleProviders({gpt: provider}));
  await engine.start(f.id, { request: "Create a feature", team, funContract: true, maxRepairRounds: 0 });
  await engine.runs.get(f.id).promise;
  const state = await engine.current(f.id);
  assert.equal(state.status, "needs_attention");
  assert.match(state.events.at(-1).message, /비밀값 탐지/);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(secret));
  await assert.rejects(f.workspace.read(f.id, "leak.js"), { code: "ENOENT" });
});

test("batch rolls back earlier writes if a later file write fails", async (t) => {
  const { applyBatch } = await import("../src/core/checkpoints.js");
  const { digest } = await import("../src/core/workspace.js");
  const f = await fixture(t);
  const grant = (await f.workspace.grant(f.id)).grantId;
  await f.workspace.write(f.id, "existing.js", "before");
  const write = f.workspace.writeUnlocked.bind(f.workspace);
  f.workspace.writeUnlocked = (id, path, ...args) => {
    if (path === "blocked.js") throw new Error("injected write failure");
    return write(id, path, ...args);
  };
  await assert.rejects(applyBatch(f.workspace, f.id, grant, [
    { path: "existing.js", baseHash: digest("before"), content: "after" },
    { path: "blocked.js", baseHash: null, content: "new" },
  ], "fixture"), /injected write failure/);
  assert.equal(String(await f.workspace.read(f.id, "existing.js")), "before");
  await assert.rejects(f.workspace.read(f.id, "blocked.js"), { code: "ENOENT" });
});

test("verified rollback previews and restores multiple AI batches while preserving external edits", async (t) => {
  const { applyBatch, markVerified, restoreCheckpoint } = await import("../src/core/checkpoints.js");
  const { digest } = await import("../src/core/workspace.js");
  const f = await fixture(t);
  const grant = (await f.workspace.grant(f.id)).grantId;
  const run = "00000000-0000-0000-0000-000000000001";
  await f.workspace.write(f.id, "logic.js", "baseline");
  await f.workspace.write(f.id, "keep.js", "before");
  await markVerified(f.workspace, f.id, grant, await f.workspace.snapshot(f.id));
  await applyBatch(f.workspace, f.id, grant, [
    { path: "logic.js", baseHash: digest("baseline"), content: "first" },
  ], "first", [], run);
  await applyBatch(f.workspace, f.id, grant, [
    { path: "logic.js", baseHash: digest("first"), content: "second" },
    { path: "draft.js", baseHash: null, content: "new" },
  ], "second", [], run);
  const current = await restoreCheckpoint(f.workspace, f.id, grant, "run:" + run, null);
  assert.deepEqual(current.preview.map((row) => row.action), ["restore", "delete"]);
  const preview = await restoreCheckpoint(f.workspace, f.id, grant, "verified", null);
  assert.equal(preview.canRestore, true);
  await f.workspace.write(f.id, "keep.js", "manual edit");
  assert.equal((await restoreCheckpoint(f.workspace, f.id, grant, "verified", preview.token)).id, null);
  assert.equal(String(await f.workspace.read(f.id, "logic.js")), "second");
  await f.workspace.write(f.id, "keep.js", "before");
  assert.ok((await restoreCheckpoint(f.workspace, f.id, grant, "verified", preview.token)).id);
  assert.equal(String(await f.workspace.read(f.id, "logic.js")), "baseline");
  await assert.rejects(f.workspace.read(f.id, "draft.js"), { code: "ENOENT" });
});

test("failed assertions reach the implementation worker without rewriting the original test", async (t) => {
  const f = await fixture(t);
  const actions = [];
  const source = "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('T1 exact',()=>assert.equal(require('../counter.cjs').value,2));";
  const provider = {
    ready: async () => true, plan: async () => plan(),
    build: async ({ task, issues }) => {
      actions.push(task.id);
      if (task.kind === "test") return { summary: "test", files: [{ path: "tests/counter.test.cjs", content: source }] };
      if (issues.length) assert.match(issues[0].description, /T1/);
      return { summary: "feature", files: [{ path: "counter.cjs", content: issues.length ? "exports.value=2;" : "exports.value=1;" }] };
    },
    review: async () => ({ summary: "fixture", issues: [] }),
  };
  const engine = new Workflow(f.workspace, roleProviders({gpt: provider}), () => {},
    (context) => validateProject(f.workspace, context));
  await engine.start(f.id, { request: "Counter", team, funContract: true, maxRepairRounds: 2, allowExecution: true });
  await engine.runs.get(f.id).promise;
  const state = await engine.current(f.id);
  assert.equal(state.status, "completed");
  assert.equal(state.round, 1);
  assert.deepEqual(actions, ["impl", "qa", "impl"]);
  assert.equal(String(await f.workspace.read(f.id, "tests/counter.test.cjs")), source);
});

test("history can be archived, restored, exported with redaction and deleted within its project", async (t) => {
  const f = await fixture(t);
  const chats = new Conversations(f.store, f.projects);
  const chat = await chats.create(f.id, "History");
  const secret = "sk-" + "fixture0123456789abcdef";
  await chats.append(f.id, chat.id, "gpt", "user", "Value " + secret);
  const other = (await f.projects.create("Other")).activeId;
  await assert.rejects(chats.updateHistory(other, chat.id, "delete"));
  await chats.updateHistory(f.id, chat.id, "archive");
  assert.equal(await chats.active(f.id), null);
  await assert.rejects(chats.select(f.id, chat.id), /보관/);
  const markdown = await chats.markdown(f.id, chat.id, null);
  assert.match(markdown, /보호된 비밀값/);
  assert.ok(!markdown.includes(secret));
  await chats.updateHistory(f.id, chat.id, "restore");
  assert.equal((await chats.select(f.id, chat.id)).id, chat.id);
  await chats.updateHistory(f.id, chat.id, "delete");
  assert.equal(await f.store.read("conversation-" + chat.id, null), null);
  assert.equal(await chats.active(f.id), null);
});
