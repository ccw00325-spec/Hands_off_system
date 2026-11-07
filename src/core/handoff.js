import { redactData } from './secrets.js';
// Keep the persisted handoff complete. Only remove exact duplicate long text
// from the provider-bound copy, with an explicit reference to its canonical field.
export function compactHandoff(context, handoff) {
  const result = { ...handoff };
  for (const [key, field] of [['request', 'request'], ['specification', 'spec']]) {
    if (typeof context[field] === 'string' && context[field].length >= 128 && context[field] === result[key]) {
      delete result[key];
      result[key + 'Ref'] = field;
    }
  }
  if (typeof context.task?.instructions === 'string' && context.task.instructions.length >= 128 && context.task.instructions === result.task?.instructions) {
    result.task = { ...result.task, instructionsRef: 'task.instructions' };
    delete result.task.instructions;
  }
  return result;
}
export function stateHandoff(state, actor, action, context) {
  const task = context.task;
  return redactData({
    schemaVersion: 1, runId: state.id, actor, action, createdAt: new Date().toISOString(),
    request: state.request ?? context.message ?? '', specification: state.spec ?? context.spec ?? null,
    task: task ? { id: task.id, owner: task.owner, kind: task.kind, instructions: task.instructions, criteria: task.acceptanceCriteria, dependsOn: task.dependsOn, writePaths: task.writePaths, readPaths: task.readPaths } : null,
    source: { hash: context.snapshot?.hash, files: context.snapshot?.files?.map(row => ({ path: row.path, hash: row.hash })) ?? [] },
    completedTasks: (state.tasks ?? []).filter(row => ['reported', 'done', 'complete'].includes(row.status)).map(row => ({ id: row.id, owner: row.owner, status: row.status, summary: row.report?.summary ?? row.summary, checkpoint: row.checkpointId })),
    changeBatches: (state.changes ?? []).slice(-60).map(row => ({ taskId:row.taskId, path:row.path, checkpoint:row.checkpoint })),
    recentFacts: (state.events ?? []).slice(-12).map(row => ({ at: row.at, actor: row.actor, message: row.message, taskId: row.taskId })),
    conversation: (context.history ?? state.options?.conversationHistory ?? []).slice(-12),
    userDecisions: state.options?.questionAnswers ?? [],
    findings: context.issues ?? [], validation: state.validation ? { summary: state.validation.summary, passed: state.validation.passed, command: state.validation.command, output: state.validation.output?.slice(-6000) } : null,
    constraint: 'This is a factual task-state handoff, not vendor session memory or hidden chain-of-thought. Preserve verified facts, file hashes, criteria and unresolved findings. Re-read supplied source before modifying it.',
  });
}
