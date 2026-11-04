import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "./workspace.js";

export async function pushVerifiedCommit({ gitRun, url, cwd, store, identity, parent, expectedParent, account }) {
  const key = "release-commit-" + digest(JSON.stringify(identity));
  const bundle = join(store.directory, key + ".bundle");
  const saved = await store.read(key, null);
  const staged = await gitRun("write-tree");
  // Compare the staged tree to the parent so retries do not create duplicate commits.
  if (saved) {
    if (staged !== saved.tree || ((parent ?? null) !== saved.parent && parent !== saved.commit))
      throw new Error("검증된 커밋의 기준과 원격 상태가 달라졌습니다.");
    if (parent !== saved.commit) {
      await gitRun("fetch", "--no-tags", bundle, "HEAD");
      if ((await gitRun("rev-parse", "FETCH_HEAD")) !== saved.commit)
        throw new Error("보관된 커밋을 확인할 수 없습니다.");
      await gitRun("reset", "--soft", "FETCH_HEAD");
    }
  } else if (await gitRun("status", "--porcelain")) {
    if (parent !== expectedParent)
      throw new Error("Unexpected remote revision");
    await gitRun(
      "-c",
      `user.name=${account}`,
      "-c",
      `user.email=${account}@users.noreply.github.com`,
      "commit",
      "-m",
      "Publish verified Hands off project",
    );
  }
  const commit = await gitRun("rev-parse", "HEAD");
  if (commit !== parent && !saved) {
    const candidate = join(cwd, ".git", "handoff.bundle");
    await gitRun("bundle", "create", candidate, "HEAD", ...(parent ? ["^" + parent] : []));
    await copyFile(candidate, bundle);
    await store.write(key, { commit, parent: parent ?? null, tree: staged });
  }
  if (commit !== parent) await gitRun("push", url, "HEAD:refs/heads/main");
  return { commit, key, bundle };
}
