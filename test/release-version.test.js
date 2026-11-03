import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nextVersion, updateVersion } from "../scripts/release-version.mjs";
import { pruneRelease } from "../scripts/prune-release.mjs";
import { mkdir, symlink } from "node:fs/promises";
test("requested version sequence increments patches through nine then minor", () => {
  assert.equal(nextVersion("0.1.0"), "0.1.1");
  assert.equal(nextVersion("0.1.8"), "0.1.9");
  assert.equal(nextVersion("0.1.9"), "0.2.0");
  assert.equal(nextVersion("0.9.9"), "0.10.0");
  for (const version of [
    "0.1.10",
    "v0.1.0",
    "0.01.0",
    "0.1.0-beta",
    "1.0",
    "0.1.-1",
  ])
    assert.throws(() => nextVersion(version));
});
test("release metadata stays synchronized and resetting version does not modify identity or credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cw-release-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "cw-handsoff-sys",
      version: "0.7.0",
      build: { appId: "dev.agent.controltower" },
    }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      version: "0.7.0",
      packages: {
        "": { version: "0.7.0" },
        "node_modules/example": { version: "9.0.0" },
      },
    }),
  );
  await writeFile(
    join(root, "README.md"),
    "Windows x64 · v0.7.0\n`release/CW_Handsoff_sys 0.7.0.exe`",
  );
  await updateVersion(root, "0.1.0");
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8"),
  );
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.build.appId, "dev.agent.controltower");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.equal(lock.packages["node_modules/example"].version, "9.0.0");
  assert.match(await readFile(join(root, "README.md"), "utf8"), /0\.1\.0\.exe/);
});
test("cleanup keeps current build and unrelated files, refusing cleanup without a new build", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cw-prune-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(join(root, "release"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ version: "0.1.0" }),
  );
  for (const name of [
    "Agent Control Tower 0.1.0.exe",
    "CW_Handsoff_sys 0.7.0.exe",
    "builder-debug.yml",
    "personal-notes.txt",
  ])
    await writeFile(join(root, "release", name), "fixture");
  await assert.rejects(pruneRelease(root), { code: "ENOENT" });
  assert.equal(
    await readFile(join(root, "release", "CW_Handsoff_sys 0.7.0.exe"), "utf8"),
    "fixture",
  );
  await writeFile(
    join(root, "release", "CW_Handsoff_sys 0.1.0.exe"),
    "new fixture",
  );
  const result = await pruneRelease(root);
  assert.equal(result.removed.length, 3);
  assert.equal(
    await readFile(join(root, "release", result.kept), "utf8"),
    "new fixture",
  );
  assert.equal(
    await readFile(join(root, "release", "personal-notes.txt"), "utf8"),
    "fixture",
  );
});
test("release cleanup rejects a junction pointing outside the workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cw-prune-link-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(join(root, "workspace"));
  await mkdir(join(root, "outside"));
  await writeFile(
    join(root, "workspace", "package.json"),
    JSON.stringify({ version: "0.1.0" }),
  );
  await symlink(
    join(root, "outside"),
    join(root, "workspace", "release"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    pruneRelease(join(root, "workspace")),
    /inside the project/,
  );
});
