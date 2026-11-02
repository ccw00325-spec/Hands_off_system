import {
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  access,
} from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Store } from "../src/core/store.js";
import { Projects } from "../src/core/projects.js";
import { Workspace } from "../src/core/workspace.js";
import { Workflow } from "../src/core/workflow.js";
import { GPTProvider } from "../src/core/providers.js";
import { roleProviders } from "../src/core/roles.js";
import { CodexConnection } from "../src/core/codex.js";
import { nativeEnvironment } from "../src/core/child-env.js";
const parent = resolve("artifacts");
await mkdir(parent, { recursive: true });
const id = randomUUID(),
  root = join(parent, `timer-simulation-${id}`),
  data = join(parent, `timer-data-${id}`);
await mkdir(root);
await mkdir(data);
await writeFile(join(root, ".cw-simulation-owned"), id);
const store = new Store(data, {});
await store.init();
const projects = new Projects(store);
const projectId = (await projects.list()).activeId;
const workspace = new Workspace(projects);
const ticket = await workspace.prepare(projectId, root);
await workspace.consent(projectId, ticket.ticket, true);
const native = new CodexConnection(data);
let active = 0,
  maxConcurrent = 0;
const calls = [];
const ask = native.ask.bind(native);
native.ask = async (...args) => {
  active++;
  maxConcurrent = Math.max(maxConcurrent, active);
  const entry = { agent: args[2].agentId, startedAt: new Date().toISOString() };
  calls.push(entry);
  try {
    return await ask(...args);
  } finally {
    active--;
    entry.endedAt = new Date().toISOString();
  }
};
const checks = `const assert=require('node:assert/strict');const {createTimer}=require('./timer-core.js');let now=0;const t=createTimer({durationSeconds:3,now:()=>now});assert.equal(t.getState().status,'idle');assert.equal(t.getState().remainingSeconds,3);t.start();now=1100;assert.equal(t.getState().remainingSeconds,2);t.pause();const frozen=t.getState().remainingSeconds;now=5000;assert.equal(t.getState().remainingSeconds,frozen);assert.equal(t.getState().status,'paused');t.start();now=8000;assert.equal(t.getState().remainingSeconds,0);assert.equal(t.getState().status,'completed');t.reset();assert.equal(t.getState().remainingSeconds,3);assert.equal(t.getState().status,'idle');assert.throws(()=>t.setDuration(0));assert.throws(()=>t.setDuration(3601));t.setDuration(5);assert.equal(t.getState().remainingSeconds,5);console.log('trusted timer core checks passed');`;
await writeFile(join(root, "checks.cjs"), checks);
const hash = createHash("sha256").update(checks).digest("hex");
const report = {
  id,
  mode: "real Codex ChatGPT subscription inference",
  startedAt: new Date().toISOString(),
  model: null,
  passed: false,
  deleted: false,
};
const validate = async () => {
  if (
    createHash("sha256")
      .update(await readFile(join(root, "checks.cjs")))
      .digest("hex") !== hash
  )
    return {
      configured: true,
      passed: false,
      summary: "Trusted checks were modified",
    };
  const core = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["checks.cjs"], {
      cwd: root,
      env: nativeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({
        configured: true,
        passed: false,
        summary: "timer test timeout",
      });
    }, 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        configured: true,
        passed: code === 0,
        summary: output.slice(-3000),
      });
    });
  });
  if (!core.passed) return core;
  const { verifyTimerUI } = await import("./timer-ui-check.mjs");
  try {
    const ui = await verifyTimerUI(root);
    return { ...core, summary: core.summary + "; " + ui };
  } catch (error) {
    return {
      configured: true,
      passed: false,
      summary: "timer UI validation: " + error.message,
    };
  }
};
try {
  const status = await native.status();
  if (!status.connected)
    throw new Error("Existing Codex ChatGPT login unavailable");
  const catalog = await native.models();
  const model =
    catalog.find((row) => /sol/i.test(row.id)) ??
    catalog.find((row) => row.isDefault) ??
    catalog[0];
  if (!model) throw new Error("No actual model catalog");
  report.model = model.id;
  const gpt = new GPTProvider(null, resolve("src/skills/fun.md"), native);
  const engine = new Workflow(
    workspace,
    roleProviders({ gpt }),
    (event) => {
      if (event.type === "workflow")
        console.log(
          JSON.stringify({
            phase: event.state.status,
            tasks: event.state.tasks.map((task) => ({
              id: task.id,
              status: task.status,
            })),
            last: event.state.events.at(-1)?.message,
          }),
        );
    },
    validate,
  );
  const request = `/fun Build a complete Korean desktop-browser countdown timer app in this folder. This is an unattended authorized simulation: do not ask questions for reversible UI details, list assumptions in reviewItems. Use only vanilla HTML/CSS/JS and no network/dependencies. Files: index.html, timer-core.js, app.js, styles.css, package.json (type commonjs, test: node checks.cjs). Preserve existing checks.cjs unchanged. Timer API: timer-core.js is UMD, exports createTimer through module.exports and window.createTimer. createTimer({durationSeconds,now}) with injectable now() milliseconds (default Date.now), methods start(),pause(),reset(),setDuration(seconds) and getState() returning {status:'idle'|'running'|'paused'|'completed',remainingSeconds:integer ceil of remaining ms/1000}. start is idempotent while running; pause freezes remaining time; resume continues; zero completes; reset resets configured duration and idle; setDuration requires integer 1..3600 and throws otherwise. Do not restart unexpectedly. getState computes elapsed time from now so background throttling is safe. UI IDs required: duration-input (number seconds), start-button, pause-button, reset-button, time-display (MM:SS), status-display (data-status exact core status), error-message. Label controls in Korean. Default duration 60 seconds. Duration changes before start/reset set the core duration; zero/out-of-range input shows validation error and does not start. UI refreshes every <=100ms and supports keyboard buttons. Pause freezes UI; reset restores configured duration. Accessibility: update textContent, attributes, disabled and live-region nodes ONLY when their value changes, never rewrite unchanged values every 100ms. Put aria-live on status changes only, never on the ticking number. Invalid reset input must remain visible with an error and must not silently reset or clear the error. No sounds, notifications, accounts, persistence, external requests or automatic package installation. Create full functional UI with all four timer states and an input-error state. Both team panels use GPT independently: control/debug gpt; implementation/UI grok. Assign implementation tasks to grok, optional debug to gpt with dependencies. Produce the structured Fun contract including every required Context, Trigger, Reaction, test criteria, screen states, design tokens, decisions and deferred reviewItems. Do not claim tests passed until host validation says so.`;
  await engine.start(projectId, {
    request,
    gptSource: "codex",
    gptModel: model.id,
    funContract: true,
    unattended: true,
    maxRepairRounds: 6,
    team: [
      { id: "gpt", provider: "gpt", roles: ["control", "debug", "review"] },
      { id: "grok", provider: "gpt", roles: ["feature", "ui"] },
    ],
    roles: { gpt: "gpt", grok: "gpt", claude: "gpt" },
  });
  await engine.runs.get(projectId).promise;
  const state = await engine.current(projectId);
  Object.assign(report, {
    status: state.status,
    passed: state.status === "completed",
    requirements: state.requirements?.length,
    decisions: state.decisions,
    reviewItems: state.reviewItems,
    governance: state.governance,
    validation: state.validation,
    questions: state.questions,
    rounds: state.round,
    maxConcurrentNativeRequests: maxConcurrent,
    calls,
    events: state.events.map((event) => ({
      actor: event.actor,
      message: event.message,
      activity: event.activity,
    })),
  });
} catch (error) {
  report.error = error.message;
} finally {
  native.close();
  const canonical = await realpath(root);
  const base = await realpath(parent);
  const part = relative(base, canonical);
  if (
    !part ||
    isAbsolute(part) ||
    part.startsWith("..") ||
    !part.startsWith("timer-simulation-") ||
    (await readFile(join(canonical, ".cw-simulation-owned"), "utf8")) !== id
  )
    throw new Error("Refused unsafe simulation cleanup");
  await rm(canonical, { recursive: true, force: true });
  report.deleted = await access(root).then(
    () => false,
    () => true,
  );
  report.finishedAt = new Date().toISOString();
  const serialized = JSON.stringify(report, null, 2);
  await writeFile(join(parent, `timer-report-${id}.json`), serialized);
  await writeFile(join(parent, "timer-simulation-report.json"), serialized);
  console.log(
    JSON.stringify({
      report: resolve(parent, "timer-simulation-report.json"),
      passed: report.passed,
      deleted: report.deleted,
      status: report.status,
      error: report.error,
    }),
  );
}
if (!report.passed) process.exitCode = 1;
