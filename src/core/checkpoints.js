import { randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { digest, relativeFile } from "./workspace.js";
import { secretFinding } from "./secrets.js";

const root = ".control-tower/checkpoints";
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const hash = (text) => text === null ? null : digest(text);
const conflict = (path, actualHash) => Object.assign(new Error(`파일이 외부에서 변경되었습니다: ${path}`), { code: "WORKSPACE_CONFLICT", path, actualHash });

async function readCurrent(workspace, projectId, path, grantId) {
  try {
    return (await workspace.read(projectId, path, { grantId })).toString("utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function apply(workspace, projectId, grantId, row, reverse = false) {
  const before = reverse ? row.after : row.before;
  const after = reverse ? row.before : row.after;
  if (after !== null)
    return workspace.writeUnlocked(projectId, row.path, after, { grantId, baseHash: hash(before) });
  const { target } = await workspace.locate(projectId, row.path, { grantId });
  if (hash(await readCurrent(workspace, projectId, row.path, grantId)) !== hash(before))
    throw new Error(`파일이 외부에서 변경되었습니다: ${row.path}`);
  await unlink(target);
}

async function commit(workspace, projectId, grantId, rows, label, runId) {
  const id = randomUUID();
  const path = `${root}/${id}.json`;
  const sequenceFile = `${root}/sequence.json`;
  const previous = await workspace.read(projectId, sequenceFile, { internal: true, grantId })
    .then((value) => JSON.parse(value).sequence, (error) => {
      if (error.code !== "ENOENT") throw error;
      return 0;
    });
  if (!Number.isSafeInteger(previous) || previous < 0) throw new Error("체크포인트 순서를 확인할 수 없습니다.");
  const sequence = previous + 1;
  await workspace.writeUnlocked(projectId, sequenceFile, JSON.stringify({ sequence }), { internal: true, grantId });
  const journal = { id, grantId, label, rows, runId, sequence, at: new Date().toISOString() };
  const save = async (status) => {
    const options = { internal: true, grantId };
    const { rows: _rows, ...metadata } = journal;
    await workspace.writeUnlocked(projectId, `${root}/${id}.meta.json`, JSON.stringify({ ...metadata, status }), options);
    await workspace.writeUnlocked(projectId, path, JSON.stringify({ ...journal, status }), options);
  };
  await save("pending");
  const written = [];
  try {
    for (const row of rows) {
      await apply(workspace, projectId, grantId, row);
      written.push(row);
    }
    await save("committed");
  } catch (error) {
    let failed = false;
    for (const row of written.reverse())
      try { await apply(workspace, projectId, grantId, row, true); }
      catch { failed = true; }
    await save(failed ? "recovery" : "reverted").catch(() => {});
    throw failed ? new Error("변경 복구가 필요합니다. 체크포인트를 확인하세요.") : error;
  }
  return id;
}

export function applyBatch(workspace, projectId, grantId, files, label, dependencies = [], runId) {
  return workspace.serialize(projectId, async () => {
    for (const dependency of dependencies) {
      const actualHash = hash(await readCurrent(workspace, projectId, dependency.path, grantId));
      if (actualHash !== dependency.baseHash) throw conflict(dependency.path, actualHash);
    }
    const rows = [];
    for (const file of files) {
      const before = await readCurrent(workspace, projectId, file.path, grantId);
      if (hash(before) !== file.baseHash) throw conflict(file.path, hash(before));
      if (before !== file.content)
        rows.push({ path: file.path, before, after: file.content });
    }
    if (!rows.length) return null;
    return commit(workspace, projectId, grantId, rows, label, runId);
  });
}

export async function listCheckpoints(workspace, projectId, grantId) {
  let entries;
  try {
    const { target } = await workspace.locate(projectId, root, { internal: true, grantId });
    entries = await readdir(target);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const rows = [];
  for (const name of entries.filter((entry) => entry.endsWith(".meta.json"))) {
    const item = JSON.parse(await workspace.read(projectId, `${root}/${name}`, { internal: true, grantId }));
    if (item.grantId === grantId) rows.push({ id: item.id, label: item.label, at: item.at, status: item.status, sequence: item.sequence, runId: item.runId });
  }
  return rows.sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0) || b.at.localeCompare(a.at));
}

export async function verifiedCheckpoint(workspace, projectId, grantId) {
  return workspace.read(projectId, `${root}/verified.json`, { internal: true, grantId })
    .then((data) => {
      const marker = JSON.parse(data);
      return marker.grantId === grantId ? marker : null;
    }, (error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
}

export async function markVerified(workspace, projectId, grantId, snapshot) {
  const checkpoints = await listCheckpoints(workspace, projectId, grantId);
  const marker = {
    at: new Date().toISOString(), grantId,
    sequence: Math.max(0, ...checkpoints.map((item) => item.sequence ?? 0)),
    files: Object.fromEntries(snapshot.files.filter(({path}) => !generatedSpec(path)).map(({path, hash}) => [path, hash])),
  };
  await workspace.write(projectId, `${root}/verified.json`, JSON.stringify(marker), { internal: true, grantId });
}

const generatedSpec = (path) => /^Function\/[0-9a-f-]{36}_fun\.md$/.test(path);

export function restoreCheckpoint(workspace, projectId, grantId, id, confirmation) {
  if (typeof id !== "string" || !/^(?:verified|run:[0-9a-f-]{36})$/.test(id) && !idPattern.test(id)) throw new Error("체크포인트 ID가 올바르지 않습니다.");
  return workspace.serialize(projectId, async () => {
    const marker = id === "verified" ? await verifiedCheckpoint(workspace, projectId, grantId) : null;
    if (id === "verified" && !marker) throw new Error("검증 통과 기록이 없습니다.");
    const entries = idPattern.test(id) ? [{id}] :
      (await listCheckpoints(workspace, projectId, grantId)).filter((item) =>
        marker ? item.sequence > marker.sequence : item.runId === id.slice(4));
    if (entries.some((item) => ["pending", "recovery"].includes(item.status)))
      throw new Error("미완료 변경 묶음을 먼저 개별 복원하세요.");
    const chain = new Map();
    for (const entry of entries.filter((item) => item.status !== "reverted").sort((a, b) => a.sequence - b.sequence)) {
      const journal = JSON.parse(await workspace.read(projectId, `${root}/${entry.id}.json`, {
        internal: true, grantId, maxBytes: 128 * 1024 * 1024,
      }));
      if (journal.grantId !== grantId) throw new Error("다른 폴더의 체크포인트입니다.");
      for (const row of journal.rows) {
        const previous = chain.get(row.path);
        if (previous && previous.after !== row.before)
          throw new Error(`변경 기록이 이어지지 않습니다: ${row.path}`);
        chain.set(row.path, previous ? { ...row, before: previous.before } : row);
      }
    }
    const rows = [];
    const preview = [];
    for (const row of chain.values()) {
      relativeFile(row.path);
      const current = await readCurrent(workspace, projectId, row.path, grantId);
      const action = current === row.before ? "unchanged"
        : current !== row.after ? "conflict"
          : row.before === null ? "delete" : "restore";
      preview.push({ path: row.path, action });
      if (action === "delete" || action === "restore") {
        if (row.before !== null && secretFinding(row.before))
          throw new Error(`비밀값이 포함된 파일은 자동 복원할 수 없습니다: ${row.path}`);
        rows.push({ path: row.path, before: current, after: row.before });
      }
    }
    if (marker) {
      const snapshot = await workspace.snapshot(projectId);
      if (snapshot.truncated) throw new Error("프로젝트 전체 파일 상태를 확인할 수 없습니다.");
      const paths = new Set([...Object.keys(marker.files), ...snapshot.files.map((file) => file.path), ...chain.keys()]);
      const current = new Map(snapshot.files.map((file) => [file.path, file.hash]));
      for (const path of paths) {
        if (generatedSpec(path)) continue;
        const expected = Object.hasOwn(marker.files, path) ? marker.files[path] : null;
        const projected = chain.has(path) ? hash(chain.get(path).before) : current.get(path) ?? null;
        if (projected !== expected) preview.push({ path, action: "conflict" });
      }
    }
    const token = digest(JSON.stringify({ preview, entries: entries.map((item) => item.id), marker: marker?.at }));
    const canRestore = !preview.some((row) => row.action === "conflict") && rows.length > 0;
    if (!confirmation || !canRestore)
      return { preview, token, canRestore, id: null };
    if (confirmation !== token) throw new Error("파일이 변경됐습니다. 복원 미리보기를 다시 확인하세요.");
    await workspace.writeUnlocked(projectId, ".control-tower/restored.json",
      JSON.stringify({ at: new Date().toISOString() }), { internal: true, grantId });
    return { preview, id: await commit(workspace, projectId, grantId, rows, `복원 ${id}`) };
  });
}
