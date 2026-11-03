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
