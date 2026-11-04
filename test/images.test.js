import test from "node:test";
import assert from "node:assert/strict";
import { ImageService } from "../src/core/images.js";
const key = "sk-test-not-a-real-credential-123456789";
function store(initial = {}) {
  return {
    available: () => true,
    secrets: async () => initial,
    mutateSecrets: async (fn) => fn(initial),
  };
}
test("key validation is a model lookup, never an image generation", async () => {
  let request;
  const vault = store();
  const images = new ImageService(vault, async (url, options) => {
    request = { url, options };
    return Response.json({ id: "gpt-image-2" });
  });
  await images.saveKey(key);
  assert.equal(request.url, "https://api.openai.com/v1/models/gpt-image-2");
  assert.equal(request.options.method, undefined);
  assert.equal((await vault.secrets()).imageKey, key);
});
test("a rejected replacement key preserves the old credential and hides provider bodies", async () => {
  const vault = store({ imageKey: "old" });
  const images = new ImageService(vault, async () =>
    Response.json(
      { error: { message: `Invalid key ${key}` } },
      { status: 401 },
    ),
  );
  await assert.rejects(
    images.saveKey(key),
    (error) => !error.message.includes(key),
  );
  assert.equal((await vault.secrets()).imageKey, "old");
});
test("secure storage unavailability does not call the provider", async () => {
  let called = false;
  const vault = store();
  vault.available = () => false;
  const images = new ImageService(vault, async () => {
    called = true;
  });
  await assert.rejects(images.saveKey(key));
  assert.equal(called, false);
});
test("image generation uses the personal image credential and never an OAuth token", async () => {
  let body, authorization;
  const images = new ImageService(
    store({
      imageKey: key,
      accounts: [{ accessToken: "oauth-not-for-images" }],
    }),
    async (_url, options) => {
      body = JSON.parse(options.body);
      authorization = options.headers.Authorization;
      return Response.json({
        data: [
          {
            b64_json: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
          },
        ],
      });
    },
  );
  const result = await images.generate("A timer UI");
  assert.equal(body.model, "gpt-image-2");
  assert.equal(body.n, 1);
  assert.equal(authorization, `Bearer ${key}`);
  assert.ok(result.dataUrl.startsWith("data:image/png;base64,"));
});
test("billable requests are not retried and failed generation releases the lock", async () => {
  let calls = 0;
  const images = new ImageService(store({ imageKey: key }), async () => {
    calls++;
    return Response.json({}, { status: 429 });
  });
  await assert.rejects(images.generate("A UI"));
  assert.equal(calls, 1);
  assert.equal(images.busy, false);
});

test("Gemini keeps an independent encrypted key route and generates with the image model", async () => {
  const googleKey = "AIza" + "a".repeat(35);
  const vault = store({ imageKey: key });
  const calls = [];
  const images = new ImageService(vault, async (url, options) => {
    calls.push({ url, options });
    return Response.json(options.method ? {
      candidates: [{ content: { parts: [{ inlineData: {
        mimeType: "image/png", data: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"),
      } }] } }],
    } : { name: "models/gemini-3.1-flash-image" });
  });
  await images.saveKey(googleKey, "gemini");
  assert.equal(calls[0].options.method, undefined);
  const result = await images.generate("UI sketch", "gemini");
  assert.match(calls[1].url, /gemini-3\.1-flash-image:generateContent$/);
  assert.equal(calls[1].options.headers["x-goog-api-key"], googleKey);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.ok(result.dataUrl.startsWith("data:image/png;base64,"));
  assert.equal((await vault.secrets()).imageKey, key);
  await images.removeKey("gemini");
  assert.equal((await vault.secrets()).geminiImageKey, undefined);
});
