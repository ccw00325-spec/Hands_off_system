import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.js";
import { Projects } from "../src/core/projects.js";
import { Workspace } from "../src/core/workspace.js";
import { validateProject } from "../src/core/validation.js";
async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), "tower-validation-"));
  t.after(() =>
    rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
  );
  const root = join(base, "project");
  await mkdir(root);
  const store = new Store(join(base, "data"), {});
  await store.init();
  const projects = new Projects(store),
    id = (await projects.list()).activeId,
    workspace = new Workspace(projects);
  const pending = await workspace.prepare(id, root);
  await workspace.consent(id, pending.ticket, true);
  const grant = await workspace.grant(id);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      scripts: {
        pass: "node pass.cjs",
        fail: "node fail.cjs",
        wait: "node wait.cjs",
      },
    }),
  );
  await writeFile(join(root, "pass.cjs"), 'console.log("checked")');
  await writeFile(join(root, "fail.cjs"), "process.exit(1)");
  await writeFile(
    join(root, "wait.cjs"),
    'setTimeout(()=>require("node:fs").writeFileSync("should-not-exist.txt","late"), 3000)',
  );
  return { workspace, root, projectId: id, grantId: grant.grantId };
}
test("validation runs only the user-selected npm script after explicit execution consent", async (t) => {
  const f = await setup(t),
    signal = new AbortController().signal;
  const denied = await validateProject(f.workspace, {
    ...f,
    signal,
    options: { validationScript: "pass", allowExecution: false },
  });
  assert.equal(denied.passed, false);
  assert.equal(denied.requiresConsent, true);
  const pass = await validateProject(f.workspace, {
    ...f,
    signal,
    options: { validationScript: "pass", allowExecution: true },
  });
  assert.equal(pass.passed, true);
  assert.match(pass.output, /checked/);
  const fail = await validateProject(f.workspace, {
    ...f,
    signal,
    options: { validationScript: "fail", allowExecution: true },
  });
  assert.equal(fail.passed, false);
  await assert.rejects(
    validateProject(f.workspace, {
      ...f,
      signal,
      options: { validationScript: "test & echo unsafe", allowExecution: true },
    }),
  );
});
test("cancelling validation terminates its npm process tree", async (t) => {
  const f = await setup(t),
    controller = new AbortController();
  const running = validateProject(f.workspace, {
    ...f,
    signal: controller.signal,
    options: { validationScript: "wait", allowExecution: true },
  });
  const timer = setTimeout(() => controller.abort(), 900);
  t.after(() => clearTimeout(timer));
  await assert.rejects(running, /중지/);
  await assert.rejects(readFile(join(f.root, "should-not-exist.txt")), {
    code: "ENOENT",
  });
});

test("mutation uses a fresh report and separates uncovered mutants from passing checks", async (t) => {
  const f = await setup(t);
  const { runMutation } = await import("../src/core/mutation.js");
  const file = join(f.root, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.scripts["test:mutation"] = "node mutation-fixture.cjs";
  await writeFile(file, JSON.stringify(manifest));
  const context = {
    ...f,
    signal: new AbortController().signal,
    options: { allowExecution: true },
  };
  await writeFile(join(f.root, "mutation-fixture.cjs"), "");
  assert.equal((await runMutation(f.workspace, context)).status, "blocked");
  const mutant = (status) => ({
    status, location: { start: { line: 3, column: 1 } },
    mutatorName: "EqualityOperator", replacement: "<=",
  });
  async function execute(status, replacement = "<=") {
    const report = { files: { "domain.js": { mutants: [{ ...mutant(status), replacement }] } } };
    await writeFile(
      join(f.root, "mutation-fixture.cjs"),
      `require("node:fs").writeFileSync(process.env.TOWER_MUTATION_REPORT, ${JSON.stringify(JSON.stringify(report))});`,
    );
    return runMutation(f.workspace, context);
  }
  const uncovered = await execute("NoCoverage");
  assert.equal(uncovered.passed, false);
  assert.equal(uncovered.counts.NoCoverage, 1);
  const killed = await execute("Killed");
  assert.equal(killed.passed, true);
  assert.equal(killed.scopeHash, uncovered.scopeHash);
  assert.notEqual(killed.reportPath, uncovered.reportPath);
  const secret = "sbp_" + "x".repeat(40);
  const invalid = await execute(secret, secret);
  assert.equal(invalid.counts.Unknown, 1);
  assert.equal(invalid.passed, false);
  assert.ok(!JSON.stringify(invalid).includes(secret));
});

test("validation masks dotenv values and split key output before events and persistence", async (t) => {
  const f = await setup(t);
  const value = "fixture-value-from-dotenv";
  const key = "sk-" + "fixture0123456789abcdef";
  await writeFile(join(f.root, ".env"), "CUSTOM_VALUE=" + value);
  await writeFile(join(f.root, "pass.cjs"), `
    process.stdout.write(${JSON.stringify(key.slice(0, 16))});
    setTimeout(() => console.log(${JSON.stringify(key.slice(16))}, ${JSON.stringify(value)}), 25);
  `);
  const events = [];
  const result = await validateProject(f.workspace, {
    ...f,
    signal: new AbortController().signal,
    options: { validationScript: "pass", allowExecution: true },
    onOutput: (event) => events.push(event),
  });
  assert.equal(result.passed, true);
  assert.match(result.output, /보호된 비밀값/);
  for (const secret of [value, key, key.slice(16)])
    assert.equal(JSON.stringify({ result, events }).includes(secret), false);
});
