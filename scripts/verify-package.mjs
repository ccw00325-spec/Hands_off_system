import { createRequire } from "node:module";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url),
  asar = require("@electron/asar");
const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");
const archive = resolve("release/win-unpacked/resources/app.asar");
const entries = asar.listPackage(archive);
const unwanted = entries.filter((path) =>
  /@anthropic-ai|@modelcontextprotocol|\.runtime|vault\.enc|smoke-profile|[\\/]\.tools[\\/]/.test(
    path,
  ),
);
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}
const sources = await files("src"),
  mismatches = [];
for (const path of sources) {
  const native = await readFile(path),
    packed = asar.extractFile(archive, path);
  if (!native.equals(packed)) mismatches.push(path);
}
const pack = JSON.parse(asar.extractFile(archive, "package.json"));
const executable = resolve(`release/CW_Handsoff_sys ${pack.version}.exe`);
const sha256 = createHash("sha256")
  .update(await readFile(executable))
  .digest("hex");
const expectedFuses = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
};
const wire = await getCurrentFuseWire(
  resolve("release/win-unpacked/CW_Handsoff_sys.exe"),
);
const fuseSettings = Object.fromEntries(
  Object.entries(expectedFuses).map(([name]) => [
    name,
    wire[FuseV1Options[name]] === 49,
  ]),
);
const fuseMismatches = Object.entries(expectedFuses)
  .filter(([name, value]) => fuseSettings[name] !== value)
  .map(([name]) => name);
const report = {
  version: pack.version,
  matchedSourceFiles: sources.length,
  mismatches,
  unwantedEntries: unwanted,
  exeBytes: (await stat(executable)).size,
  sha256,
  fuseSettings,
  fuseMismatches,
};
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/package-verification.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
if (mismatches.length || unwanted.length || fuseMismatches.length)
  process.exitCode = 1;
