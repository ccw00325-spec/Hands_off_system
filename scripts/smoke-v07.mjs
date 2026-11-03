import { _electron as electron } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const artifacts = resolve("artifacts");
await mkdir(artifacts, { recursive: true });
const profile = join(artifacts, "smoke-v07-profile-" + Date.now()),
  root = join(artifacts, "smoke-v07-workspace-" + Date.now());
await mkdir(root);
const env = { ...process.env, TOWER_TEST_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
let application;
const errors = [];
async function boot() {
  application = await electron.launch({ args: ["."], cwd: resolve("."), env });
  const page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .locator("#session-status[data-restoring=false]")
    .waitFor({ state: "attached", timeout: 90000 });
  return page;
}
try {
  let page = await boot();
  await page.locator("#settings-dialog[open]").waitFor();
  assert.equal(await page.locator("#allow-execution").isChecked(), false);
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(await page.evaluate(() => typeof window.process), "undefined");
  checks.push(
    "First-run settings ask optional execution consent; renderer has no Node/process access",
  );
  await page.locator("#allow-execution").check();
  await page.locator("#terminal-font-size").selectOption("14");
  await page.locator("#save-settings").click();
  await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await page.evaluate(() => window.tower.preferences())).value
      .terminalFontSize,
    14,
  );
  checks.push(
    "Execution, repair limit and terminal preferences persist through dedicated settings",
  );
  await page.locator("#open-connections").click();
  await page.locator("#image-api-key").fill("invalid-test-key-not-a-secret");
  await page.locator("#save-key").click();
  await page.locator("#image-api-key[aria-invalid=true]").waitFor();
  assert.equal(await page.locator("#image-api-key").inputValue(), "");
  await application.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      globalThis.__authUrl = url;
    };
  });
  await page.locator("#chatgpt-login").click();
  await page.locator("#cancel-login:not([hidden])").waitFor();
  const auth = new URL(await application.evaluate(() => globalThis.__authUrl));
  assert.equal(auth.origin, "https://auth.openai.com");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  await page.locator("#cancel-login").click();
  await page.locator("#finish-connections").click();
  checks.push(
    "Invalid API key is cleared; official PKCE browser request cancels without exposing credentials",
  );
  const original = (await page.evaluate(() => window.tower.projects())).value
    .items.length;
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.__pickerOptions = options;
      return { canceled: true, filePaths: [] };
    };
  });
  await page.locator("#new-project").click();
  assert.equal(
    (await page.evaluate(() => window.tower.projects())).value.items.length,
    original,
  );
  assert.equal(
    (
      await application.evaluate(() => globalThis.__pickerOptions)
    ).properties.includes("openDirectory"),
    true,
  );
  checks.push(
    "New Project opens native Documents folder picker immediately; cancel creates no orphan project",
  );
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, root);
  await page.locator("#new-project").click();
  await page.locator("#folder-consent[open]").waitFor();
  assert.equal(await page.locator("#folder-consent-check").isChecked(), false);
  assert.equal(
    (await page.evaluate(() => window.tower.projects())).value.items.length,
    original,
  );
  await page.locator("#folder-consent-check").check();
  await page.locator("#confirm-folder").click();
  await page.locator("#folder-consent").waitFor({ state: "hidden" });
  await page.locator("#sidebar-projects .conversation-row.selected").waitFor();
  let data = (await page.evaluate(() => window.tower.projects())).value;
  const projectId = data.activeId;
  checks.push(
    "Project is created atomically after folder consent; left folder tree contains the selected conversation",
  );
  assert.equal(await page.locator("main>.folderbar").count(), 0);
  assert.equal(await page.locator(".planner .run-controls").count(), 0);
  assert.equal(await page.locator(".project-sidebar>h2").count(), 0);
  const panelOrder = await page.evaluate(() => ({
    worker: document.querySelector(".workers").getBoundingClientRect().top,
    controller: document.querySelector(".planner").getBoundingClientRect().top,
    workerHeight: document.querySelector(".worker").getBoundingClientRect()
      .height,
    controllerHeight: document.querySelector(".planner").getBoundingClientRect()
      .height,
  }));
  assert.ok(panelOrder.controller > panelOrder.worker);
  assert.ok(panelOrder.controllerHeight > panelOrder.workerHeight);
  checks.push(
    "Workers are above a larger control tower; central folder/files and execution fields are removed",
  );
  await application.evaluate(
    (_electron, url) => {
      const p = process.getBuiltinModule("url").fileURLToPath(url),
        require = process.getBuiltinModule("module").createRequire(p);
      const { GPTProvider } = require(p);
      const { CodexConnection } = require(
        p.replace("providers.js", "codex.js"),
      );
      CodexConnection.prototype.status = async () => ({
        installed: true,
        connected: true,
        state: "connected",
        login: { waiting: false },
      });
      CodexConnection.prototype.models = async () => [
        { id: "fixture-native-model", name: "Fixture model" },
      ];
      GPTProvider.prototype.ready = async () => true;
      globalThis.__chatInputs = [];
      GPTProvider.prototype.chat = async (context) => {
        globalThis.__chatInputs.push({
          agentId: context.options.agentId,
          message: context.message,
          history: context.history,
        });
        if (context.message === "Wait for cancellation")
          return new Promise((resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(new Error("fixture cancelled")),
              { once: true },
            );
          });
        return {
          reply:
            "Fixture answer for " +
            context.options.agentId +
            ": " +
            context.message,
        };
      };
      let featureBuilds = 0;
      GPTProvider.prototype.plan = async () => ({
        contractVersion: 1,
        version: "1.0.0",
        questions: [],
        requirements: [
          {
            id: "R1",
            title: "Counter",
            context: "Counter module exists",
            trigger: "Read value",
            reaction: "Value 2",
            acceptanceCriteria: ["Counter equals 2"],
          },
          {
            id: "R2",
            title: "Screen",
            context: "HTML loaded",
            trigger: "Find control",
            reaction: "Start button exists",
            acceptanceCriteria: ["Start button id exists"],
          },
        ],
        decisions: [
          {
            id: "D1",
            description: "Local deterministic fixture",
            source: "user",
          },
        ],
        reviewItems: [],
        design: {
          screens: [
            {
              name: "Main",
              layout: "Counter with button",
              states: ["idle", "error"],
            },
          ],
          palette: ["mint black"],
          spacing: "8px",
          typography: "system",
        },
        testPlan: {
          runner: "node-test",
          files: ["tests/checks.test.cjs"],
          cases: [
            {
              id: "T1",
              requirementId: "R1",
              title: "Counter value",
              type: "unit",
              given: "Module loaded",
              when: "Read value",
              expected: "2",
              steps: ["Load counter.cjs", "Read value", "Compare with 2"],
            },
            {
              id: "T2",
              requirementId: "R2",
              title: "Start control",
              type: "integration",
              given: "HTML exists",
              when: "Read HTML",
              expected: "start-button exists",
              steps: ["Open index.html", "Find start-button"],
            },
          ],
        },
        tasks: [
          {
            id: "logic",
            title: "Counter logic",
            owner: "grok",
            kind: "feature",
            instructions: "Create counter",
            acceptanceCriteria: ["2"],
            requirementIds: ["R1"],
            dependsOn: [],
          },
          {
            id: "ui",
            title: "Timer screen",
            owner: "claude",
            kind: "ui",
            instructions: "Create screen",
            acceptanceCriteria: ["Button exists"],
            requirementIds: ["R2"],
            dependsOn: ["logic"],
          },
          {
            id: "qa",
            title: "Independent tests",
            owner: "gpt",
            kind: "test",
            instructions: "T1 and T2 tests",
            acceptanceCriteria: ["Cases pass"],
            requirementIds: ["R1", "R2"],
            dependsOn: [],
          },
        ],
      });
      GPTProvider.prototype.build = async (context) => {
        if (context.task.kind === "feature")
          return {
            summary: "Fixture feature implementation",
            files: [
              {
                path: "counter.cjs",
                content:
                  "exports.value=" + (++featureBuilds === 1 ? 1 : 2) + ";",
              },
            ],
          };
        if (context.task.kind === "ui")
          return {
            summary: "Fixture UI integration",
            files: [
              {
                path: "index.html",
                content:
                  '<!doctype html><button id="start-button">Start</button>',
              },
            ],
          };
        return {
          summary: "Fixture test code",
          files: [
            {
              path: "tests/checks.test.cjs",
              content:
                "const {test}=require('node:test');const assert=require('node:assert/strict');test('T1 counter',()=>assert.equal(require('../counter.cjs').value,2));test('T2 control',()=>assert.match(require('node:fs').readFileSync('index.html','utf8'),/start-button/));",
            },
          ],
        };
      };
      GPTProvider.prototype.review = async (context) => ({
        summary: "Fixture review of actual test result",
        issues: context.validation.passed
          ? []
          : [
              {
                taskId: "logic",
                owner: "grok",
                file: "counter.cjs",
                description: "Counter must equal 2; actual T1 failed.",
              },
            ],
      });
    },
    pathToFileURL(resolve("src/core/providers.js")).href,
  );
  await page.locator("#open-connections").click();
  await page.locator("#refresh-status").click();
  await page.locator("#finish-connections").click();
  await page.locator("#open-roles").click();
  for (const id of ["gpt", "grok", "claude"])
    await page.locator("#role-" + id).selectOption("gpt");
  await page.locator("[data-agent=gpt] input[value=test]").check();
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  assert.equal(
    (
      await page.evaluate((id) => window.tower.team(id), projectId)
    ).value[0].roles.includes("test"),
    true,
  );
  checks.push(
    "Test design/execution is a real assignable capability; one GPT account can fill all panels",
  );
  await page.locator("#planner-input").fill("/model");
  await page.locator("#planner-input").press("Enter");
  await page.locator("#models-dialog[open] .model-row").first().waitFor();
  await page.locator("#models-dialog .model-row").first().click();
  await page.locator("#models-dialog").waitFor({ state: "hidden" });
  checks.push(
    "/model selects the provider catalog model without starting a workflow",
  );
  await page.locator("#planner-input").fill("Fixture timer with QA");
  await page.evaluate(() => {
    const courier = document.querySelector("#courier");
    const animate = courier.animate.bind(courier);
    window.__deliveries = [];
    courier.animate = (...args) => {
      window.__deliveries.push({
        from: courier.dataset.from,
        to: courier.dataset.to,
      });
      return animate(...args);
    };
  });
  await page.locator("#start-workflow").click();
  await page
    .locator("#project-state")
    .filter({ hasText: "전체 완료" })
    .waitFor({ timeout: 60000 });
  let run = (await page.evaluate((id) => window.tower.workflow(id), projectId))
    .value;
  assert.equal(run.round, 1);
  assert.equal(run.validation.passed, true);
  assert.equal(
    run.testing.result.cases.filter((row) => row.status === "passed").length,
    2,
  );
  assert.equal(
    await readFile(join(root, "counter.cjs"), "utf8"),
    "exports.value=2;",
  );
  assert.match(await page.locator("#gpt-progress").innerText(), /TAP version/);
  assert.match(await page.locator("#testing-cases").innerText(), /✓ T1/);
  checks.push(
    "QA writes real Node tests, streams TAP, detects a fixture defect, repairs the original owner and reruns dependent UI/tests",
  );
  assert.ok(
    (await page.evaluate(() => window.__deliveries)).some(
      (event) => event.from === "gpt" && event.to === "grok",
    ),
  );
  await page.locator(".mascot-motion-toggle").click();
  assert.equal(await page.locator("#courier").isHidden(), true);
  await page.locator(".mascot-motion-toggle").click();
  checks.push(
    "Actual workflow handoff animates the parcel between panels; motion-off immediately hides it",
  );
  await page.locator("#show-test-report").click();
  await page.locator("#test-report-dialog[open]").waitFor();
  assert.match(
    await page.locator("#test-report-content").innerText(),
    /T1: passed/,
  );
  assert.match(
    await page.locator("#test-report-content").innerText(),
    /Load counter.cjs/,
  );
  await page.locator("#close-test-report").click();
  assert.equal(
    (await page.locator("#planner-events .code-preview").count()) > 0,
    true,
  );
  checks.push(
    "Code previews, actual results and reproducible test steps are visible and persistent",
  );
  const firstConversation = await page
    .locator(".conversation-row.selected")
    .getAttribute("data-conversation");
  await page.locator("#grok-input").fill("Explain this counter");
  await page.locator("#grok-input").press("Enter");
  await page
    .locator("#grok-events")
    .filter({ hasText: "Fixture answer for grok" })
    .waitFor();
  await page.locator("#claude-input").fill("Explain the screen");
  await page.locator("#claude-input").press("Enter");
  await page
    .locator("#claude-events")
    .filter({ hasText: "Fixture answer for claude" })
    .waitFor();
  assert.equal(
    (await application.evaluate(() => globalThis.__chatInputs)).every(
      (row) => row.history.length === 0,
    ),
    true,
  );
  checks.push(
    "Each worker has a real provider-backed question path with separate scoped history",
  );
  await page.locator("#controller-mode").selectOption("question");
  await page.locator("#planner-input").fill("Wait for cancellation");
  await page.locator("#planner-input").press("Enter");
  await page.locator("#stop-controller-chat").waitFor({ state: "visible" });
  await page.locator("#stop-controller-chat").click();
  await page
    .locator("#planner-events")
    .filter({ hasText: "응답을 중지했습니다." })
    .waitFor();
  assert.equal(
    (await page.evaluate((id) => window.tower.workflow(id), projectId)).value
      .id,
    run.id,
  );
  checks.push(
    "Controller question mode cancels its own response without launching or altering a completed workflow",
  );
  const usage = {
    checkedAt: new Date().toISOString(),
    providers: {
      gpt: {
        state: "unsupported",
        meters: [],
        remainingPercent: null,
        message: "fixture direct GPT",
      },
      claude: {
        state: "available",
        remainingPercent: 43,
        meters: [
          { id: "session", remainingPercent: 96 },
          { id: "weekly_all", remainingPercent: 43 },
        ],
        message: "fixture dual windows",
      },
      grok: {
        state: "unsupported",
        meters: [],
        remainingPercent: null,
        message: "fixture no numeric quota",
      },
      codex: {
        state: "available",
        remainingPercent: 43,
        meters: [
          { id: "primary", windowMinutes: 300, remainingPercent: 96 },
          { id: "secondary", windowMinutes: 10080, remainingPercent: 43 },
        ],
        message: "fixture native Codex",
      },
    },
  };
  await application.evaluate(
    ({ BrowserWindow }, usage) =>
      BrowserWindow.getAllWindows()[0].webContents.send("tower:event", {
        type: "usage",
        usage,
      }),
    usage,
  );
  await page.locator("#quota-gpt").filter({ hasText: "96%/43%" }).waitFor();
  assert.equal(await page.locator("#quota-claude").innerText(), "96%/43%");
  checks.push(
    "5-hour and weekly quotas display separately as 96%/43%, never minimum-only",
  );
  await page.locator("#new-conversation").click();
  await page
    .locator("#conversation-title")
    .filter({ hasText: "새 대화" })
    .waitFor();
  assert.equal(
    await page.locator("#planner-events .terminal-entry").count(),
    0,
  );
  assert.equal(await page.locator("#grok-events .terminal-entry").count(), 0);
  await page
    .locator('.conversation-row[data-conversation="' + firstConversation + '"]')
    .click();
  await page
    .locator("#conversation-title")
    .filter({ hasText: "Fixture timer with QA" })
    .waitFor();
  await page
    .locator("#grok-events")
    .filter({ hasText: "Explain this counter" })
    .waitFor();
  checks.push(
    "New conversation is empty; selecting folder conversation restores messages and its own run/test result",
  );
  await page.locator("#sidebar-file-search").fill("does-not-exist");
  assert.equal(await page.locator(".conversation-row").count(), 0);
  await page.locator("#sidebar-file-search").fill("");
  await page.locator(".conversation-row.selected").waitFor();
  checks.push("Left sidebar searches conversations rather than files");
  await page.locator("#open-settings").click();
  await page.locator("#max-repair-rounds").fill("4");
  await page.locator("#save-settings").click();
  await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await page.evaluate(() => window.tower.preferences())).value
      .maxRepairRounds,
    4,
  );
  assert.equal(
    (await page.evaluate((id) => window.tower.workflow(id), projectId)).value
      .options.maxRepairRounds,
    2,
  );
  checks.push(
    "Settings changes apply to next work; completed run retains frozen configuration",
  );
  await page.locator("#open-roles").click();
  await page.locator("#agent-count").selectOption("2");
  for (const id of ["gpt", "grok"])
    await page.locator("#role-" + id).selectOption("gpt");
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".worker:visible").count(), 1);
  await page.locator("#open-roles").click();
  await page.locator("#agent-count").selectOption("4");
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".worker:visible").count(), 3);
  checks.push(
    "2/4 panel resizing retains multiple roles and independent chat composers",
  );
  await page.screenshot({ path: join(artifacts, "v07-workers.png") });
  await page.locator(".planner").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "v07-controller.png") });
  for (const width of [1920, 1440, 900, 768, 414, 375, 320]) {
    await application.evaluate(({ BrowserWindow }, width) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(0, 0);
      win.setSize(width, 1000);
    }, width);
    const sizes = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(sizes.scroll <= sizes.width, "overflow at " + width);
  }
  checks.push(
    "No horizontal overflow across 320,375,414,768,900,1440,1920px; large panels scroll vertically",
  );
  assert.deepEqual(errors, []);
  await application.close();
  page = await boot();
  assert.equal(
    await page.locator("#settings-dialog").evaluate((node) => node.open),
    false,
  );
  await page.locator(".conversation-row.selected").waitFor();
  assert.equal(
    (await page.evaluate(() => window.tower.preferences())).value
      .maxRepairRounds,
    4,
  );
  await page
    .locator("#grok-events")
    .filter({ hasText: "Fixture answer for grok" })
    .waitFor();
  assert.equal(await page.locator(".worker:visible").count(), 3);
  checks.push(
    "Full restart restores project, selected conversation, worker replies, role count and preferences without repeated consent",
  );
  console.log(
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        providerInference:
          "explicit fixtures; actual coordinator and Node test processes",
        paidCalls: 0,
        profile,
        artifacts,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(artifacts, "smoke-v07-report.json"),
    JSON.stringify({ passed: checks.length, checks, errors }, null, 2),
  );
} finally {
  await application?.close().catch(() => {});
}
