import {
  findCursorLaunch,
  captureCursor,
  parseCursorStatus,
  parseCursorModels,
  cursorACPModels,
} from "../src/core/cursor.js";
import { RpcProcess } from "../src/core/rpc-process.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const launch = await findCursorLaunch();
if (!launch) {
  console.log(JSON.stringify({ installed: false }));
  process.exit(0);
}
const result = await captureCursor(launch, ["status", "--format", "json"]);
let status = {};
try {
  status = JSON.parse(result.text);
} catch {}
const models = await captureCursor(launch, ["--list-models"]);
const rows = parseCursorModels(models.text);
const root = resolve("artifacts/cursor-metadata-workspace");
await mkdir(root, { recursive: true });
const rpc = new RpcProcess(launch.executable, [...launch.prefix, "acp"], {
  cwd: root,
});
let acp,
  stage = "initialize",
  metadata = {};
try {
  const init = await rpc.request(
    "initialize",
    {
      protocolVersion: 1,
      clientInfo: { name: "CW_Handsoff_sys", version: "0.5.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    },
    45000,
  );
  stage = "authenticate";
  await rpc.request("authenticate", { methodId: "cursor_login" });
  stage = "session/new";
  const session = await rpc.request("session/new", {
    cwd: root,
    mcpServers: [],
  });
  const nativeRows = cursorACPModels(session);
  const selected = nativeRows[0];
  metadata = {
    sessionKeys: Object.keys(session),
    modes: session.modes?.availableModes?.map((mode) => mode.id),
    models: nativeRows,
  };
  stage = "session/set_mode";
  await rpc.request("session/set_mode", {
    sessionId: session.sessionId,
    modeId: "ask",
  });
  stage = "session/set_model";
  if (!selected) throw new Error("Grok 모델 목록이 비어 있습니다.");
  await rpc.request("session/set_model", {
    sessionId: session.sessionId,
    modelId: selected.id,
  });
  acp = {
    initialized: true,
    authMethods: init.authMethods?.map((method) => method.id),
    ...metadata,
    modelSelected: selected.id,
    promptSent: false,
  };
} catch (error) {
  acp = {
    initialized: false,
    stage,
    rpcCode: error.rpcCode,
    message: error.message,
    ...metadata,
    promptSent: false,
  };
} finally {
  rpc.close();
}
const report = {
  checkedAt: new Date().toISOString(),
  installed: true,
  status: parseCursorStatus(status, result.code),
  models: rows,
  acp,
};
await writeFile(
  resolve("artifacts/cursor-metadata-check.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
