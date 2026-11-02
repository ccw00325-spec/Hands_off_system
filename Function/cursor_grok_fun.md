# Cursor Agent로 Grok 실행 · CURSOR-001 · v0.3 · 2026-11-02

v0.4 수정: 사용자 보고 “Grok은 로그인창도 안 뜨고 연동도 안 됨”에 따라 기존 로그인 감지 시 기본 버튼을 비활성화하던 동작을 제거했다. **Cursor 로그인**은 항상 명시적 native login을 시작하고, **기존 연결 확인**은 별도로 재사용한다. `NO_OPEN_BROWSER=1`로 원본에서 받은 공식 승인 URL을 앱이 선택한 브라우저로 한 번 열며 실패 시 다시 열기를 제공한다. 실제 Electron 버튼 → 원본 Cursor login → 공식 URL 열기까지 검사했고 브라우저 열기만 테스트에서 가로챘다. 승인 전 취소 후 기존 인증이 유지됨을 확인했다. 새 계정 승인을 완료했다는 뜻은 아니다. 역할 배정은 `role_assignment_fun.md`를 따른다.

- [x] 연결 방식 — 결정 ✅ / 구현 ✅ / 검증 ✅: 기존 Cursor 로그인 및 ACP 인증 메타데이터 확인.
- [x] Grok 모델 목록·선택 저장·작업별 고정 — 결정 ✅ / 구현 ✅ / 검증 ✅: 실제 ACP 모델 설정, 단위 및 UI 검사.
- [ ] 실제 코드 생성 — 결정 ✅ / 구현 ✅ / 검증 ⬜: 모델 추론과 세 AI 연속 작업은 미실행.

사용자 확정 답: **“기존 Cursor Agent 로그인을 재사용하고, 그 안에서 Grok 모델 선택 (권장)”**. D-C01은 Cursor를 Grok 담당 실행 경로로 사용, D-C02는 실제 제공 모델 목록에서 사용자 선택이다. 원본 Cursor 로그인과 Grok 웹 구독을 같은 계정으로 취급하지 않는다.

Context: Cursor 설치·미설치, 유효한 로그인·미연결, 모델 미선택·목록 변경·실행 중 모델 변경. Trigger: 앱 복원, 연결하기, 모델 목록 불러오기, 모델 선택, 작업 시작. Reaction: 원본 status 및 ACP 인증을 사용하고, 모델 목록은 ACP 세션의 canonical ID를 보존한다. CLI 짧은 별칭은 ACP가 거절하는 것을 실제 메타데이터 검사에서 확인했다. 자동 모델 대체는 하지 않는다.

```gherkin
@confirmed
Feature: Cursor의 Grok 모델 연결
  Scenario: S-C01 기존 로그인 재사용
    Given 원본 Cursor Agent 로그인이 유효하다
    When 앱에서 연결을 확인한다
    Then 원본 로그인을 사용한다
    And 비밀번호나 구독 토큰을 복사하지 않는다

  Scenario: S-C02 작업별 모델 유지
    Given 사용자가 Cursor의 실제 Grok 모델을 선택했다
    When 작업 시작 후 다음 작업에 사용할 모델을 바꾼다
    Then 진행 중인 작업은 시작할 때 선택한 모델을 유지한다
    And 다음 작업은 새 선택을 사용한다

@observed
Feature: 도구와 모델 제한
  Scenario: S-C03 모델을 확인하지 못한 경우
    Given 선택한 모델이 현재 ACP 목록에 없다
    When 구현 또는 최종 검토를 시작한다
    Then 명확한 오류로 멈춘다
    And 다른 모델로 대체하지 않는다
```

구현 근거: `cursor.js`, `cursor-provider.js`, main IPC, preload, renderer. 검증: `test/cursor.test.js`, `scripts/smoke.mjs`, `scripts/check-cursor-metadata.mjs`. 실제 검사 범위는 로그인 상태·ACP initialize/authenticate/session/new·ask 모드·session/set_model까지이며 session/prompt는 전송하지 않았다. ACP에는 파일·터미널 capability를 제공하지 않고 권한·계획 승인 요청에는 취소 응답한다. 현재 사용자 권한으로 실행되는 CLI를 OS 샌드박스로 설명하지 않는다. Cursor 잔여 비율은 자동 조회 미지원으로 표시하고 Cursor 대시보드로 안내한다. 신규 로그인 복구 및 유료 추론의 공급자별 실패 경로는 추가 실사용 검증이 필요하다.
