import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ClaudeConnection } from "../src/core/claude.js";
import { ClaudeProvider } from "../src/core/providers.js";
import { CursorConnection } from "../src/core/cursor.js";
import { CursorProvider } from "../src/core/cursor-provider.js";
import { GeminiConnection, GeminiProvider } from "../src/core/gemini.js";
import { Store } from "../src/core/store.js";

const directory = resolve("artifacts/live-agent-check");
await mkdir(directory, { recursive: true });
const store = new Store(directory, {});
await store.init();
const claude = new ClaudeConnection();
const cursor = new CursorConnection(() => {}, { cwd: directory });
const grok = new CursorProvider(store, () => {}, cursor);
const gemini = new GeminiConnection(directory, () => {}, {
  developmentRoot: resolve(".tools/gemini"),
});
const report = {
  checkedAt: new Date().toISOString(),
  operation:
    "Explicit real native CLI inference, empty source snapshot, no files applied",
  agents: {},
};
async function probe(name, connection, provider, options) {
  const state = await connection.status({ force: true });
  const row = (report.agents[name] = {
    installed: state.installed,
    connected: state.connected,
    inferencePassed: false,
  });
  if (!state.connected) {
    row.reason =
      "Official native login required; no interactive approval attempted";
    return;
  }
  try {
    const result = await provider.build({
      snapshot: { root: directory, files: [] },
      task: {
        id: "native_probe",
        title: "Connection verification",
        instructions:
          'This is a native connection smoke test. Do not use tools or create files. Return JSON {"summary":"native connection verified","files":[]}.',
        acceptanceCriteria: ["Return a valid empty file manifest"],
      },
      issues: [],
      spec: "Read-only connection probe; do not edit any file.",
      options,
      signal: new AbortController().signal,
    });
    row.inferencePassed =
      Array.isArray(result.files) &&
      result.files.length === 0 &&
      typeof result.summary === "string";
  } catch (error) {
    row.error = error.message;
  }
}
await probe("claude", claude, new ClaudeProvider(claude), {});
try {
  const state = await cursor.status();
  if (state.connected) {
    const catalog = await cursor.models();
    const model = catalog[0];
    if (!model) throw new Error("No Grok model in current Cursor account");
    report.grokModel = model.id;
    await probe("grok-via-cursor", cursor, grok, {
      grokRoute: { source: "cursor", modelId: model.id },
    });
  } else await probe("grok-via-cursor", cursor, grok, {});
} catch (error) {
  report.agents["grok-via-cursor"] = {
    inferencePassed: false,
    error: error.message,
  };
}
const google = await gemini.status({ force: true });
if (google.connected) {
  const models = await gemini.models();
  await probe("gemini", gemini, new GeminiProvider(gemini), {
    geminiModel: models[0]?.id,
  });
} else
  report.agents.gemini = {
    installed: google.installed,
    connected: google.connected,
    inferencePassed: false,
    reason: "Google approval is user-owned; not attempted when unauthenticated",
  };
await writeFile(
  resolve("artifacts/live-agent-check.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
claude.cancel();
cursor.cancel();
gemini.cancel();
if (
  Object.values(report.agents).some(
    (row) => row.connected && !row.inferencePassed,
  )
)
  process.exitCode = 1;
