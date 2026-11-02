import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GeminiConnection, GEMINI_VERSION } from "../src/core/gemini.js";
const root = resolve("artifacts/gemini-metadata-workspace");
await mkdir(root, { recursive: true });
const connection = new GeminiConnection(root);
const status = await connection.status({ force: true });
const report = {
  checkedAt: new Date().toISOString(),
  officialVersion: GEMINI_VERSION,
  installed: status.installed,
  connected: status.connected,
  state: status.state,
  operation:
    "ACP initialize and session/new only; no authenticate, model prompt or credential extraction",
};
await writeFile(
  resolve("artifacts/gemini-metadata-check.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
connection.cancel();
