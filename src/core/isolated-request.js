import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
export async function isolatedRequest(context, operation) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "cw-agent-"));
  const safe = { ...context, snapshot: { ...context.snapshot, root: "." } };
  try {
    return await operation(root, safe);
  } finally {
    const actual = await realpath(root).catch(() => null);
    if (actual) {
      const part = relative(parent, actual);
      if (
        !part ||
        isAbsolute(part) ||
        part.startsWith("..") ||
        !part.startsWith("cw-agent-")
      )
        throw new Error("임시 세션 정리 경로를 확인하지 못했습니다.");
      await rm(actual, {
        recursive: true,
        force: true,
        maxRetries: 12,
        retryDelay: 100,
      });
    }
  }
}
