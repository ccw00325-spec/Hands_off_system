const $ = (selector) => document.querySelector(selector);
export function fillPreferences(value) {
  $("#max-repair-rounds").value = value.maxRepairRounds;
  $("#validation-script").value = value.validationScript;
  $("#allow-execution").checked = value.allowExecution;
  $("#unattended-mode").checked = value.unattended;
  $("#terminal-font-size").value = String(value.terminalFontSize);
  $("#wrap-lines").checked = value.wrapLines;
  document.documentElement.style.setProperty(
    "--terminal-font-size",
    value.terminalFontSize + "px",
  );
  document.body.dataset.wrap = value.wrapLines ? "on" : "off";
  $("#settings-intro").textContent = value.onboardingComplete
    ? "자동화·권한 변경은 다음 작업에 적용됩니다. 실행 동의를 취소하면 현재 검증도 중지합니다."
    : "처음 한 번 작업 환경과 실행 권한을 선택하세요. 실행 동의는 선택 사항이며 나중에 바꿀 수 있습니다.";
}
export function readPreferences() {
  return {
    maxRepairRounds: Number($("#max-repair-rounds").value),
    validationScript: $("#validation-script").value.trim(),
    allowExecution: $("#allow-execution").checked,
    unattended: $("#unattended-mode").checked,
    terminalFontSize: Number($("#terminal-font-size").value),
    wrapLines: $("#wrap-lines").checked,
  };
}
