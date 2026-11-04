import { digest } from "./workspace.js";

export function testFailure(validation, ownership = {}) {
  if (validation.passed || !validation.configured || validation.requiresConsent || validation.stale)
    return null;
  const output = validation.output ?? "";
  const cases = (validation.cases ?? []).filter((row) => row.status === "failed")
    .map((row) => `${row.id} ${row.title}`);
  const tap = [...output.matchAll(/^not ok\s+\d+\s+-\s+([^\r\n]+)/gm)]
    .map((match) => match[1].trim()).filter((name) => !/\s#\s*(?:SKIP|TODO)\b/i.test(name));
  const named = [...output.matchAll(/^\s*(?:FAIL\s+|✖\s+)([^\r\n]+)/gm)]
    .map((match) => match[1].trim().replace(/\s*\([\d.]+\s*ms\)$/, ""));
  const names = [...new Set(cases.length ? cases : [...tap, ...named])].slice(0, 8);
  const stack = output.split(/\r?\n/).filter((line) =>
    /^\s*(?:at\s|(?:error|code|expected|actual|failureType):)|AssertionError/.test(line),
  ).map((line) => line.trim()).slice(0, 12);
  if (!names.length || (!cases.length && !/AssertionError|ERR_ASSERTION|failureType:\s*['"]?testCodeFailure/.test(output)))
    return { status: "intervention", reason: validation.summary ?? "러너와 실행 명령을 확인하세요.", names, stack };
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError|EACCES|EPERM|ENOENT/.test(output) &&
      !/AssertionError|ERR_ASSERTION/.test(output))
    return { status: "intervention", reason: "실행 환경 또는 테스트 러너를 확인하세요.", names, stack };
  const normalized = output.replaceAll("\\", "/");
  const owners = Object.entries(ownership).filter(([path]) =>
    normalized.includes(`/${path}:`) || normalized.includes(`(${path}:`),
  ).map(([, row]) => row.taskId);
  const signature = digest(JSON.stringify([names, stack.filter((line) => !line.startsWith("at "))]));
  return { status: "diagnosed", names, stack, owners: [...new Set(owners)], signature };
}
