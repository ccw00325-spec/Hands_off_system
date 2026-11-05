const $ = (id) => document.getElementById(id);
let gathering = false,
  messageIndex = 0;
const gatheringMessages = [
  "AI 모델들 집합 중…",
  "흩어진 모델 이름표 모으는 중…",
  "상자는 넘어져도, 모델은 챙기는 중…",
  "작업대에 앉을 AI들 자리 잡는 중…",
];
window.startup.onProgress((value) => {
  gathering = value.stage === "모델 목록";
  if (typeof value.message === "string")
    $("message").textContent = value.message;
  if (typeof value.detail === "string") $("detail").textContent = value.detail;
  if (typeof value.stage === "string") $("stage").textContent = value.stage;
  if (Number.isFinite(value.percent)) {
    const percent = Math.max(
      $("progress").value,
      Math.min(100, Math.max(0, value.percent)),
    );
    $("progress").value = percent;
    $("percent").textContent = percent + "%";
  }
});
setInterval(() => {
  if (gathering)
    $("message").textContent =
      gatheringMessages[++messageIndex % gatheringMessages.length];
}, 3500);
$("cancel").addEventListener("click", () => window.startup.cancel());
$("cancel").disabled=false;
