import { _electron as electron } from "@playwright/test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const directory = resolve("artifacts");
await mkdir(directory, { recursive: true });
const userData = resolve(`artifacts/smoke-profile-${Date.now()}`);
const environment = { ...process.env, TOWER_TEST_USER_DATA: userData };
delete environment.ELECTRON_RUN_AS_NODE;
let application;
const checks = [];
const autoDialogs = [];
async function boot() {
  application = await electron.launch({
    args: ["."],
    cwd: resolve("."),
    env: environment,
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  await page
    .locator("#session-status[data-restoring=false]")
    .waitFor({ state: "attached" });
  autoDialogs.push(
    await page.locator("#connections").evaluate((dialog) => dialog.open),
  );
  if (!autoDialogs.at(-1)) await page.locator("#open-connections").click();
  await page.locator("#connections[open]").waitFor();
  return page;
}
try {
  let page = await boot();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const platform = await application.evaluate(({ safeStorage }) => {
    const text = "tower-test-sentinel-not-a-real-key";
    const available = safeStorage.isEncryptionAvailable();
    if (!available) return { available };
    const encrypted = safeStorage.encryptString(text);
    return {
      available,
      roundTrip: safeStorage.decryptString(encrypted) === text,
      plaintext: encrypted.includes(Buffer.from(text)),
    };
  });
  assert.equal(platform.available, true);
  assert.equal(platform.roundTrip, true);
  assert.equal(platform.plaintext, false);
  checks.push(
    "Windows OS encryption round-trip; no plaintext in encrypted data",
  );
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(await page.evaluate(() => typeof window.process), "undefined");
  checks.push("Renderer has no Node.js or process access");
  assert.match(await page.title(), /CW_Handsoff_sys/);
  assert.equal(
    await page
      .locator(".brand-mascot")
      .evaluate((image) => image.complete && image.naturalWidth > 0),
    true,
  );
  assert.equal(
    await page.locator("#mascot-stage").getAttribute("data-state"),
    "idle",
  );
  checks.push(
    "Approved mascot asset loads and the app/project title uses CW_Handsoff_sys",
  );
  await page
    .locator("#connections")
    .screenshot({ path: join(directory, "connections.png") });
  await page.locator("#image-api-key").fill("definitely-not-an-api-key");
  await page.locator("#save-key").click();
  await page.locator("#image-api-key[aria-invalid=true]").waitFor();
  assert.equal(await page.locator("#image-api-key").inputValue(), "");
  assert.match(await page.locator("#key-message").innerText(), /API 키/);
  checks.push(
    "Invalid key refused, input cleared, no network request or secret stored",
  );
  const source = await page.content();
  assert.ok(!source.includes("definitely-not-an-api-key"));
  const dataFiles = await readdir(userData);
  assert.ok(!dataFiles.includes("vault.enc"));
  await application.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      globalThis.__towerAuthorizeURL = url;
    };
  });
  await page.locator("#chatgpt-login").click();
  await page.locator("#cancel-login:not([hidden])").waitFor();
  assert.equal(await page.locator("#chatgpt-login").isDisabled(), true);
  const authURL = new URL(
    await application.evaluate(() => globalThis.__towerAuthorizeURL),
  );
  assert.equal(authURL.origin, "https://auth.openai.com");
  assert.equal(authURL.searchParams.get("code_challenge_method"), "S256");
  assert.ok(
    authURL.searchParams.get("scope").includes("chatgpt.tokens.use.direct"),
  );
  assert.ok(
    authURL.searchParams.get("redirect_uri").startsWith("http://127.0.0.1:"),
  );
  await page.locator("#cancel-login").click();
  await page.locator("#cancel-login[hidden]").waitFor({ state: "attached" });
  assert.equal(
    (await page.evaluate(() => window.tower.status())).value.waiting,
    false,
  );
  checks.push(
    "Real login starts loopback listener and builds official PKCE browser URL; cancellation closes attempt",
  );
  const nativeState = (await page.evaluate(() => window.tower.status())).value
    .codex;
  if (nativeState.connected) {
    const reuse = await page.evaluate(() => window.tower.codexLogin(false));
    assert.equal(reuse.value.reused, true);
    await page.locator("#codex-reauth").click();
    await page.locator("#codex-login-browser:not([hidden])").waitFor();
    const url = new URL(
      await application.evaluate(() => globalThis.__towerAuthorizeURL),
    );
    assert.equal(url.origin, "https://auth.openai.com");
    await page.locator("#codex-cancel-login").click();
    await page.locator("#codex-login-flow").waitFor({ state: "hidden" });
    assert.equal(
      (await page.evaluate(() => window.tower.status())).value.codex.connected,
      true,
    );
    checks.push(
      "Actual Codex reuses current OS login, opens official sign-in URL and cancels without logging out native CLI",
    );
  }
  // Open through the actual Cursor login process, while intercepting browser launch only.
  assert.equal(await page.locator("#grok-login").isDisabled(), false);
  await page.locator("#grok-login").click();
  await page.locator("#grok-login-browser:not([hidden])").waitFor();
  const cursorURL = new URL(
    await application.evaluate(() => globalThis.__towerAuthorizeURL),
  );
  assert.equal(cursorURL.hostname, "cursor.com");
  assert.match(cursorURL.pathname, /login/);
  await page.locator("#grok-cancel-login").click();
  await page.locator("#grok-login-flow").waitFor({ state: "hidden" });
  assert.equal(
    (await page.evaluate(() => window.tower.status())).value.grok.connected,
    true,
  );
  checks.push(
    "Actual Cursor login button opens the official authorization URL even with cached auth; cancel preserves existing login",
  );
  // No browser was opened, and no actual account authentication or paid API request occurred.
  await page.locator("#finish-connections").click();
  await page.locator("#edit-title").click();
  await page.locator("#project-name").fill("집중 타이머");
  await page.locator("#project-form button[type=submit]").click();
  await page.locator("#project-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#project-title").innerText(), "집중 타이머");
  assert.equal(
    await page.locator("#project-select option:checked").innerText(),
    "집중 타이머",
  );
  await page.locator("#new-project").click();
  await page.locator("#project-name").fill("독서 기록");
  await page.locator("#project-form button[type=submit]").click();
  await page.locator("#project-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#project-select option").count(), 2);
  checks.push(
    "Project create and rename update header and project menu together",
  );
  const firstProject = await page
    .locator("#project-select option")
    .first()
    .getAttribute("value");
  await page.locator("#project-select").selectOption(firstProject);
  await page
    .locator("#project-title")
    .filter({ hasText: "집중 타이머" })
    .waitFor();
  const workingFolder = resolve(directory, `workspace-${Date.now()}`);
  await mkdir(workingFolder);
  await writeFile(
    join(workingFolder, "hello.js"),
    'export const hello = "project folder";',
  );
  const denied = await page.evaluate(
    (id) => window.tower.readFile(id, "hello.js"),
    firstProject,
  );
  assert.equal(denied.ok, false);
  await application.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [root],
    });
  }, workingFolder);
  await page.locator("#choose-folder").click();
  await page.locator("#folder-consent[open]").waitFor();
  assert.equal(await page.locator("#folder-consent-check").isChecked(), false);
  await page
    .locator("#folder-consent")
    .screenshot({ path: join(directory, "folder-consent.png") });
  await page.locator("#folder-consent-check").check();
  await page.locator("#confirm-folder").click();
  await page.locator("#folder-consent").waitFor({ state: "hidden" });
  await page.locator("#folder-permission.connected").waitFor();
  assert.equal(await page.locator("#folder-path").innerText(), workingFolder);
  await page.locator("#show-files").click();
  await page.locator("#files-dialog[open]").waitFor();
  await page
    .locator("#file-list")
    .getByRole("button", { name: "hello.js", exact: false })
    .click();
  await page
    .locator("#file-preview")
    .filter({ hasText: "project folder" })
    .waitFor();
  await page.locator("#close-files").click();
  checks.push(
    "Native folder selection requires unchecked explicit consent; connected project files can be previewed",
  );
  // Replace the provider only inside this test process. Exercise the real IPC and workspace image writer without billing.
  await application.evaluate(
    async (_electron, moduleURL) => {
      const { createRequire } = process.getBuiltinModule("module");
      const path = process.getBuiltinModule("url").fileURLToPath(moduleURL);
      const { ImageService } = createRequire(path)(path);
      ImageService.prototype.generate = async () => {
        const data =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=";
        return {
          buffer: Buffer.from(data, "base64"),
          dataUrl: `data:image/png;base64,${data}`,
        };
      };
    },
    pathToFileURL(resolve("src/core/images.js")).href,
  );
  const generated = await page.evaluate(
    (id) => window.tower.generateImage(id, "test fixture image"),
    firstProject,
  );
  assert.equal(generated.ok, true);
  const imageFile = join(workingFolder, generated.value.path);
  assert.equal(
    (await readFile(imageFile)).subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
  );
  const latest = await page.evaluate(
    (id) => window.tower.latestImage(id),
    firstProject,
  );
  assert.equal(latest.value.path, generated.value.path);
  checks.push(
    "Generated image IPC writes the PNG inside the approved project folder using a test provider response",
  );
  await page.locator("#toast").evaluate((element) => {
    element.hidden = true;
  });
  await page.screenshot({
    path: join(directory, "workspace.png"),
    fullPage: true,
  });
  // Test the model picker with an explicitly labelled fixture after real-state screenshots.
  await application.evaluate(
    (_electron, moduleURL) => {
      const path = process.getBuiltinModule("url").fileURLToPath(moduleURL);
      const { CursorProvider } = process
        .getBuiltinModule("module")
        .createRequire(path)(path);
      CursorProvider.prototype.models = async () => [
        { id: "grok-fixture[effort=high]", name: "Grok test fixture" },
      ];
    },
    pathToFileURL(resolve("src/core/cursor-provider.js")).href,
  );
  await page.locator("#open-connections").click();
  await page.locator("#load-grok-models").click();
  await page
    .locator('#grok-model option[value="grok-fixture[effort=high]"]')
    .waitFor({ state: "attached" });
  await page.locator("#grok-model").selectOption("grok-fixture[effort=high]");
  await page
    .locator("#grok-model-label")
    .filter({ hasText: "grok-fixture" })
    .waitFor();
  assert.equal(
    (await page.evaluate(() => window.tower.selectGrokModel("auto"))).ok,
    false,
  );
  await page.locator("#finish-connections").click();
  checks.push(
    "Cursor Grok picker persists a catalog model and refuses an unlisted replacement",
  );
  const usageFixture = {
    checkedAt: new Date().toISOString(),
    providers: {
      gpt: {
        provider: "gpt",
        state: "unsupported",
        remainingPercent: null,
        meters: [],
        message: "Test fixture: direct GPT quota unavailable",
      },
      claude: {
        provider: "claude",
        state: "available",
        remainingPercent: 82,
        meters: [
          {
            id: "session",
            label: "session",
            remainingPercent: 82,
            active: true,
            resetsAt: null,
          },
        ],
        message: "Test fixture structured /usage",
      },
      grok: {
        provider: "grok",
        state: "unsupported",
        remainingPercent: null,
        meters: [],
        message: "Test fixture: unsupported",
      },
      codex: {
        provider: "codex",
        state: "available",
        remainingPercent: 70,
        meters: [],
        accountLabel: "fixture@example.test",
        message: "Test fixture separate Codex account",
      },
    },
  };
  await application.evaluate(
    ({ BrowserWindow }, usage) =>
      BrowserWindow.getAllWindows()[0].webContents.send("tower:event", {
        type: "usage",
        usage,
      }),
    usageFixture,
  );
  await page.locator("#quota-claude").filter({ hasText: "82% 잔여" }).waitFor();
  const gptSource = (await page.evaluate(() => window.tower.status())).value.gpt
    .source;
  assert.equal(
    await page.locator("#quota-gpt").innerText(),
    gptSource === "codex" ? "70% 잔여" : "조회 미지원",
  );
  assert.match(
    await page.locator("[data-usage=codex]").innerText(),
    gptSource === "codex" ? /동일 출처/ : /별도 계정/,
  );
  await page.locator("[data-usage=claude]").click();
  await page.locator("#usage-dialog[open]").waitFor();
  assert.match(await page.locator("#usage-meters").innerText(), /82% 잔여/);
  await page.locator("#close-usage").click();
  checks.push(
    "Quota strip renders official-format values, details and unsupported states without mixing Codex and GPT accounts",
  );
  await page.locator("#tab-images").click();
  assert.equal(await page.locator("#generate-image").isDisabled(), true);
  await page.screenshot({
    path: join(directory, "image-studio.png"),
    fullPage: true,
  });
  checks.push(
    "Image generation is disabled until a key is registered; no simulated output",
  );
  await page.locator("#tab-workspace").click();
  // Exercise the real coordinator + renderer with test providers and an actual local npm check.
  await writeFile(
    join(workingFolder, "package.json"),
    JSON.stringify({ private: true, scripts: { test: "node checks.cjs" } }),
  );
  await writeFile(
    join(workingFolder, "checks.cjs"),
    'require("node:assert/strict").equal(require("./timer.cjs").value,2)',
  );
  await application.evaluate(
    (_electron, moduleURL) => {
      const path = process.getBuiltinModule("url").fileURLToPath(moduleURL);
      const { GPTProvider, ClaudeProvider } = process
        .getBuiltinModule("module")
        .createRequire(path)(path);
      const { CursorProvider: GrokProvider } = process
        .getBuiltinModule("module")
        .createRequire(path)(
        path.replace("providers.js", "cursor-provider.js"),
      );
      for (const Provider of [GPTProvider, GrokProvider, ClaudeProvider])
        Provider.prototype.ready = async () => true;
      globalThis.__cwFixture = (plan) => ({
        ...plan,
        contractVersion: 1,
        version: "1.0.0",
        requirements: plan.tasks.map((task, index) => ({
          id: "R" + index,
          title: task.title,
          context: "Fixture approved input",
          trigger: "Assigned task starts",
          reaction: "Expected output is saved",
          acceptanceCriteria: task.acceptanceCriteria,
        })),
        decisions: [],
        reviewItems: [],
        design: {
          screens: [
            {
              name: "Fixture screen",
              layout: "Single work area",
              states: ["idle", "error"],
            },
          ],
          palette: ["mint on black"],
          spacing: "8px grid",
          typography: "system sans",
        },
        tasks: plan.tasks.map((task, index) => ({
          ...task,
          kind:
            task.owner === "grok"
              ? "feature"
              : task.owner === "reviewer"
                ? "debug"
                : "ui",
          requirementIds: ["R" + index],
        })),
      });
      GPTProvider.prototype.plan = async () =>
        globalThis.__cwFixture({
          questions: [],
          spec: "# Test fixture timer specification",
          tasks: [
            {
              id: "logic",
              title: "Timer logic",
              owner: "grok",
              instructions: "fixture only",
              acceptanceCriteria: ["value equals 2"],
              dependsOn: [],
            },
            {
              id: "ui",
              title: "Connect timer",
              owner: "claude",
              instructions: "fixture only",
              acceptanceCriteria: ["imports the timer"],
              dependsOn: ["logic"],
            },
          ],
        });
      let builds = 0,
        reviews = 0;
      GrokProvider.prototype.build = async () => ({
        summary: "Test fixture feature report",
        files: [{ path: "timer.cjs", content: `exports.value = ${++builds};` }],
      });
      ClaudeProvider.prototype.build = async () => ({
        summary: "Test fixture integration report",
        files: [
          {
            path: "app.cjs",
            content: 'module.exports = require("./timer.cjs")',
          },
        ],
      });
      GPTProvider.prototype.review = async () => ({
        summary: "Test fixture controller review",
        issues:
          ++reviews === 1
            ? [
                {
                  taskId: "logic",
                  owner: "grok",
                  file: "timer.cjs",
                  description: "The timer value must be 2.",
                },
              ]
            : [],
      });
      for (const Provider of [GrokProvider, ClaudeProvider])
        Provider.prototype.review = async () => ({
          summary: "Test fixture final review",
          issues: [],
        });
    },
    pathToFileURL(resolve("src/core/providers.js")).href,
  );
  const started = await page.evaluate(
    (id) =>
      window.tower.startWorkflow(id, {
        request: "Test fixture only",
        gptModel: "test-fixture-model",
        maxRepairRounds: 1,
        validationScript: "test",
        allowExecution: true,
      }),
    firstProject,
  );
  assert.equal(started.ok, true);
  await page
    .locator("#project-state")
    .filter({ hasText: "전체 완료" })
    .waitFor();
  assert.match(
    await page.locator("#planner-events").innerText(),
    /Grok · Cursor · 기능 구현에 수정 요청/,
  );
  assert.match(
    await page.locator("#grok-events").innerText(),
    /GPT에 완료 보고/,
  );
  assert.match(
    await page.locator("#claude-events").innerText(),
    /GPT에 완료 보고/,
  );
  const state = await page.evaluate(
    (id) => window.tower.workflow(id),
    firstProject,
  );
  assert.equal(state.value.round, 1);
  assert.equal(state.value.validation.passed, true);
  assert.deepEqual(state.value.options.grokRoute, {
    source: "cursor",
    modelId: "grok-fixture[effort=high]",
  });
  assert.equal(
    await readFile(join(workingFolder, "timer.cjs"), "utf8"),
    "exports.value = 2;",
  );
  checks.push(
    "Actual coordinator/IPC/UI loop routes a fixture defect to Grok, reruns Claude integration and passes a real npm check",
  );
  await page.locator("#open-roles").click();
  await page.locator("#roles-dialog[open]").waitFor();
  await page.locator("#role-gpt").selectOption("gemini");
  await page.locator("#role-grok").selectOption("gpt");
  await page.locator("#role-claude").selectOption("claude");
  await page
    .locator("#roles-dialog")
    .screenshot({ path: join(directory, "roles.png") });
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#planner-provider").innerText(), "Gemini");
  assert.equal(await page.locator("#feature-provider").innerText(), "GPT");
  const rotated = { gpt: "gemini", grok: "gpt", claude: "claude" };
  assert.deepEqual(
    (await page.evaluate((id) => window.tower.roles(id), firstProject)).value,
    rotated,
  );
  await application.evaluate(
    (_electron, moduleURL) => {
      const path = process.getBuiltinModule("url").fileURLToPath(moduleURL);
      const require = process.getBuiltinModule("module").createRequire(path);
      const { GeminiProvider } = require(path);
      const { GPTProvider } = require(
        path.replace("gemini.js", "providers.js"),
      );
      globalThis.__roleCalls = [];
      GeminiProvider.prototype.ready = async () => true;
      GeminiProvider.prototype.plan = async () => {
        globalThis.__roleCalls.push("Gemini plan");
        return new Promise((resolve) => {
          globalThis.__releaseRolePlan = () =>
            resolve(
              globalThis.__cwFixture({
                questions: [],
                spec: "# Rotated fixture",
                tasks: [
                  {
                    id: "logic",
                    title: "Rotated logic",
                    owner: "grok",
                    instructions: "fixture only",
                    acceptanceCriteria: ["value 2"],
                    dependsOn: [],
                  },
                  {
                    id: "ui",
                    title: "Rotated UI",
                    owner: "claude",
                    instructions: "fixture only",
                    acceptanceCriteria: ["uses logic"],
                    dependsOn: ["logic"],
                  },
                ],
              }),
            );
        });
      };
      GeminiProvider.prototype.review = async () => {
        globalThis.__roleCalls.push("Gemini review");
        return { summary: "Rotated fixture controller review", issues: [] };
      };
      GPTProvider.prototype.build = async () => {
        globalThis.__roleCalls.push("GPT build");
        return {
          summary: "Rotated fixture feature report",
          files: [{ path: "timer.cjs", content: "exports.value = 2;" }],
        };
      };
    },
    pathToFileURL(resolve("src/core/gemini.js")).href,
  );
  const secondRun = await page.evaluate(
    (id) =>
      window.tower.startWorkflow(id, {
        request: "Rotated fixture only",
        gptModel: "test-fixture-model",
        maxRepairRounds: 0,
        validationScript: "test",
        allowExecution: true,
      }),
    firstProject,
  );
  assert.equal(secondRun.ok, true);
  await page
    .locator("#project-state")
    .filter({ hasText: "명세 작성 중" })
    .waitFor();
  assert.equal(
    await page.locator("#mascot-stage").getAttribute("data-state"),
    "planning",
  );
  await page.locator("#open-roles").click();
  await page.locator("#role-gpt").selectOption("claude");
  await page.locator("#role-grok").selectOption("gemini");
  await page.locator("#role-claude").selectOption("gpt");
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#planner-provider").innerText(), "Gemini");
  await application.evaluate(() => globalThis.__releaseRolePlan());
  await page
    .locator("#project-state")
    .filter({ hasText: "전체 완료" })
    .waitFor();
  const rotatedState = (
    await page.evaluate((id) => window.tower.workflow(id), firstProject)
  ).value;
  assert.deepEqual(rotatedState.options.roles, rotated);
  const routed = await application.evaluate(() => globalThis.__roleCalls);
  assert.ok(routed.includes("Gemini plan"));
  assert.ok(routed.includes("GPT build"));
  assert.equal(routed.filter((call) => call === "Gemini review").length, 2);
  assert.match(
    await page.locator("#grok-events").innerText(),
    /Gemini에 완료 보고/,
  );
  checks.push(
    "Role picker changes real coordinator routing to Gemini control and GPT build; active run remains frozen when next assignment changes",
  );
  const savedTeam = (
    await page.evaluate((id) => window.tower.team(id), firstProject)
  ).value;
  await page.locator("#open-roles").click();
  await page.locator("#agent-count").selectOption("2");
  for (const id of ["gpt", "grok"])
    await page.locator("#role-" + id).selectOption("gpt");
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".workers>.worker:visible").count(), 1);
  if (nativeState.connected) {
    await page.locator("#planner-input").fill("/model");
    await page.locator("#planner-input").press("Enter");
    await page.locator("#models-dialog[open] .model-row").first().waitFor();
    await page.locator("#models-dialog .model-row").first().click();
    await page.locator("#models-dialog").waitFor({ state: "hidden" });
    assert.ok(await page.locator("#gpt-model").inputValue());
    checks.push(
      "/model opens actual Codex model catalog and persists the chosen native model",
    );
  }
  assert.equal(
    (
      await page.evaluate((id) => window.tower.team(id), firstProject)
    ).value[1].roles.includes("ui"),
    true,
  );
  await page.screenshot({
    path: join(directory, "workbench-2.png"),
    fullPage: true,
  });
  await page.locator("#open-roles").click();
  await page.locator("#agent-count").selectOption("4");
  for (const id of ["gpt", "grok", "claude", "reviewer"])
    await page.locator("#role-" + id).selectOption("gpt");
  await page.locator("[data-agent=reviewer] input[value=feature]").check();
  await page.locator("[data-agent=reviewer] input[value=ui]").check();
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".workers>.worker:visible").count(), 3);
  const allGpt = (
    await page.evaluate((id) => window.tower.team(id), firstProject)
  ).value;
  assert.ok(allGpt.every((agent) => agent.provider === "gpt"));
  assert.ok(
    allGpt[3].roles.includes("feature") && allGpt[3].roles.includes("ui"),
  );
  await application.evaluate(
    (_electron, moduleURL) => {
      const path = process.getBuiltinModule("url").fileURLToPath(moduleURL);
      const { GPTProvider } = process
        .getBuiltinModule("module")
        .createRequire(path)(path);
      GPTProvider.prototype.plan = async () =>
        globalThis.__cwFixture({
          questions: [],
          tasks: ["grok", "claude", "reviewer"].map((owner, index) => ({
            id: "parallel" + index,
            title: "Independent panel " + owner,
            owner,
            instructions: "fixture only",
            dependsOn: [],
            acceptanceCriteria: ["Independent file saved"],
          })),
        });
      GPTProvider.prototype.build = async (context) => ({
        summary: "Independent session " + context.options.agentId,
        files: [
          {
            path: context.options.agentId + "-session.txt",
            content: context.task.id,
          },
        ],
      });
    },
    pathToFileURL(resolve("src/core/providers.js")).href,
  );
  const parallel = await page.evaluate(
    (id) =>
      window.tower.startWorkflow(id, {
        request: "Four-panel isolated fixture",
        maxRepairRounds: 0,
        validationScript: "test",
        allowExecution: true,
      }),
    firstProject,
  );
  assert.equal(parallel.ok, true);
  await page
    .locator("#project-state")
    .filter({ hasText: "전체 완료" })
    .waitFor();
  const parallelState = (
    await page.evaluate((id) => window.tower.workflow(id), firstProject)
  ).value;
  assert.equal(parallelState.reviews.length, 5);
  assert.equal(parallelState.tasks.length, 3);
  assert.match(
    await page.locator("#reviewer-events").innerText(),
    /reviewer-session.txt/,
  );
  await page.screenshot({
    path: join(directory, "workbench-4.png"),
    fullPage: true,
  });
  checks.push(
    "2 and 4 panels persist one GPT provider, consolidate roles, allow duplicate capabilities and run all four independent review sessions",
  );
  await page.evaluate(({ id, team }) => window.tower.setTeam(id, team), {
    id: firstProject,
    team: savedTeam,
  });
  await page.locator("#open-roles").click();
  await page.locator("#save-roles").click();
  await page.locator("#roles-dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator("#mascot-stage").getAttribute("data-state"),
    "done",
  );
  await page.locator(".mascot-motion-toggle").click();
  assert.equal(
    await page.locator("#mascot-stage").getAttribute("data-motion"),
    "off",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".mascot-motion-toggle").click();
  assert.equal(
    await page.locator("#mascot-stage").getAttribute("data-motion"),
    "off",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  checks.push(
    "Mascot follows actual run state, has a motion toggle and respects reduced-motion preference",
  );
  for (const width of [1920, 1440, 900, 768, 414, 375, 320]) {
    await application.evaluate(({ BrowserWindow }, w) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(0, 0);
      window.setSize(w, 1000);
    }, width);
    const size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.ok(
      size.scroll <= size.width,
      `overflow at ${width}: ${JSON.stringify(size)}`,
    );
  }
  checks.push(
    "No horizontal overflow at 1920, 1440, 900, 768, 414, 375, 320px",
  );
  assert.deepEqual(errors, []);
  await application.close();
  page = await boot();
  assert.equal(await page.locator("#planner-provider").innerText(), "Claude");
  assert.equal(await page.locator("#feature-provider").innerText(), "Gemini");
  assert.equal(await page.locator("#ui-provider").innerText(), "GPT");
  assert.equal(
    await page.locator("#grok-model").inputValue(),
    "grok-fixture[effort=high]",
  );
  await page.locator("#finish-connections").click();
  assert.equal(await page.locator("#project-title").innerText(), "집중 타이머");
  assert.equal(await page.locator("#project-select option").count(), 2);
  checks.push("Project state persists after a full desktop app restart");
  assert.equal(autoDialogs.at(-1), false);
  checks.push(
    "Restart reuses stored CLI state and does not reopen the login dialog automatically",
  );
  await page.locator("#folder-permission.connected").waitFor();
  assert.equal(await page.locator("#folder-path").innerText(), workingFolder);
  const recovered = await page.evaluate(
    (id) => window.tower.latestImage(id),
    firstProject,
  );
  assert.equal(recovered.value.path, generated.value.path);
  checks.push(
    "Folder consent and project image mapping persist after application restart",
  );
  await page.locator("#revoke-folder").click();
  await page
    .locator("#folder-permission")
    .filter({ hasText: "접근 동의 필요" })
    .waitFor();
  const afterRevoke = await page.evaluate(
    (id) => window.tower.readFile(id, "hello.js"),
    firstProject,
  );
  assert.equal(afterRevoke.ok, false);
  assert.equal(
    (await readFile(imageFile)).subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
  );
  checks.push(
    "Revoking folder access denies further reads and preserves existing generated files",
  );
  const persisted = JSON.parse(
    await readFile(join(userData, "projects.json"), "utf8"),
  );
  assert.equal(persisted.items.length, 2);
  console.log(
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        liveAccountLogin: "not attempted",
        paidApiCalls: 0,
        screenshots: directory,
      },
      null,
      2,
    ),
  );
} finally {
  await application?.close().catch(() => {});
}
