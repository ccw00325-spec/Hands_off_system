# /fun 질문·답변·Windows 알림 · 0.1.0

- [x] 결정: /fun 빈칸 질문, 선택지와 직접 입력, Windows 알림·소리, /mut 옆 켜기/끄기, 버전 0.1.0 재설정.
- [x] 구현: 컨트롤 타워 전용 스킬 로딩, 질문 중 구현 보류, 동일 작업 재개, 대화별 질문 식별·답변 검증, 네이티브 알림 클릭 연결.
- [x] 검증: 회귀·첫 실행·새 질문 시뮬레이션·배포 패키지와 두 플랫폼 CI 결과를 최종 검증 기록에 반영.

## Context → Trigger → Reaction

```gherkin
Feature: /fun 사용자 결정 확인
  Scenario: 미정 요구사항
    Given 새 작업의 /fun이 켜져 있다
    When 컨트롤 타워가 미정 조건을 질문으로 제출하거나 미승인 가정을 제안한다
    Then 구현 작업을 실행하지 않고 선택지와 직접 입력 팝업을 연다
    And 어떤 답변도 자동 선택하지 않는다
  Scenario: 명시적 답변
    Given 현재 프로젝트·대화·작업의 질문이 대기 중이다
    When 모든 질문에 답변하고 전송한다
    Then 질문과 사용자 답을 기록하고 같은 작업 ID로 명세 작성을 재개한다
    And 잘못된 대화·이전 질문 묶음·중복 전송·미완성 답변은 거부한다
  Scenario: 답변 보류와 복원
    When 나중에 답변 또는 닫기를 선택한다
    Then 답변을 승인하지 않고 작업을 보류한다
    And 질문에 답변하기로 다시 열 수 있다
    And 앱 재시작 뒤에도 저장된 질문과 제출 답변을 복원한다
  Scenario: Windows 백그라운드 알림
    Given 새 질문 묶음이 생겼다
    When 구현을 보류한다
    Then 일반적인 답변 필요 문구로 OS 알림과 기본 소리를 한 번 요청한다
    And 잠금 화면 알림에 요구사항·파일·키를 복사하지 않는다
    And 알림 클릭은 해당 프로젝트·대화를 열고 최소화된 창을 복원한다
    And OS 차단이나 오류에도 질문과 앱 안 알림은 보존한다
  Scenario: /fun 끄기
    When /mut 옆 /fun 체크를 해제하고 새 작업을 요청한다
    Then 원문 fun 스킬을 읽거나 전달하지 않고 직접 계획한다
    And 켜기·끄기 선택을 저장해 다음 실행의 새 작업에도 적용한다
    And 실행 권한·비밀값·충돌·검증·위험 행동 승인 보호는 유지한다
```

## 근거·제한

원문 스킬은 컨트롤 타워에만 로드한다. `funContract`의 구조 검증은 스킬 활성화와 독립된 호스트 프로토콜이다. 끄면 `Function/*_fun.md` 대신 내부 일반 명세를 저장한다. 답변은 사실 인계에도 포함한다. 미제출 초안은 현재 실행 메모리에서만 유지하고 재시작 복원을 약속하지 않는다.

Windows 포터블의 알림 등록은 현재 사용자의 시작 메뉴에 앱 전용 바로가기를 만들며 자동 시작이나 관리자 권한을 설정하지 않는다. 다른 앱의 바로가기는 덮어쓰지 않는다. 실제 표시·소리는 OS 권한·음량·방해 금지에 따른다. Mac의 미공증/ad-hoc 서명에서는 OS 알림이 제한될 수 있으므로 앱 팝업과 종 알림을 유지한다. 표시 여부와 물리적으로 소리가 들렸는지는 별개로 기록한다.

플랫폼 구현 근거: [Electron 알림](https://www.electronjs.org/docs/latest/tutorial/notifications), [바로가기의 AppUserModelID·Toast CLSID](https://www.electronjs.org/docs/latest/api/structures/shortcut-details), [Notification의 silent 설정](https://www.electronjs.org/docs/latest/api/notification).
