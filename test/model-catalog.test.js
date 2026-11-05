import test from "node:test";
import assert from "node:assert/strict";
import { ModelCatalog } from "../src/core/model-catalog.js";
test("startup loads all providers once and cache reads never trigger another discovery", async () => {
  let calls = 0;
  const loaders = Object.fromEntries(
    ["gpt", "claude", "grok", "gemini"].map((id) => [
      id,
      async () => {
        calls++;
        return [{ id: id + "-model", name: id }];
      },
    ]),
  );
  const catalog = new ModelCatalog(loaders),
    steps = [];
  await catalog.refreshAll((done) => steps.push(done));
  assert.equal(calls, 4);
  assert.deepEqual(steps, [1, 2, 3, 4]);
  for (let i = 0; i < 10; i++)
    for (const id of Object.keys(loaders))
      assert.equal(catalog.rows(id).length, 1);
  assert.equal(calls, 4);
  const rows = catalog.rows("gpt");
  rows[0].id = "modified";
  assert.equal(catalog.rows("gpt")[0].id, "gpt-model");
});
test("concurrent discovery shares a request and a failed provider does not reject startup", async () => {
  let calls = 0;
  const catalog = new ModelCatalog({
    gpt: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [{ id: "one" }];
    },
    claude: async () => [],
    grok: async () => {
      throw new Error("provider offline");
    },
    gemini: async () => ({
      rows: [],
      state: "login_required",
      message: "로그인 필요",
    }),
  });
  await Promise.all([catalog.refresh("gpt"), catalog.refresh("gpt")]);
  assert.equal(calls, 1);
  const state = await catalog.refreshAll();
  assert.equal(state.grok.state, "error");
  assert.equal(state.gemini.state, "login_required");
  assert.equal(state.gpt.state, "ready");
});
test("a hung model lookup times out and late completion never replaces the finished result", async () => {
  let finish;
  const pending = new Promise((resolve) => (finish = resolve)),
    catalog = new ModelCatalog({ gpt: () => pending }, { timeout: 10 });
  await catalog.refresh("gpt");
  assert.equal(catalog.snapshot().gpt.state, "error");
  finish([{ id: "too-late" }]);
  await Promise.resolve();
  assert.deepEqual(catalog.rows("gpt"), []);
});
test("account changes clear previous models and ignore an older in-flight catalog", async () => {
  let release,
    calls = 0;
  const catalog = new ModelCatalog({
    gpt: () =>
      ++calls === 1
        ? new Promise((resolve) => (release = resolve))
        : [{ id: "new-account-model" }],
  });
  const before = catalog.refresh("gpt");
  await Promise.resolve();
  catalog.invalidate("gpt");
  assert.deepEqual(catalog.rows("gpt"), []);
  await catalog.refresh("gpt");
  release([{ id: "old-account-model" }]);
  await before;
  assert.deepEqual(
    catalog.rows("gpt").map((row) => row.id),
    ["new-account-model"],
  );
});
test("untrusted model metadata cannot introduce execution flags or mutate public snapshots", async () => {
  const catalog = new ModelCatalog({
    gpt: async () => [
      { id: "--unsafe" },
      { id: "bad id" },
      { id: "safe", name: "<script>text only</script>" },
      { id: "safe" },
    ],
  });
  await catalog.refresh("gpt");
  assert.equal(catalog.rows("gpt").length, 1);
  const snapshot = catalog.snapshot();
  snapshot.gpt.rows = [];
  assert.equal(catalog.rows("gpt").length, 1);
});
