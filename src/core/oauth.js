import { createServer } from "node:http";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { requestJson } from "./http.js";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

export function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}
export function validState(actual, expected) {
  return (
    typeof actual === "string" &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}
export function callbackClient(params, previous) {
  const supplied = params.get("client_id");
  if (previous && supplied && supplied !== previous.clientId)
    throw new Error("이전에 연결한 계정의 클라이언트 ID와 일치하지 않습니다.");
  const clientId = supplied || previous?.clientId;
  if (!clientId || clientId === "dynamic_agent_client" || clientId.length > 300)
    throw new Error("공식 로그인 등록이 완료되지 않았습니다. 다시 시도하세요.");
  return clientId;
}
export function validateIdentity(payload, nonce, previous) {
  if (!payload.sub || payload.nonce !== nonce)
    throw new Error("로그인 신원 또는 nonce 검증에 실패했습니다.");
  if (
    previous &&
    (payload.sub !== previous.subject || payload.iss !== previous.issuer)
  )
    throw new Error(
      "선택한 계정과 로그인한 계정이 다릅니다. 새 계정으로 추가하세요.",
    );
}
export function credentialRecord(tokens, payload, clientId, previous) {
  if (!tokens.access_token || !tokens.id_token)
    throw new Error("공식 로그인의 인증정보가 불완전합니다.");
  return {
    id: previous?.id ?? randomUUID(),
    clientId,
    subject: payload.sub,
    issuer: payload.iss,
    label: `${payload.email || payload.name || "ChatGPT"} · ${clientId.slice(-6)}`,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    scopes: String(tokens.scope || "")
      .split(/\s+/)
      .filter(Boolean),
    expiresAt: Date.now() + Number(tokens.expires_in || 0) * 1000,
  };
}
export function safeEndpoint(value) {
  const url = new URL(value);
  if (url.origin !== ISSUER || url.username || url.password || url.hash)
    throw new Error("공식 인증 서버 주소가 아닙니다.");
  return url.href;
}

export class ChatGPTAuth {
  constructor(store, openBrowser, notify = () => {}, dependencies = {}) {
    this.store = store;
    this.openBrowser = openBrowser;
    this.notify = notify;
    this.fetcher = dependencies.fetcher ?? fetch;
    this.verify =
      dependencies.verify ??
      ((token, keys, options) => jwtVerify(token, keys, options));
    this.pending = null;
    this.refreshing = null;
    this.sessionEpoch = 0;
  }
  async discovery() {
    return requestJson(
      `${ISSUER}/.well-known/openid-configuration`,
      {},
      this.fetcher,
    );
  }
  async start(accountId) {
    if (this.signingOut) throw new Error("로그아웃이 끝난 후 다시 연결하세요.");
    if (this.pending)
      throw new Error("로그인이 이미 진행 중입니다. 완료하거나 취소하세요.");
    if (!this.store.available())
      throw new Error("OS 보안 저장소를 사용할 수 없습니다.");
    const vault = await this.store.secrets();
    const previous = accountId
      ? vault.accounts?.find((account) => account.id === accountId)
      : null;
    if (accountId && !previous)
      throw new Error("연결할 계정을 찾지 못했습니다.");
    const metadata = (await this.store.read("host", null)) ?? {
      id: `urn:uuid:${randomUUID()}`,
    };
    await this.store.write("host", metadata);
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const proof = pkce();
    const pending = { state, nonce, proof, previous, busy: false };
    this.pending = pending;
    const server = createServer((req, res) => {
      void this.callback(req, res, pending).catch(() => {
        if (!res.headersSent) res.writeHead(400);
        res.end("Invalid login callback");
      });
    });
    pending.server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      pending.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const url = new URL(`${ISSUER}/api/accounts/authorize`);
      const params = {
        client_id: previous?.clientId ?? "dynamic_agent_client",
        ext_agent_host_id: metadata.id,
        response_type: "code",
        redirect_uri: pending.redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: proof.challenge,
      };
      if (!previous) params.agent_name_hint = "CW_Handsoff_sys";
      if (previous?.idToken) params.id_token_hint = previous.idToken;
      for (const [key, value] of Object.entries(params))
        url.searchParams.set(key, value);
      // Bound the loopback listener; cancellation is also available in the application.
      pending.timer = setTimeout(
        () =>
          this.finish(
            pending,
            "error",
            "로그인 시간이 만료되었습니다. 다시 연결하세요.",
          ),
        5 * 60 * 1000,
      );
      await this.openBrowser(url.href);
      this.notify({
        type: "auth",
        state: "waiting",
        message: "브라우저에서 공식 로그인과 권한 승인을 완료하세요.",
      });
      return { waiting: true };
    } catch (error) {
      this.cleanup(pending);
      throw error;
    }
  }
  cleanup(pending) {
    clearTimeout(pending.timer);
    pending.server?.close();
    pending.server?.closeIdleConnections();
    if (this.pending === pending) this.pending = null;
  }
  finish(pending, state, message) {
    if (this.pending !== pending) return;
    this.cleanup(pending);
    this.notify({ type: "auth", state, message });
  }
  cancel() {
    if (this.pending)
      this.finish(this.pending, "cancelled", "로그인을 취소했습니다.");
  }
  async callback(req, res, pending) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    const url = new URL(req.url, pending.redirectUri);
    if (req.method !== "GET" || url.pathname !== "/auth/callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    if (!validState(url.searchParams.get("state"), pending.state)) {
      res.writeHead(400).end("Invalid state");
      return;
    }
    if (this.pending !== pending || pending.busy) {
      res.writeHead(409).end("Login already handled");
      return;
    }
    pending.busy = true;
    try {
      if (url.searchParams.has("error"))
        throw new Error("로그인 또는 사용 권한 승인이 거절되었습니다.");
      const clientId = callbackClient(url.searchParams, pending.previous);
      const code = url.searchParams.get("code");
      if (!code || code.length > 10000)
        throw new Error("로그인 승인 코드를 받지 못했습니다.");
      const tokens = await requestJson(
        TOKEN,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            code_verifier: pending.proof.verifier,
            redirect_uri: pending.redirectUri,
            resource: RESOURCE,
          }),
        },
        this.fetcher,
      );
      const discovery = await this.discovery();
      if (discovery.issuer !== ISSUER)
        throw new Error("공식 인증 발급자를 확인할 수 없습니다.");
      const keys = createRemoteJWKSet(
        new URL(safeEndpoint(discovery.jwks_uri)),
      );
      const { payload } = await this.verify(tokens.id_token, keys, {
        issuer: ISSUER,
        audience: clientId,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat", "nonce"],
      });
      validateIdentity(payload, pending.nonce, pending.previous);
      const record = credentialRecord(
        tokens,
        payload,
        clientId,
        pending.previous,
      );
      if (this.pending !== pending)
        throw new Error("취소되거나 만료된 로그인입니다.");
      await this.store.mutateSecrets((vault) => {
        if (this.pending !== pending)
          throw new Error("취소되거나 만료된 로그인입니다.");
        vault.accounts = (vault.accounts ?? []).filter(
          (account) => account.id !== record.id,
        );
        vault.accounts.push(record);
        vault.activeAccountId = record.id;
      });
      this.sessionEpoch++;
      res.end("연결되었습니다. CW_Handsoff_sys로 돌아가세요.");
      // Closing after the response is sent avoids interrupting the browser response.
      this.finish(
        pending,
        "connected",
        record.scopes.includes(PLAN_SCOPE)
          ? "ChatGPT 계정과 사용 권한이 연결되었습니다."
          : "로그인은 완료됐지만 ChatGPT 사용 권한은 승인되지 않았습니다.",
      );
    } catch {
      res
        .writeHead(400)
        .end("로그인을 완료하지 못했습니다. 앱에서 다시 연결하세요.");
      this.finish(
        pending,
        "error",
        "공식 로그인 검증에 실패했습니다. 권한 승인과 네트워크를 확인하고 다시 연결하세요.",
      );
    }
  }
  async select(id) {
    if (this.signingOut)
      throw new Error("로그아웃이 끝난 후 계정을 전환하세요.");
    this.cancel();
    await this.store.mutateSecrets((vault) => {
      if (
        !vault.accounts?.some(
          (account) => account.id === id && account.accessToken,
        )
      )
        throw new Error("다시 로그인이 필요한 계정입니다.");
      vault.activeAccountId = id;
    });
    this.sessionEpoch++;
  }
  async access({ forceRefresh = false } = {}) {
    if (this.signingOut) throw new Error("로그아웃 중입니다.");
    const vault = await this.store.secrets();
    const account = vault.accounts?.find(
      (account) => account.id === vault.activeAccountId,
    );
    if (!account?.accessToken)
      throw new Error("먼저 ChatGPT 계정을 연결하세요.");
    if (!account.scopes.includes(PLAN_SCOPE))
      throw new Error("ChatGPT 사용 권한을 승인한 후 다시 연결하세요.");
    if (!forceRefresh && account.expiresAt > Date.now() + 60000)
      return account.accessToken;
    if (!account.refreshToken)
      throw new Error("로그인이 만료되었습니다. 다시 연결하세요.");
    if (!this.refreshing) {
      const epoch = this.sessionEpoch;
      this.refreshing = (async () => {
        const tokens = await requestJson(
          TOKEN,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: account.clientId,
              refresh_token: account.refreshToken,
              resource: RESOURCE,
            }),
          },
          this.fetcher,
        );
        if (!tokens.access_token || this.sessionEpoch !== epoch)
          throw new Error("계정이 변경되었습니다. 다시 시도하세요.");
        await this.store.mutateSecrets((current) => {
          const target = current.accounts?.find(
            (item) => item.id === account.id,
          );
          if (
            !target?.refreshToken ||
            target.refreshToken !== account.refreshToken ||
            this.sessionEpoch !== epoch
          )
            throw new Error("세션이 변경되었습니다. 다시 연결하세요.");
          Object.assign(target, {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? target.refreshToken,
            idToken: tokens.id_token ?? target.idToken,
            expiresAt: Date.now() + Number(tokens.expires_in || 0) * 1000,
            scopes: tokens.scope ? tokens.scope.split(/\s+/) : target.scopes,
          });
          if (!target.scopes.includes(PLAN_SCOPE))
            throw new Error("ChatGPT 사용 권한이 없습니다.");
        });
        return tokens.access_token;
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }
  async signOut() {
    if (this.signingOut) throw new Error("로그아웃이 이미 진행 중입니다.");
    this.signingOut = true;
    try {
      return await this.performSignOut();
    } finally {
      this.signingOut = false;
    }
  }
  async performSignOut() {
    this.cancel();
    // Serialize local sign-out after any in-flight refresh to revoke the latest rotating token.
    try {
      await this.refreshing;
    } catch {
      /* Authentication may already have been revoked. */
    }
    this.sessionEpoch++;
    const vault = await this.store.secrets();
    const account = vault.accounts?.find(
      (item) => item.id === vault.activeAccountId,
    );
    let remoteRevoked = !account?.refreshToken;
    if (account?.refreshToken) {
      try {
        const discovery = await this.discovery();
        const response = await this.fetcher(
          safeEndpoint(discovery.revocation_endpoint),
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(15000),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: account.refreshToken,
              token_type_hint: "refresh_token",
              client_id: account.clientId,
            }),
          },
        );
        remoteRevoked = response.status === 200;
      } catch {
        remoteRevoked = false;
      }
    }
    await this.store.mutateSecrets((current) => {
      const target = current.accounts?.find((item) => item.id === account?.id);
      if (target) {
        delete target.accessToken;
        delete target.refreshToken;
        delete target.idToken;
        target.expiresAt = 0;
      }
      if (current.activeAccountId === account?.id)
        delete current.activeAccountId;
    });
    return {
      remoteRevoked,
      message: remoteRevoked
        ? "로그아웃했습니다."
        : "기기에서는 로그아웃했습니다. 원격 권한 철회는 확인되지 않았습니다. ChatGPT 설정에서 앱 연결을 해제하세요.",
    };
  }
}
