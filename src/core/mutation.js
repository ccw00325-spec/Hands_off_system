import { createHash, randomUUID } from "node:crypto";
import { validateProject } from "./validation.js";

export async function runMutation(workspace, context, validate = (request) => validateProject(workspace, request)) {
  const { projectId, grantId, options } = context;
  const reportPath = `.control-tower/mutation-${randomUUID()}.json`;
  if (options.allowExecution === true)
    await workspace.locate(projectId, reportPath, {
      internal: true,
      grantId,
      create: true,
    });
  const result = await validate({
    ...context,
    environment: { TOWER_MUTATION_REPORT: reportPath },
    options: { ...options, testPlan: null, validationScript: "test:mutation" },
  });
  if (!result.passed)
    return { ...result, status: "blocked" };
  let report;
  try {
    report = JSON.parse(
      await workspace.read(projectId, reportPath, { internal: true, grantId }),
    );
  } catch {
    return { ...result, passed: false, status: "blocked", summary: "새 Stryker JSON 보고서를 읽지 못했습니다." };
  }
  const counts = Object.create(null);
  const findings = [];
  const identities = [];
  let total = 0;
  for (const [file, data] of Object.entries(report?.files ?? {})) {
    if (!Array.isArray(data?.mutants)) continue;
    for (const mutant of data.mutants) {
      const status =
        typeof mutant?.status === "string" ? mutant.status.slice(0, 40) : "Unknown";
      identities.push(JSON.stringify([
        file,
        mutant?.location,
        mutant?.mutatorName,
        mutant?.replacement,
      ]));
      total++;
      counts[status] = (counts[status] ?? 0) + 1;
      if (status !== "Killed" && findings.length < 30)
        findings.push({
          file: file.slice(0, 500),
          line: Number(mutant?.location?.start?.line) || null,
          status,
          operator: String(mutant?.mutatorName ?? "").slice(0, 100),
          replacement: String(mutant?.replacement ?? "").slice(0, 200),
        });
    }
  }
  const passed = total > 0 && counts.Killed === total;
  return {
    ...result,
    output: undefined,
    passed,
    status: passed ? "passed" : total ? "findings" : "blocked",
    total,
    counts,
    findings,
    reportPath,
    scopeHash: createHash("sha256").update(JSON.stringify(identities.sort())).digest("hex"),
    summary: total ? `${total}개 변이 · ${counts.Killed ?? 0}개 탐지 · ${total - (counts.Killed ?? 0)}개 확인 필요` : "실행된 변이가 없습니다. 검사 범위를 확인하세요.",
  };
}
