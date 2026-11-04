import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { RpcProcess } from "./rpc-process.js";
import { findExecutable } from "./providers.js";
import { officialClaudeArgs } from "./claude-options.js";
import { nativeEnvironment } from "./child-env.js";

const finitePercent = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100;
const timestamp = (value) => {
  if (value === null || value === undefined) return null;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
};
export function claudeMeters(report) {
  if (!Array.isArray(report?.rate_limits?.limits)) return null;
  if (
    report.rate_limits.limits.some((row) => !row || !finitePercent(row.percent))
  )
    return null;
  return report.rate_limits.limits
    .filter((row) => finitePercent(row.percent))
    .map((row) => ({
      id: String(row.kind || "unknown"),
      label: String(row.kind || "unknown"),
      group: String(row.group || ""),
      usedPercent: row.percent,
      remainingPercent: Math.round((100 - row.percent) * 10) / 10,
      resetsAt: timestamp(row.resets_at),
      active: row.is_active !== false,
      model: row.scope?.model?.display_name ?? null,
      surface: row.scope?.surface?.display_name ?? null,
    }));
}
export function codexMeters(response) {
  const bucket = response?.rateLimits;
  if (!bucket) return null;
  const result = [];
  for (const key of ["primary", "secondary"]) {
    const window = bucket[key];
    if (!window) continue;
    if (!finitePercent(window.usedPercent)) return null;
    result.push({
      id: key,
      label: bucket.limitName || bucket.limitId || "Codex",
      windowMinutes: window.windowDurationMins ?? null,
      usedPercent: window.usedPercent,
      remainingPercent: Math.round((100 - window.usedPercent) * 10) / 10,
      resetsAt: timestamp(window.resetsAt),
      active: true,
    });
  }
  return result;
}
export function minimumRemaining(meters) {
  const values =
    meters
      ?.filter((row) => row.active !== false)
      .map((row) => row.remainingPercent)
      .filter(finitePercent) ?? [];
  return values.length ? Math.min(...values) : null;
}
const empty = (provider, state, message) => ({
  provider,
  state,
  message,
  remainingPercent: null,
  meters: [],
  checkedAt: new Date().toISOString(),
});

export class CodexUsage {
  constructor(notify = () => {}, dependencies = {}) {
    this.notify = notify;
    this.find =
      dependencies.find ??
      (async () => {
        const path = await findExecutable("codex");
        if (path) return path;
        if (process.platform === "win32" && process.env.LOCALAPPDATA) {
          const installed = join(
            process.env.LOCALAPPDATA,
            "Programs",
            "OpenAI",
            "Codex",
            "bin",
            "codex.exe",
          );
          try {
            await access(installed);
            return installed;
          } catch {}
        }
        return null;
      });
    this.rpcFactory =
      dependencies.rpcFactory ?? ((...args) => new RpcProcess(...args));
    this.rpc = null;
    this.ready = null;
  }
  async connect() {
    if (this.rpc && !this.rpc.closed) return this.rpc;
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const executable = await this.find();
      if (!executable) return null;
      const rpc = this.rpcFactory(executable, ["app-server", "--stdio"], {
        onNotification: (method, params) => {
          if (method === "account/rateLimits/updated") this.notify(params);
          if (method === "account/updated")
            this.notify({ changedAccount: true });
        },
      });
      this.rpc = rpc;
      try {
        await rpc.request("initialize", {
          clientInfo: {
            name: "agent_control_tower_usage",
            title: "CW_Handsoff_sys usage",
            version: "0.5.0",
          },
          capabilities: {},
        });
        rpc.notify("initialized", {});
        return rpc;
      } catch (error) {
        rpc.close();
        this.rpc = null;
        throw error;
      }
    })().finally(() => {
      this.ready = null;
    });
    return this.ready;
  }
  async read() {
    try {
      const rpc = await this.connect();
      if (!rpc)
        return empty(
          "codex",
          "not-installed",
          "Codex CLI 설치 시 별도 계정의 사용 한도를 조회할 수 있습니다.",
        );
      const identity = await rpc.request("account/read", {
        refreshToken: false,
      });
      if (identity?.account?.type !== "chatgpt")
        return empty(
          "codex",
          "not-connected",
          "Codex CLI의 ChatGPT 로그인이 필요합니다.",
        );
      const response = await rpc.request("account/rateLimits/read");
      const meters = codexMeters(response);
      return {
        provider: "codex",
        state: meters?.length ? "available" : "unavailable",
        message:
          "Codex CLI 계정의 참고 한도입니다. 이 앱의 GPT 직접 로그인 계정과 같다고 가정하지 않습니다.",
        accountLabel: identity.account.email ?? "Codex CLI 계정",
        remainingPercent: minimumRemaining(meters),
        meters: meters ?? [],
        checkedAt: new Date().toISOString(),
      };
    } catch {
      this.rpc?.close();
      this.rpc = null;
      return empty(
        "codex",
        "unavailable",
        "Codex CLI 사용량 조회에 실패했습니다. 연결과 CLI 버전을 확인하세요.",
      );
    }
  }
  close() {
    this.rpc?.close();
    this.rpc = null;
  }
}

