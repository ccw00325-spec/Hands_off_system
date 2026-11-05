import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ChatGPTAuth,
  pkce,
  validState,
  callbackClient,
  validateIdentity,
} from "../src/core/oauth.js";

function memoryStore() {
  let value = {};
  const metadata = new Map();
  return {
    available: () => true,
    secrets: async () => structuredClone(value),
    read: async (key, fallback) => metadata.get(key) ?? fallback,
    write: async (key, next) => {
      metadata.set(key, structuredClone(next));
    },
    mutateSecrets: async (fn) => {
      const next = structuredClone(value);
      await fn(next);
      value = next;
    },
  };
}
test("PKCE uses independent random proofs and S256 challenges", () => {
  const one = pkce(),
    two = pkce();
  assert.notEqual(one.verifier, two.verifier);
  assert.equal(
    one.challenge,
    createHash("sha256").update(one.verifier).digest("base64url"),
  );
  assert.match(one.verifier, /^[A-Za-z0-9_-]{43,128}$/);
});
test("state validation rejects missing, wrong-length and wrong-value callbacks", () => {
  assert.equal(validState("abc", "abc"), true);
  for (const actual of [null, "", "abcd", "xyz"])
    assert.equal(validState(actual, "abc"), false);
});
test("returning registration cannot change its client ID and new registration needs an issued ID", () => {
  assert.equal(
    callbackClient(new URLSearchParams(), { clientId: "oaiapp_a" }),
    "oaiapp_a",
  );
  assert.throws(() =>
    callbackClient(new URLSearchParams("client_id=oaiapp_b"), {
      clientId: "oaiapp_a",
    }),
  );
  assert.throws(() =>
    callbackClient(new URLSearchParams("client_id=dynamic_agent_client")),
  );
  assert.throws(() => callbackClient(new URLSearchParams()));
});
test("verified identity still needs nonce and original account checks", () => {
  const payload = { sub: "user", iss: "https://auth.openai.com", nonce: "n" };
  validateIdentity(payload, "n", { subject: "user", issuer: payload.iss });
  assert.throws(() => validateIdentity(payload, "wrong"));
  assert.throws(() =>
    validateIdentity(payload, "n", {
      subject: "someone-else",
      issuer: payload.iss,
    }),
  );
});

