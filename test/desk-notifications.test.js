import test from "node:test";
import assert from "node:assert/strict";
import { NotificationInbox } from "../src/core/notifications.js";
import { displayedTeam, agentRows } from "../src/renderer/desk-state.js";

const configured = () => [
  { id: "gpt", provider: "gpt", roles: ["control"] },
  {
    id: "grok",
    provider: "gemini",
    roles: ["feature", "ui"],
    fallback: { provider: "claude", modelId: "backup" },
  },
];
test("desk logo follows the actual backup and retains source attribution on earlier tasks", () => {
  const team = configured(),
    run = {
      status: "building",
      options: {
        team,
        runtimeRoutes: { grok: { provider: "claude", modelId: "backup" } },
      },
      tasks: [
        {
          id: "one",
          owner: "grok",
          title: "검색",
          status: "reported",
          executedProvider: "gemini",
        },
        { id: "two", owner: "grok", title: "통계", status: "working" },
      ],
    };
  const displayed = displayedTeam(run, team);
  assert.equal(displayed[1].provider, "claude");
  assert.equal(displayed[1].usingFallback, true);
  const rows = agentRows(run, displayed, { claude: { connected: true } });
  assert.equal(rows[1].tasks[0].provider, "gemini");
  assert.equal(rows[1].tasks[0].label, "구현 완료");
  assert.equal(rows[1].tasks[1].label, "진행 중");
  assert.equal(rows[1].connected, true);
});
test("active roles stay frozen; saved changes become next targets after work without masquerading as quota failover", () => {
  const team = configured(),
    changed = structuredClone(team);
  changed[1].provider = "gpt";
  const run = { status: "building", options: { team } };
  assert.equal(displayedTeam(run, changed)[1].provider, "gemini");
  run.status = "completed";
  assert.equal(displayedTeam(run, changed)[1].provider, "gpt");
  assert.equal(displayedTeam(run, changed)[1].usingFallback, undefined);
  const conversation = {
    routing: {
      teamKey: JSON.stringify(team),
      runtimeRoutes: { grok: { provider: "claude", modelId: "backup" } },
    },
  };
  assert.equal(displayedTeam(null, team, conversation)[1].provider, "claude");
  assert.equal(displayedTeam(null, changed, conversation)[1].provider, "gpt");
});
test("recent task history keeps completed/current items, collapses older jobs and never greenlights a stale result", () => {
  const run = {
    status: "completed",
    options: { team: configured() },
    spec: "requirements",
    validation: { passed: true, stale: true },
    tasks: Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
      title: "Task " + i,
      owner: "grok",
      status: i === 3 ? "working" : "reported",
    })),
  };
  const rows = agentRows(run, configured());
  assert.equal(rows[1].tasks.length, 6);
  assert.equal(rows[1].older.length, 3);
  assert.ok(rows[1].recent.some((t) => t.id === "3"));
  assert.ok(rows[0].tasks.some((task) => task.label === "재검증 필요"));
  assert.notEqual(rows[1].tasks[0].label, "완료");
});
class MemoryStore {
  constructor() {
    this.data = {};
  }
  async read(key, fallback) {
    return structuredClone(this.data[key] ?? fallback);
  }
  async write(key, value) {
    this.data[key] = structuredClone(value);
  }
}
test("notification history survives reload, serializes adds/deletes, redacts secrets and restricts actions", async () => {
  const store = new MemoryStore(),
    inbox = new NotificationInbox(store),
    secret = "sk-" + "A".repeat(44);
  await Promise.all([
    inbox.add({
      message: "first",
      key: "one",
      action: "workflow",
      projectId: "p",
    }),
    inbox.add({
      message: "key=" + secret,
      key: "two",
      action: "javascript:alert(1)",
    }),
  ]);
  const items = await new NotificationInbox(store).list();
  assert.equal(items.length, 2);
  assert.ok(!items[0].message.includes(secret));
  assert.equal(items[0].action, undefined);
  await inbox.add({ message: "duplicate", key: "one" });
  assert.equal((await inbox.list()).length, 2);
  await inbox.markRead();
  assert.ok((await inbox.list()).every((item) => item.read));
  await Promise.all([
    inbox.remove(items[0].id),
    inbox.add({ message: "third", key: "three" }),
  ]);
  assert.equal((await inbox.list()).length, 2);
  await inbox.clear();
  assert.deepEqual(await inbox.list(), []);
  assert.deepEqual(Object.keys(store.data), ["notifications"]);
  await new NotificationInbox(store).add({
    message: "replayed old event",
    key: "one",
  });
  assert.deepEqual(await inbox.list(), []);
});