export async function readClaudeUsage(
  connection,
  { cwd, spawnProcess = spawn } = {},
) {
  const status = await connection.status({ force: true });
  if (!status.connected)
    return empty(
      "claude",
      status.installed ? "not-connected" : "not-installed",
      "Claude Code 로그인을 연결하세요.",
    );
  const executable = await connection.executable();
  if (!executable)
    return empty("claude", "not-installed", "Claude Code 설치가 필요합니다.");
  return new Promise((resolve) => {
    const child = spawnProcess(
      executable,
      [
        "-p",
        "/usage",
        ...officialClaudeArgs(),
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      {
        cwd,
        env: nativeEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const lines = createInterface({ input: child.stdout });
    let report = null,
      finished = false;
    const done = (state, message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      const meters = claudeMeters(report);
      resolve(
        meters?.length
          ? {
              provider: "claude",
              state: "available",
              message: "공식 Claude Code /usage의 구독 사용 한도입니다.",
              remainingPercent: minimumRemaining(meters),
              meters,
              checkedAt: new Date().toISOString(),
            }
          : empty("claude", state, message),
      );
    };
    const timer = setTimeout(() => {
      child.kill();
      done("unavailable", "Claude 사용량 조회 시간이 초과되었습니다.");
    }, 20000);
    lines.on("line", (line) => {
      if (line.length > 1_000_000) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "assistant" && event.usage_report)
          report = event.usage_report;
      } catch {}
    });
    child.once("error", () =>
      done("unavailable", "공식 Claude Code를 실행하지 못했습니다."),
    );
    child.once("close", (code) =>
      done(
        code === 0 ? "unsupported" : "unavailable",
        code === 0
          ? "CLI가 구조화된 사용 한도를 제공하지 않았습니다. 공식 사용량 페이지에서 확인하세요."
          : "Claude 사용량을 확인하지 못했습니다. 공식 로그인 상태를 다시 확인하세요.",
      ),
    );
  });
}

export class UsageService {
  constructor({
    claude,
    codex,
    cwd,
    notify = () => {},
    auto = true,
    claudeReader = readClaudeUsage,
  }) {
    this.claude = claude;
    this.codex = codex;
    this.cwd = cwd;
    this.notify = notify;
    this.auto = auto;
    this.claudeReader = claudeReader;
    this.pending = null;
    this.value = {
      checkedAt: null,
      providers: {
        gpt: empty(
          "gpt",
          "unsupported",
          "GPT 직접 로그인 경로는 공식 사용량 페이지를 제공합니다. 숫자 잔량 자동 조회는 확인되지 않았습니다.",
        ),
        claude: empty("claude", "not-queried", "아직 조회하지 않았습니다."),
        grok: empty(
          "grok",
          "unsupported",
          "Grok 작업에는 Cursor 계정의 한도가 적용됩니다. 잔여 비율 자동 조회는 확인되지 않아 Cursor 대시보드로 안내합니다.",
        ),
        codex: empty(
          "codex",
          "not-queried",
          "Codex CLI 별도 계정의 참고 한도입니다.",
        ),
      },
    };
  }
  snapshot() {
    return structuredClone(this.value);
  }
  async refresh({ force = false } = {}) {
    if (this.pending) return this.pending;
    if (
      !force &&
      this.lastStartedAt &&
      Date.now() - this.lastStartedAt < 9500
    )
      return this.snapshot();
    this.lastStartedAt = Date.now();
    this.pending = (async () => {
      const result = await Promise.allSettled([
        this.claudeReader(this.claude, { cwd: this.cwd }),
        this.codex.read(),
      ]);
      for (const [index, key] of ["claude", "codex"].entries()) {
        if (result[index].status === "fulfilled")
          this.value.providers[key] = result[index].value;
        else
          this.value.providers[key] = empty(
            key,
            "unavailable",
            "공식 사용량 조회에 실패했습니다.",
          );
      }
      this.value.checkedAt = new Date().toISOString();
      this.notify({ type: "usage", usage: this.snapshot() });
      return this.snapshot();
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  pushCodex(response) {
    if (response?.changedAccount) {
      this.value.providers.codex = empty(
        "codex",
        "not-queried",
        "Codex CLI 계정이 바뀌어 사용량을 다시 확인해야 합니다.",
      );
      this.notify({ type: "usage", usage: this.snapshot() });
      return;
    }
    const old = this.value.providers.codex;
    if (old.state !== "available") return;
    const meters = codexMeters(response);
    if (!meters?.length) return;
    this.value.providers.codex = {
      ...old,
      meters,
      remainingPercent: minimumRemaining(meters),
      checkedAt: new Date().toISOString(),
    };
    this.notify({ type: "usage", usage: this.snapshot() });
  }
  close() {
    this.codex.close();
  }
}
