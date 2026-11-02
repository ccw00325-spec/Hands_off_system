import { spawn } from "node:child_process";
import { nativeEnvironment } from "./child-env.js";
const HOSTS = {
  claude: new Set([
    "claude.ai",
    "platform.claude.com",
    "console.anthropic.com",
    "console.claude.com",
    "auth.anthropic.com",
  ]),
  grok: new Set([
    "auth.x.ai",
    "accounts.x.ai",
    "grok.com",
    "accounts.grok.com",
  ]),
  cursor: new Set([
    "cursor.com",
    "www.cursor.com",
    "cursor.sh",
    "authenticator.cursor.sh",
    "accounts.spacex.ai",
    "accounts.x.ai",
    "auth.x.ai",
  ]),
  gemini: new Set(["accounts.google.com", "oauth2.googleapis.com"]),
};
export function authorizationURL(text, provider) {
  const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  for (const value of clean.match(/https:\/\/[^\s<>"\x1b]+/g) ?? []) {
    try {
      const url = new URL(value.replace(/[),.;]+$/, ""));
      if (
        !HOSTS[provider]?.has(url.hostname) ||
        url.port ||
        url.username ||
        url.password ||
        url.hash ||
        url.href.length > 10000
      )
        continue;
      if (
        [...url.searchParams.keys()].some((key) =>
          /^(access_token|refresh_token|id_token|token)$/i.test(key),
        )
      )
        continue;
      if (!/oauth|authorize|device|login|auth|activate/i.test(url.pathname))
        continue;
      return url.href;
    } catch {}
  }
  return null;
}
export class LoginFlow {
  constructor(provider, notify = () => {}, dependencies = {}) {
    this.provider = provider;
    this.notify = notify;
    this.spawn = dependencies.spawn ?? spawn;
    this.active = null;
  }
  state() {
    return this.active
      ? {
          waiting: true,
          hasBrowserLink: Boolean(this.active.url),
          codeRequired: this.active.codeRequired,
        }
      : { waiting: false, hasBrowserLink: false, codeRequired: false };
  }
  start(executable, args, verify, options = {}) {
    if (this.active) throw new Error("로그인이 이미 진행 중입니다.");
    const child = this.spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: options.env ?? nativeEnvironment(),
    });
    const active = { child, codeRequired: false, url: null, output: "" };
    this.active = active;
    const emit = (message) =>
      this.notify({
        type: this.provider,
        state: "waiting",
        message,
        login: this.state(),
      });
    const observe = (chunk) => {
      if (this.active !== active) return;
      active.output = (active.output + chunk.toString()).slice(-18000);
      const url = authorizationURL(active.output, this.provider);
      const needsCode =
        /paste[^\r\n]{0,80}code|enter[^\r\n]{0,80}(?:authorization|verification) code/i.test(
          active.output,
        );
      const changed =
        (url && url !== active.url) || (needsCode && !active.codeRequired);
      if (url) active.url = url;
      if (url && options.open && !active.browserOpened) {
        active.browserOpened = true;
        Promise.resolve()
          .then(() => options.open(url))
          .catch(() =>
            emit(
              "브라우저를 자동으로 열지 못했습니다. 브라우저 다시 열기를 누르세요.",
            ),
          );
      }
      if (needsCode) active.codeRequired = true;
      if (changed)
        emit(
          needsCode
            ? "브라우저에 승인 코드가 표시되면 앱에 입력하세요."
            : "공식 브라우저에서 승인을 완료하세요. 필요하면 브라우저 다시 열기를 누르세요.",
        );
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.stdin.on("error", () => {});
    let finished = false;
    const finish = async (code, cancelled = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(active.timer);
      if (this.active === active) this.active = null;
      active.output = "";
      active.url = null;
      let status;
      try {
        status = code === 0 && !cancelled ? await verify() : null;
      } catch {}
      this.notify({
        type: this.provider,
        state: cancelled
          ? "cancelled"
          : status?.connected
            ? "connected"
            : "error",
        login: this.state(),
        message: cancelled
          ? "로그인 시도를 취소했습니다. 터미널 로그아웃은 수행하지 않았습니다."
          : status?.connected
            ? "공식 CLI 로그인이 연결되었습니다. 다음 실행부터 저장된 연결을 사용합니다."
            : "로그인 완료를 확인하지 못했습니다. 연결 다시 확인 또는 공식 로그인을 선택하세요.",
      });
    };
    active.finish = finish;
    active.timer = setTimeout(
      () => {
        child.kill();
        void finish(-1);
      },
      5 * 60 * 1000,
    );
    child.once("error", () => {
      void finish(-1);
    });
    child.once("close", (code) => {
      void finish(code);
    });
    emit(
      "공식 CLI 로그인을 시작했습니다. 기본 브라우저의 기존 로그인 세션을 사용할 수 있습니다.",
    );
    return { waiting: true };
  }
  async openBrowser(open) {
    if (!this.active?.url)
      throw new Error("공식 CLI가 로그인 링크를 아직 제공하지 않았습니다.");
    await open(this.active.url);
  }
  code(value) {
    if (
      !this.active?.codeRequired ||
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 4000 ||
      /[\r\n\x00]/.test(value)
    )
      throw new Error("공식 브라우저에 표시된 승인 코드 한 줄을 입력하세요.");
    this.active.child.stdin.write(`${value.trim()}\n`);
    this.active.codeRequired = false;
    return { submitted: true };
  }
  cancel() {
    if (this.active) {
      const active = this.active;
      active.child.kill();
      void active.finish(-1, true);
    }
  }
}
