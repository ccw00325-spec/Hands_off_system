import { readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function nextVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.([0-9])$/.exec(version);
  if (!match)
    throw new Error(
      "버전은 major.minor.patch 형식이며 patch는 0~9여야 합니다.",
    );
  let [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor].every(Number.isSafeInteger))
    throw new Error("버전 범위를 초과했습니다.");
  if (patch === 9) {
    minor++;
    patch = 0;
  } else patch++;
  if (!Number.isSafeInteger(minor))
    throw new Error("버전 범위를 초과했습니다.");
  return `${major}.${minor}.${patch}`;
}
export async function updateVersion(directory, version) {
  nextVersion(version);
  const packagePath = join(directory, "package.json");
  const lockPath = join(directory, "package-lock.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (!lock.packages?.[""])
    throw new Error("루트 package-lock 메타데이터가 필요합니다.");
  const readmePath = join(directory, "README.md");
  let readme;
  try {
    readme = await readFile(readmePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  manifest.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  await writeFile(packagePath, JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
  if (readme !== undefined)
    await writeFile(
      readmePath,
      readme
        .replace(/(Windows x64(?: · macOS arm64\/x64)? · v)\d+\.\d+\.\d+/, `$1${version}`)
        .replace(
          /release\/CW_Handsoff_sys \d+\.\d+\.\d+\.exe/g,
          `release/CW_Handsoff_sys ${version}.exe`,
        ),
    );
  return version;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const directory = dirname(dirname(fileURLToPath(import.meta.url)));
  const args = process.argv.slice(2);
  const manifest = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  const version =
    args.length === 1 && args[0] === "--next"
      ? nextVersion(manifest.version)
      : args.length === 2 && args[0] === "--set"
        ? args[1]
        : null;
  if (!version)
    throw new Error(
      "사용법: npm run version:next 또는 node scripts/release-version.mjs --set 0.1.0",
    );
  console.log("Release version: " + (await updateVersion(directory, version)));
}
