import { access } from "node:fs/promises";
import { toolRoots } from './tool-paths.js';
import {
  join,
  dirname,
  basename,
  isAbsolute,
  relative,
} from "node:path";
export async function nodeRuntime(excludedRoot = null) {
  const roots = [
    ...(basename(process.execPath).toLowerCase() === "node.exe" ||
    basename(process.execPath) === "node"
      ? [dirname(process.execPath)]
      : []),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "nodejs"),
    ...await toolRoots('node'),
  ].filter((root) => root && isAbsolute(root));
  for (const root of roots) {
    if (excludedRoot) {
      const part = relative(excludedRoot, root);
      if (!part || (!part.startsWith("..") && !isAbsolute(part))) continue;
    }
    const executable = join(
      root,
      process.platform === "win32" ? "node.exe" : "node",
    );
    try {
      await access(executable);
      return executable;
    } catch {}
  }
  return null;
}
