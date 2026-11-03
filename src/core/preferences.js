import { deviceBinding } from "./device-binding.js";
export const DEFAULT_PREFERENCES = Object.freeze({
  version: 1,
  onboardingComplete: false,
  maxRepairRounds: 2,
  validationScript: "test",
  allowExecution: false,
  unattended: true,
  terminalFontSize: 13,
  wrapLines: true,
});
export class Preferences {
  constructor(store, identity = deviceBinding) {
    this.store = store;
    this.identity = identity;
  }
  async get() {
    const saved = await this.store.read("preferences", {});
    const value = { ...DEFAULT_PREFERENCES, ...saved };
    if (saved.consentBinding !== (await this.identity())) {
      value.allowExecution = false;
      value.onboardingComplete = false;
    }
    delete value.consentBinding;
    return value;
  }
  async save(input) {
    if (
      !input ||
      !Number.isInteger(input.maxRepairRounds) ||
      input.maxRepairRounds < 0 ||
      input.maxRepairRounds > 20 ||
      typeof input.validationScript !== "string" ||
      (input.validationScript &&
        !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(input.validationScript)) ||
      ![12, 13, 14, 16, 18].includes(input.terminalFontSize) ||
      ["allowExecution", "unattended", "wrapLines"].some(
        (key) => typeof input[key] !== "boolean",
      )
    )
      throw new Error("작업 설정의 횟수·스크립트·글꼴 또는 권한을 확인하세요.");
    const value = {
      ...DEFAULT_PREFERENCES,
      ...Object.fromEntries(
        Object.keys(DEFAULT_PREFERENCES)
          .filter((key) => key in input)
          .map((key) => [key, input[key]]),
      ),
      version: 1,
      onboardingComplete: true,
      consentBinding: await this.identity(),
      updatedAt: new Date().toISOString(),
    };
    await this.store.write("preferences", value);
    return this.get();
  }
}
