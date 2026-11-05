import { createRequire } from "node:module";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url),
  asar = require("@electron/asar");
const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");
const mac = process.argv.includes('--mac'), arch = process.argv.find(arg => arg.startsWith('--arch='))?.slice(7) ?? process.arch;
const output = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? (mac ? 'release-mac' : 'release'));
const appDirectory = mac ? join(output, arch === 'arm64' ? 'mac-arm64' : 'mac', 'CW_Handsoff_sys.app') : null;
const archive = mac ? join(appDirectory, 'Contents', 'Resources', 'app.asar') : join(output, "win-unpacked", "resources", "app.asar");
const entries = asar.listPackage(archive);
const allowed = /^(?:|package\.json|src|src\/(?:core|renderer|renderer\/assets|skills)|src\/[^/]+\.(?:js|cjs)|src\/core\/[^/]+\.js|src\/renderer\/[^/]+\.(?:js|css)|src\/renderer\/index\.html|src\/renderer\/assets\/mascot\.png|src\/skills\/(?:fun\.md|gemini-readonly\.toml)|node_modules|node_modules\/jose(?:\/.*)?)$/;
const assetAllowed = /^(?:src\/renderer\/splash\.html|src\/renderer\/assets\/(?:provider-(?:gpt|claude|gemini|grok)\.svg|providers-NOTICE\.txt|guide(?:\/(?:workspace|roles|output|design|test-report|workflow|services|settings)\.png)?))$/;
const unwanted = entries.filter((entry) => {
  const path = entry.replaceAll("\\", "/").replace(/^\//, "");
  const linked = Boolean(path && asar.statFile(archive, path.split("/").join(sep), false).link);
  return linked || (!allowed.test(path) && !assetAllowed.test(path) && !['LICENSE', 'NOTICE'].includes(path)) ||
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|vault[^/]*|auth\.json|oauth_creds\.json|credentials[^/]*|[^/]+\.(?:pem|pfx|enc))(?:\/|$)/i.test(path);
});
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
const legalFiles = ['LICENSE', 'NOTICE'];
for (const path of legalFiles) {
  if (!(await readFile(path)).equals(asar.extractFile(archive, path))) mismatches.push(path);
}
if (pack.license !== 'SEE LICENSE IN LICENSE') mismatches.push('package.json license');
const executable = mac ? join(output, `CW_Handsoff_sys-${pack.version}-Mac-${arch}.zip`) : join(output, `CW_Handsoff_sys ${pack.version}.exe`);
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
  mac ? join(appDirectory, 'Contents', 'MacOS', 'CW_Handsoff_sys') : join(output, "win-unpacked", "CW_Handsoff_sys.exe"),
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
  platform: mac ? 'darwin' : 'win32', arch: mac ? arch : 'x64',
  matchedSourceFiles: sources.length,
  matchedLegalFiles: legalFiles.length,
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
