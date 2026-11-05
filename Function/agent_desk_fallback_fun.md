# 세로 AI 데스크·한도 소진 대체 경로 · DESK-019 · v0.1.9

사용자가 승인한 시안과 구현·커밋·푸시 요청을 기준으로 한다. 새로운 화면을 별도 앱으로 만드는 대신 기존 프로젝트·대화·검증·권한 처리를 연결한다.

```gherkin
Feature: 대화 중심의 역할별 AI 작업 공간
  Scenario: 두 개부터 네 개까지 세로 배치
    Given 프로젝트와 공식 CLI 계정이 연결되어 있다
    When 역할 설정에서 패널을 2개 또는 4개로 저장한다
    Then 가운데에는 큰 컨트롤 타워 대화가 있다
    And 옆에는 같은 수의 AI 카드가 세로로 배치된다
    And 좁은 화면에서는 카드가 아래로 쌓이며 로고 버튼이 줄어들지 않는다

  Scenario: 로고와 작업으로 실제 대화 열기
    Given AI가 작업을 보고하고 이전 기록이 있다
    When 로고 또는 작업 이름을 누른다
    Then 기존 로그와 질문 입력창이 팝업에 열린다
    And 작업 선택 시 변경 파일과 완료 기준도 표시된다
    And 컨트롤 타워 팝업은 메인과 동일한 대화와 작성 중 입력을 유지한다
    And 닫기와 Escape로 기존 화면에 돌아간다

  Scenario: 실제 작업 이벤트의 전달 표현
    Given 컨트롤 타워가 작업자를 배정했다
    When 배정 또는 완료 보고 이벤트를 수신한다
    Then 캐릭터가 곡선을 따라 해당 방향으로 상자를 운반한다
    And 진행 상태와 이전 작업은 누적되며 전체 검증 전에는 구현 완료로 구분한다
    And 움직임 끄기 또는 reduced-motion 설정을 따른다

  Scenario: 알림의 표시와 보관
    Given 시안 확인이나 한도 전환 등 알림이 생성됐다
    When 약 10초가 지나면
    Then 화면 알림은 닫히고 종 버튼의 기록은 유지된다
    When 항목에 마우스 또는 키보드 초점이 이동하면
    Then 개별 삭제 버튼이 보인다
    And 전부 지우기는 작업과 대화에 영향을 주지 않는다
    And 삭제한 이벤트를 재생해도 기록을 다시 생성하지 않는다
```

```gherkin
Feature: 인증된 대체 AI로 현재 요청 이어가기
  Scenario: Gemini 한도 소진 후 Claude 대체
    Given 기본 AI가 Gemini이고 대체 AI로 로그인된 Claude가 지정돼 있다
    When 공급자 오류에 명시적인 사용 한도 소진이 확인된다
    Then 현재 요청을 같은 작업 ID와 명세와 소스와 완료 기준으로 Claude에 한 번 보낸다
    And 실제 실행 AI와 모델을 호스트가 기록한다
    And 카드 로고와 이름과 모델과 대체 표시를 갱신한다
    And 작업 완료 이후 개별 질문도 Claude로 보낸다
    And 새 작업에서는 기본 Gemini부터 다시 시작한다

  Scenario: 제한적인 전환과 중단
    Given 대체 AI가 없거나 로그인되지 않았거나 한도를 소진했다
    When 기본 AI 한도 소진을 처리한다
    Then 무한 전환하지 않고 사용자 확인 상태로 멈춘다
    And 취소 후 대체 요청을 뒤늦게 시작하지 않는다
    And 속도 제한과 인증과 네트워크와 컨텍스트 길이 오류에는 자동 전환하지 않는다
    And 공급자 내부 세션이나 로그인 자격증명을 복사하지 않는다

  Scenario: 예산과 실제 실행 이력
    Given 호출 수 또는 GPT API 예산이 설정돼 있다
    When 대체 요청을 보내려 한다
    Then 실패한 기본 요청과 대체 요청을 각각 계산한다
    And 새 요청 전 한도와 모델 단가를 검사한다
    And 공급자 실행 방식이나 이미지 API 결제 경로를 자동 변경하지 않는다
```

근거: `agent-desk.js`, `desk-state.js`, `mascot.js`, `notification-view.js`, `notifications.js`, `roles.js`, `team.js`, `workflow.js`, `agent-chat.js`.

검증: `fallback.test.js`, `desk-notifications.test.js`, `smoke-v07.mjs`, `desktop-fallback.mjs`. 전체 149개 단위·통합 및 36개 데스크톱 시나리오 통과. 한도 소진은 공급자 오류 주입으로 재현했고 실제 유료 추론은 사용하지 않았다. 공급자별 실제 CLI 오류 형식은 변경될 수 있어 알 수 없는 오류는 자동 전환 성공으로 간주하지 않는다.
