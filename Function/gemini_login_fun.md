# Gemini Google 로그인 · GEMINI-001 · v0.4 · 2026-11-02

- [x] 공식 CLI 탐색·설치·연결 UI — 결정 ✅ / 구현 ✅ / 검증 일부: 이 PC에서 공식 CLI 0.66.0 설치·ACP 초기화 및 미인증 처리 확인. 앱 내 설치 버튼의 실제 다운로드는 미실행.
- [x] Google 인증·취소·기존 인증 유지 — 결정 ✅ / 구현 ✅ / 검증 일부: 단위 검사. 실제 계정 승인은 미실행.
- [x] 실행 모델 목록·선택·저장 — 결정 ✅ / 구현 ✅ / 검증 일부: 공급자 응답 격리 검사 및 공식 CLI 구현 확인. 로그인된 계정의 실제 목록은 미조회.
- [ ] 실제 코드 생성·검토 — 결정 ✅ / 구현 ✅ / 검증 ⬜: 사용자 Google 승인과 공급자 추론 검증 필요.

원문: “Gemini도 로그인 가능하게 그리고 변경도 가능하게 추가해줘”. D-G01은 원본 Gemini CLI의 Google 로그인, D-G02는 역할 선택에 Gemini 포함이다. API 키나 공급자 토큰을 앱에 복사하지 않는다. PC에 Node.js 20 이상이 필요하며 기존 npm 설치를 찾거나 앱 데이터의 도구 폴더에 공식 0.66.0을 설치한다. 앱 설치 버튼은 사용자 클릭 시 다운로드한다.

Context: CLI 미설치·Google 미연결·기존 인증·승인 대기·취소·연결 실패. Trigger: 설치, Google 로그인, 브라우저 다시 열기, 취소, 모델 목록 조회·선택. Reaction: ACP `initialize`와 `session/new`로 상태를 확인하고, 명시적 로그인 때만 `authenticate`의 `oauth-personal`을 요청한다. 메타데이터 확인은 `NO_BROWSER=true`로 새 로그인창을 열지 않는다. 최초 로그인은 원본 CLI의 시스템 브라우저에서 진행하며, 링크를 받은 뒤의 다시 열기는 앱의 브라우저 설정을 따른다. 취소 중 초기화가 완료돼도 뒤늦게 인증 요청을 보내지 않는다.

```gherkin
@confirmed
Feature: Google 계정으로 Gemini 연결
  Scenario: S-G01 사용자가 로그인 시작
    Given 공식 Gemini CLI가 설치되어 있고 Google 인증이 없다
    When Google 로그인을 누른다
    Then 원본 CLI의 공식 Google 승인 화면을 연다
    And 앱은 Google 비밀번호나 인증 토큰을 받지 않는다

  Scenario: S-G02 초기화 중 취소
    Given 로그인용 ACP 초기화가 진행 중이다
    When 로그인을 취소한다
    Then 뒤늦은 authenticate 요청은 보내지 않는다
    And 기존 CLI 인증을 지우거나 로그아웃하지 않는다
```

구현: `gemini.js`, `rpc-process.js`, main·preload·renderer. 검증: 공식 0.66.0 CLI help·ACP initialize의 `oauth-personal` 제공·미인증 세션 오류, `test/roles-gemini.test.js`. 모델은 세션의 실제 목록에서 선택하고 실행 시 다시 확인한다. 클라이언트 파일·터미널 도구를 제공하지 않으며 읽기 전용 모드 확인 실패 시 멈춘다. CLI는 OS 샌드박스가 아니며 기존 시스템 정책·플랜·모델 접근에 영향을 받는다. 구독 잔량 자동 조회는 추가하지 않았다. 공식 근거: https://geminicli.com/docs/get-started/authentication/ , https://geminicli.com/docs/cli/acp-mode/ .
