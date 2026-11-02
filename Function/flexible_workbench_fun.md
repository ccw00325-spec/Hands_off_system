# 유연한 작업 공간 · WORKBENCH-006 · v0.6.0

- [x] 결정: 사용자 1~7번 요구, 무질문 구현과 비공개 push 위임.
- [x] 구현: 2~4패널·복수/중복 역할·동일 AI·패널 모델·기기 인증/동의 격리.
- [x] 검증: 단위·실제 Electron·실제 GPT 타이머 생성, 자동 수정, 최종 검토와 삭제.
- [ ] 사용자 직접 확인: 신규 Google/Claude 승인, 다른 PC, 코드 서명과 백신 평판.

기술적 가정: 첫 패널만 control, feature/ui 각각 한 번 이상, 프로젝트 저장·실행 배치 고정, 자동 수정 초기값 2(0~20). IP 대신 기기·OS 사용자에 결합한다. 가역적 세부사항은 기록하고 진행하되 계정 승인·결제·권한 확대는 대신 하지 않는다. 이 사용자의 무질문 위임이 Fun 질문 우선 절차보다 우선한다.

```gherkin
Feature: 유연한 에이전트 실행
  Scenario: 구독 하나로 두 패널
    Given 현재 OS 사용자의 Codex ChatGPT 인증이 유효하다
    When GPT control/debug와 GPT feature/ui를 배정한다
    Then 중복 로그인 없이 독립 요청으로 실행한다
    And 공급자 사용 한도와 동시 요청 제한을 따른다

  Scenario: 네 패널과 중복 역할
    Given 네 패널에 알려진 AI와 적어도 한 역할이 있다
    When feature와 ui를 여러 worker에 중복 배정한다
    Then 의존성이 충족된 독립 작업을 병렬 실행한다
    And 같은 소스 버전을 네 패널에서 최종 검토한다

  Scenario: 명세 누락
    Given 첫 planner에만 전체 Fun 지침을 전달했다
    When CTR·완료 기준·디자인·요구사항-작업 연결이 누락된다
    Then 호스트가 거절하고 한 번 보완을 요청한다
    And 계속 불완전하면 구현을 중지한다

  Scenario: 복사한 저장소와 폴더 동의
    Given 저장소의 기기·OS 사용자 결합이 다르다
    When 연결 또는 파일 접근을 요청한다
    Then 인증을 복호화하거나 이전 동의를 재사용하지 않는다
    And 이 PC의 공식 CLI 연결 또는 새 폴더 동의를 요구한다

  Scenario: 검증 실행
    Given 특정 npm 스크립트 실행에 동의했다
    When 실행 검증을 시작한다
    Then 절대 Node/npm을 사용하고 자동 pre/post hook을 끈다
    And 실패하거나 검증이 없으면 전체 완료로 표시하지 않는다

  Scenario: 로그인 복구
    Given CLI가 설치되고 신규 로그인이 필요하다
    When 연결하기를 누른다
    Then 공식 브라우저·승인 대기·다시 열기·시도 취소를 제공한다
    And 취소가 원래 CLI를 로그아웃하지 않는다

  Scenario: 타이머 실험 정리
    Given 앱이 소유 표시한 임시 폴더에 실제 GPT로 타이머를 만들었다
    When 실행 검사와 자동 수정·최종 검토가 끝난다
    Then 경계와 소유 표시를 확인해 그 폴더만 삭제한다
    And 소스 없는 검사 보고서를 남긴다
```

근거: `team.js`, `fun-contract.js`, `codex.js`, `device-binding.js`, `workspace.js`, `validation.js`, `workflow.js`, `workbench.js`. 검사: `team-fun-security.test.js`, `codex.test.js`, `smoke.mjs`, `simulate-timer.mjs`. 구체 결과는 `docs/verification-0.6.md`가 최신이며 과거 명세의 고정 3역할·미추론 상태를 대체한다.
