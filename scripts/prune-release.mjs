import { readFile, readdir, realpath, lstat, unlink } from "node:fs/promises";
import { join, resolve, relative, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function pruneRelease(directory) {
  const root = await realpath(directory);
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
    throw new Error("Invalid release version");
  const release = join(root, "release");
  if (
    (await lstat(release)).isSymbolicLink() ||
    relative(root, await realpath(release)) !== "release"
  )
    throw new Error("Release directory must remain inside the project");
  const current = `CW_Handsoff_sys ${manifest.version}.exe`;
  const currentInfo = await lstat(join(release, current));
  if (
    !currentInfo.isFile() ||
    currentInfo.isSymbolicLink() ||
    currentInfo.size === 0
  )
    throw new Error("Current build must exist before removing old releases");
  const names = (await readdir(release)).filter(
    (name) =>
      name !== current &&
      (/^(?:Agent Control Tower|CW_Handsoff_sys) \d+\.\d+\.\d+\.exe$/.test(
        name,
      ) ||
        name === "builder-debug.yml"),
  );
  const targets = [];
  for (const name of names) {
    const target = join(release, name);
    const info = await lstat(target);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      relative(release, await realpath(target)) !== name
    )
      throw new Error("Refused non-file or redirected release target");
    targets.push(target);
  }
  // All resolved targets have been checked before the first deletion; never recurse.
  const removed = [];
  const blocked = [];
  for (const target of targets) {
    for (let attempt = 0; ; attempt++) {
      try {
        await unlink(target);
        removed.push(basename(target));
        break;
      } catch (error) {
        if (error.code === "ENOENT") break;
        if (!["EBUSY", "EPERM"].includes(error.code) || attempt === 4) {
          blocked.push({ name: basename(target), code: error.code });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  return { kept: current, removed, blocked };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await pruneRelease(
    dirname(dirname(fileURLToPath(import.meta.url))),
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.blocked.length) {
    console.error(
      "정리하지 못한 파일이 있습니다. 이전 앱을 닫거나 파일 권한을 확인한 뒤 node scripts/prune-release.mjs를 다시 실행하세요.",
    );
    process.exitCode = 1;
  }
}
