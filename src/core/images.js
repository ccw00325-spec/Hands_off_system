import { requestJson } from "./http.js";
export const IMAGE_MODEL = "gpt-image-2";
const API = "https://api.openai.com/v1";

export function validateImageKey(value) {
  if (
    typeof value !== "string" ||
    !/^sk-[A-Za-z0-9_-]{16,512}$/.test(value.trim())
  )
    throw new Error("개인 OpenAI API 키를 입력하세요.");
  return value.trim();
}

export class ImageService {
  constructor(store, fetcher = fetch) {
    this.store = store;
    this.fetcher = fetcher;
    this.busy = false;
  }
  async saveKey(input) {
    const key = validateImageKey(input);
    if (!this.store.available())
      throw new Error("OS 보안 저장소를 사용할 수 없습니다.");
    // Checking the model endpoint does not generate a billable image.
    await requestJson(
      `${API}/models/${IMAGE_MODEL}`,
      { headers: { Authorization: `Bearer ${key}` } },
      this.fetcher,
    );
    await this.store.mutateSecrets((vault) => {
      vault.imageKey = key;
      vault.imageKeyVerifiedAt = new Date().toISOString();
    });
    return {
      saved: true,
      message:
        "키를 암호화해 저장했습니다. 모델 조회를 확인했으며, 실제 생성 권한·잔액은 생성 시 확인됩니다.",
    };
  }
  async removeKey() {
    if (this.busy) throw new Error("이미지 생성이 끝난 후 키를 삭제하세요.");
    await this.store.mutateSecrets((vault) => {
      delete vault.imageKey;
      delete vault.imageKeyVerifiedAt;
    });
  }
  async generate(prompt) {
    if (this.busy) throw new Error("이미지 생성이 이미 진행 중입니다.");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000)
      throw new Error("시안 설명을 1~12,000자로 입력하세요.");
    this.busy = true;
    try {
      const vault = await this.store.secrets();
      if (!vault.imageKey)
        throw new Error("먼저 이미지 생성용 개인 API 키를 등록하세요.");
      const result = await requestJson(
        `${API}/images/generations`,
        {
          method: "POST",
          signal: AbortSignal.timeout(240000),
          headers: {
            Authorization: `Bearer ${vault.imageKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: IMAGE_MODEL,
            prompt: prompt.trim(),
            n: 1,
            size: "1536x1024",
            quality: "medium",
            output_format: "png",
          }),
        },
        this.fetcher,
      );
      const data = result.data?.[0]?.b64_json;
      if (
        typeof data !== "string" ||
        data.length > 40000000 ||
        !/^[A-Za-z0-9+/=]+$/.test(data)
      )
        throw new Error(
          "이미지 응답을 확인하지 못했습니다. 사용 내역을 확인한 후 재시도하세요.",
        );
      const buffer = Buffer.from(data, "base64");
      if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
        throw new Error("PNG 형식의 이미지가 아닙니다.");
      return { buffer, dataUrl: `data:image/png;base64,${data}` };
    } finally {
      this.busy = false;
    }
  }
}
