import test from "node:test";
import assert from "node:assert/strict";
import { mascotState } from "../src/renderer/mascot.js";
const base = {
  id: "fixture",
  status: "building",
  options: { roles: { gpt: "gemini", grok: "gpt", claude: "claude" } },
  events: [],
};
test("mascot remains idle without a run and never invents progress from an ordinary file event", () => {
  assert.equal(mascotState(null).state, "idle");
  assert.equal(mascotState(null).handoff, null);
  assert.equal(
    mascotState({
      ...base,
      events: [{ actor: "grok", taskId: "logic", path: "app.js", at: "test" }],
    }).handoff,
    null,
  );
});
test("parcel routing follows actual dispatch/report events and the run-frozen AI assignments", () => {
  const dispatched = mascotState(
    {
      ...base,
      events: [
        { actor: "grok", taskId: "logic", activity: "dispatch", at: "one" },
      ],
    },
    { gpt: "claude", grok: "gemini", claude: "gpt" },
  );
  assert.deepEqual(dispatched.handoff, {
    key: "fixture:one:dispatch:logic",
    from: "gpt",
    to: "grok",
  });
  assert.equal(dispatched.labels.gpt, "컨트롤 타워 · Gemini");
  assert.equal(dispatched.labels.grok, "기능 구현 · GPT");
  const reported = mascotState({
    ...base,
    status: "validating",
    events: [
      { actor: "claude", taskId: "connect", activity: "report", at: "two" },
    ],
  });
  assert.deepEqual(reported.handoff, {
    key: "fixture:two:report:connect",
    from: "claude",
    to: "gpt",
  });
  assert.equal(reported.state, "checking");
});
test("code-review success without execution validation is waiting, never completed", () => {
  assert.equal(
    mascotState({ ...base, status: "awaiting_validation" }).state,
    "waiting",
  );
  assert.match(
    mascotState({ ...base, status: "awaiting_validation" }).message,
    /실행 검증/,
  );
  assert.equal(mascotState({ ...base, status: "completed" }).state, "done");
});
test("cancelled, failed, interrupted and completed runs cannot keep delivering stale parcels", () => {
  for (const status of [
    "cancelled",
    "needs_attention",
    "interrupted",
    "completed",
    "needs_input",
  ]) {
    const view = mascotState({
      ...base,
      status,
      events: [
        { actor: "grok", taskId: "logic", activity: "dispatch", at: "one" },
      ],
    });
    assert.equal(view.handoff, null);
  }
  assert.equal(
    mascotState({ ...base, status: "needs_attention" }).state,
    "error",
  );
});