test("real loopback callback uses exact redirect URI, rejects wrong state and saves only validated identity", async (t) => {
  const store = memoryStore();
  let authorizeURL, tokenRequest;
  const events = [];
  const auth = new ChatGPTAuth(
    store,
    async (url) => {
      authorizeURL = new URL(url);
    },
    (event) => events.push(event),
    {
      fetcher: async (url, options) => {
        if (url.endsWith("openid-configuration"))
          return Response.json({
            issuer: "https://auth.openai.com",
            jwks_uri: "https://auth.openai.com/jwks",
          });
        tokenRequest = options.body;
        return Response.json({
          access_token: "private-access",
          refresh_token: "private-refresh",
          id_token: "signed-id",
          expires_in: 3600,
          scope: "openid chatgpt.tokens.use.direct",
        });
      },
      verify: async (_token, _keys, options) => {
        assert.equal(options.audience, "oaiapp_registered");
        return {
          payload: {
            sub: "validated-user",
            iss: "https://auth.openai.com",
            nonce: authorizeURL.searchParams.get("nonce"),
            email: "user@example.test",
          },
        };
      },
    },
  );
  t.after(() => auth.cancel());
  await auth.start();
  assert.equal(
    authorizeURL.searchParams.get("client_id"),
    "dynamic_agent_client",
  );
  assert.equal(
    authorizeURL.searchParams.get("resource"),
    "https://api.openai.com/v1",
  );
  const callback = new URL(authorizeURL.searchParams.get("redirect_uri"));
  assert.equal(callback.hostname, "127.0.0.1");
  callback.searchParams.set("state", "wrong");
  assert.equal((await fetch(callback)).status, 400);
  assert.deepEqual(await store.secrets(), {});
  callback.searchParams.set("state", authorizeURL.searchParams.get("state"));
  callback.searchParams.set("code", "single-use-code");
  callback.searchParams.set("client_id", "oaiapp_registered");
  const response = await fetch(callback);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(
    tokenRequest.get("redirect_uri"),
    authorizeURL.searchParams.get("redirect_uri"),
  );
  assert.equal(tokenRequest.get("client_id"), "oaiapp_registered");
  assert.equal(
    createHash("sha256")
      .update(tokenRequest.get("code_verifier"))
      .digest("base64url"),
    authorizeURL.searchParams.get("code_challenge"),
  );
  const saved = await store.secrets();
  assert.equal(saved.accounts[0].subject, "validated-user");
  assert.equal(saved.activeAccountId, saved.accounts[0].id);
  assert.equal(events.at(-1).state, "connected");
  assert.ok(!JSON.stringify(events).includes("private-access"));
});
test("a signature verification failure never stores authentication", async (t) => {
  const store = memoryStore();
  let url;
  const auth = new ChatGPTAuth(
    store,
    async (value) => {
      url = new URL(value);
    },
    () => {},
    {
      fetcher: async (endpoint) =>
        Response.json(
          endpoint.endsWith("openid-configuration")
            ? {
                issuer: "https://auth.openai.com",
                jwks_uri: "https://auth.openai.com/jwks",
              }
            : { id_token: "invalid", access_token: "never-save" },
        ),
      verify: async () => {
        throw new Error("bad signature");
      },
    },
  );
  t.after(() => auth.cancel());
  await auth.start();
  const callback = new URL(url.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({
    state: url.searchParams.get("state"),
    code: "code",
    client_id: "oaiapp_client",
  }).toString();
  const response = await fetch(callback);
  assert.equal(response.status, 400);
  await response.text();
  assert.deepEqual(await store.secrets(), {});
});
test("declining consent stops the attempt without exchanging a code", async (t) => {
  const store = memoryStore();
  let url;
  let requests = 0;
  const auth = new ChatGPTAuth(
    store,
    async (value) => {
      url = new URL(value);
    },
    () => {},
    {
      fetcher: async () => {
        requests++;
      },
    },
  );
  t.after(() => auth.cancel());
  await auth.start();
  const callback = new URL(url.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({
    state: url.searchParams.get("state"),
    error: "access_denied",
  }).toString();
  const response = await fetch(callback);
  assert.equal(response.status, 400);
  await response.text();
  assert.equal(requests, 0);
  assert.equal(auth.pending, null);
});
test("parallel expiry checks share one token refresh and atomically retain rotated credentials", async () => {
  const store = memoryStore();
  await store.mutateSecrets((vault) => {
    vault.accounts = [
      {
        id: "a",
        clientId: "oaiapp_a",
        accessToken: "expired",
        refreshToken: "old",
        scopes: ["chatgpt.tokens.use.direct"],
        expiresAt: 0,
      },
    ];
    vault.activeAccountId = "a";
  });
  let count = 0;
  const auth = new ChatGPTAuth(
    store,
    () => {},
    () => {},
    {
      fetcher: async () => {
        count++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({
          access_token: "new",
          refresh_token: "rotated",
          expires_in: 3600,
        });
      },
    },
  );
  assert.deepEqual(
    await Promise.all([auth.access(), auth.access(), auth.access()]),
    ["new", "new", "new"],
  );
  assert.equal(count, 1);
  assert.equal((await store.secrets()).accounts[0].refreshToken, "rotated");
});
test("failed remote revocation still clears local tokens and reports it truthfully", async () => {
  const store = memoryStore();
  await store.mutateSecrets((vault) => {
    vault.accounts = [
      {
        id: "a",
        clientId: "oaiapp_a",
        subject: "s",
        accessToken: "secret",
        refreshToken: "refresh",
        idToken: "id",
      },
    ];
    vault.activeAccountId = "a";
  });
  const auth = new ChatGPTAuth(
    store,
    () => {},
    () => {},
    {
      fetcher: async () => {
        throw new TypeError("offline");
      },
    },
  );
  const result = await auth.signOut();
  assert.equal(result.remoteRevoked, false);
  const saved = (await store.secrets()).accounts[0];
  assert.equal(saved.accessToken, undefined);
  assert.equal(saved.refreshToken, undefined);
  assert.equal(saved.idToken, undefined);
  assert.equal(saved.clientId, "oaiapp_a");
});
test("sign-out waits for an in-flight refresh then revokes the newest rotating token", async () => {
  const store = memoryStore();
  await store.mutateSecrets((vault) => {
    vault.accounts = [
      {
        id: "a",
        clientId: "oaiapp_a",
        accessToken: "expired",
        refreshToken: "old",
        scopes: ["chatgpt.tokens.use.direct"],
        expiresAt: 0,
      },
    ];
    vault.activeAccountId = "a";
  });
  let release, refreshStarted;
  const started = new Promise((resolve) => {
    refreshStarted = resolve;
  });
  let revoked;
  const auth = new ChatGPTAuth(
    store,
    () => {},
    () => {},
    {
      fetcher: async (url, options) => {
        if (url.endsWith("/oauth/token")) {
          refreshStarted();
          await new Promise((resolve) => {
            release = resolve;
          });
          return Response.json({
            access_token: "new",
            refresh_token: "latest",
            expires_in: 3600,
          });
        }
        if (url.endsWith("openid-configuration"))
          return Response.json({
            revocation_endpoint: "https://auth.openai.com/revoke",
          });
        revoked = options.body.get("token");
        return new Response("", { status: 200 });
      },
    },
  );
  const access = auth.access();
  await started;
  const logout = auth.signOut();
  await assert.rejects(auth.access());
  release();
  await access;
  const result = await logout;
  assert.equal(result.remoteRevoked, true);
  assert.equal(revoked, "latest");
  assert.equal((await store.secrets()).accounts[0].accessToken, undefined);
});

test("public errors mask provider credentials and authorization headers", async () => {
  const { publicError } = await import("../src/core/http.js");
  const samples = [
    "AIza" + "a".repeat(35),
    "ghp_" + "b".repeat(24),
    "ya29." + "c".repeat(25),
    "sbp_" + "d".repeat(40),
    "sb_secret_" + "e".repeat(24),
    "Authorization: Basic " + "Q".repeat(20),
  ];
  for (const value of samples) {
    const result = publicError(new Error("Provider error " + value));
    assert.ok(result.includes("[보호된 비밀값]"));
    assert.ok(!result.includes(value));
  }
});
