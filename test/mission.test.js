import test from "node:test";
import assert from "node:assert/strict";
import { missionState } from "../src/renderer/mission-state.js";

const team = [
  { id: "gpt", provider: "claude", roles: ["control", "test"] },
  { id: "grok", provider: "gpt", roles: ["feature", "ui"] },
];
function run(status, extra = {}) {
  return {
    status,
    spec: "requirements",
    options: { team },
    tasks: [
      {
        id: "save",
        title: "저장 기능",
        owner: "grok",
        kind: "feature",
        status: "reported",
        dependsOn: [],
      },
      {
        id: "screen",
        title: "목록 화면",
        owner: "grok",
        kind: "ui",
        status: "pending",
        dependsOn: ["save"],
      },
    ],
    ...extra,
  };
}
const phase = (state, id) => state.phases.find((row) => row.id === id);

test("mission nodes use frozen role assignments and actual task dependencies", () => {
  const state = missionState(run("building"));
  assert.equal(state.tasks[0].label, "GPT");
  assert.equal(state.tasks[0].state, "reported");
  assert.deepEqual(state.tasks[1].dependsOn, ["save"]);
  assert.equal(phase(state, "design").state, "skipped");
  assert.equal(state.done, false);
});
test("design waiting, failure and approval provide the right action without starting workers", () => {
  for (const status of ["pending", "generating", "ready", "error"]) {
    const state = missionState(run("awaiting_design", { design: { status } }));
    assert.equal(state.action.target, "design");
    assert.equal(state.done, false);
  }
  assert.equal(
    phase(
      missionState(run("building", { design: { status: "approved" } })),
      "design",
    ).state,
    "done",
  );
});
test("a reported implementation or stale validation cannot produce a completed mission", () => {
  assert.equal(missionState(run("completed")).done, false);
  assert.equal(
    missionState(
      run("completed", { validation: { passed: true, stale: true } }),
    ).done,
    false,
  );
  assert.equal(
    missionState(run("repairing", { validation: { passed: true } })).done,
    false,
  );
  assert.equal(
    missionState(
      run("completed", {
        validation: { passed: true },
        testing: { stale: true },
      }),
    ).done,
    false,
  );
  assert.equal(
    missionState(run("completed", { validation: { passed: true } })).done,
    true,
  );
});
test("mutation gaps, missing execution consent and restored checkpoints remain actionable", () => {
  const uncovered = missionState(
    run("awaiting_validation", {
      options: { team, mutation: true },
      validation: { passed: true },
      mutation: { passed: false, summary: "NoCoverage" },
    }),
  );
  assert.equal(uncovered.action.target, "testing");
  assert.equal(uncovered.action.detail, "NoCoverage");
  assert.equal(phase(uncovered, "testing").state, "error");
  const consent = missionState(
    run("awaiting_validation", {
      validation: { passed: false, requiresConsent: true },
    }),
  );
  assert.equal(consent.action.target, "settings");
  const restored = missionState(
    run("awaiting_validation", { validation: { passed: false, stale: true } }),
  );
  assert.equal(restored.done, false);
});
test("idle and interrupted sessions do not reuse task or completion state", () => {
  const idle = missionState(null);
  assert.deepEqual(idle.tasks, []);
  assert.ok(idle.phases.every((row) => row.state === "idle"));
  assert.equal(missionState(run("cancelled")).action.target, "checkpoints");
  assert.equal(
    missionState(run("needs_input", { questions: ["저장 위치는?"] })).action
      .detail,
    "저장 위치는?",
  );
});

test("provider and planning failures lead to real task output rather than a nonexistent test result", () => {
  const failed = missionState(
    run("needs_attention", {
      tasks: [
        {
          id: "worker",
          owner: "grok",
          kind: "feature",
          status: "failed",
          dependsOn: [],
        },
      ],
      events: [{ actor: "system", message: "공급자 연결이 종료됐습니다." }],
    }),
  );
  assert.equal(failed.action.target, "failed-output");
  assert.equal(failed.action.detail, "공급자 연결이 종료됐습니다.");
  assert.equal(failed.done, false);
  assert.equal(
    missionState(run("needs_attention", { tasks: [] })).action.target,
    "failed-output",
  );
});
