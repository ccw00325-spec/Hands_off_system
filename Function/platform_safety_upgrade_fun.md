# 플랫폼·설치·실행 보호 개선 · v0.2.4

- [x] 사용자 결정: 다섯 개선안, 첫 실행 도구 점검, Windows/Mac 저장소 분리, 앞으로 양쪽 커밋·푸시를 함께 수행.
- [x] 구현: 구조화 인계·공유 쿼터·Docker 실행·텍스트 구조안·선택형 변이 검사·공식 설치 안내·macOS 빌드 경로.
- [ ] 최종 검증: Windows 회귀·포터블, Mac arm64/x64 CI·패키지 시작, Linux 실제 Docker 결과를 검증 기록에 반영.

## 결정과 범위

D1. 벤더의 비공개 세션은 복제하지 않고 명세·기준·파일 해시·변경 배치·최근 사실·오류를 인계한다. 내부 추론이 아닌 사용자에게 설명 가능한 작업 사실만 다룬다.

D2. 작업별·일일 호출 수와 이미지 횟수를 공유 원장으로 사전 차단한다. 텍스트 API는 입력 바이트·최대 출력·설정 단가로 비용을 예약한다. 실제 청구 상한을 보증하지 않는다. 이미지 비용을 산정할 수 없는 금액 예산 설정에서는 해당 요청을 보내지 않는다. 한도 변경은 사용자 설정 저장으로 승인한다.

D3. 앱과 공식 로그인은 호스트에서 유지하고 프로젝트 테스트·빌드만 Docker에 격리한다. 사용할 수 없으면 보류한다. 호스트 실행은 명시적 위험 확인을 거친 선택 사항이다. Docker 자체의 모든 취약점을 없애는 보호라고 주장하지 않는다.

D4. 기본은 텍스트 구조안과 승인이다. 이미지 생성 버튼 또는 이미지 기본 형식을 명시적으로 선택한 경우에만 이미지 API를 쓴다. 텍스트 수정 요청에는 별도 이미지 호출을 하지 않는다.

D5. 일반 테스트가 기본이며 뮤테이션은 고급 선택이다. 선택 시 미설정 오류는 통과로 바꾸지 않는다. Stryker·테스트 의존성은 앱이 무단 설치하지 않는다.

D6. 로딩 중 Node 24+·npm·Git·Docker 엔진/이미지·선택 AI CLI를 확인하고 준비 안내를 보인다. 사용하지 않는 CLI까지 요구하지 않는다. 고정 공식 HTTPS URL만 열고 사용자가 직접 설치한다. 설치 안내를 건너뛰어도 미검증 작업이 성공으로 바뀌지는 않는다.

D7. `_Window`, `_Mac` 저장소는 같은 공유 소스·버전·커밋을 유지한다. Windows x64, Mac arm64/x64 각각의 환경에서 검사한다. Mac Developer ID 서명·공증은 이번 승인에 필요한 인증서가 없어 제공하지 않는다.

## Context → Trigger → Reaction

```gherkin
Feature: 재현 가능한 인계
  Scenario: 공급자 사용 한도 소진
    Given 작업 명세와 현재 소스 해시 및 미해결 테스트가 있다
    When 연결된 다른 AI로 전환한다
    Then 같은 작업 기준과 사실 스냅샷을 전달한다
    And 파일 적용 전 기준 해시·충돌 검사를 유지한다

Feature: 호출 전 제한
  Scenario: 여러 프로젝트의 동시 요청
    Given 오늘 남은 호출이 한 번이다
    When 두 작업자가 동시에 호출을 요청한다
    Then 하나만 공유 원장에 예약하고 나머지는 차단한다
    And 앱을 재시작해도 오늘 사용량은 초기화하지 않는다
  Scenario: 알 수 없는 실제 비용
    Given API 비용을 예약했다
    When 응답 사용량을 확인하지 못했다
    Then 예약 비용을 임의로 환불하지 않는다

Feature: Docker 격리
  Scenario: 엔진 없음
    Given 사용자가 Docker 실행을 선택했다
    When Docker 또는 로컬 이미지가 준비되지 않았다
    Then 설정 필요로 보류하고 호스트에서는 실행하지 않는다
  Scenario: 악성 검증 코드
    Given 비밀 파일을 제외한 읽기 전용 복사본을 전달했다
    When 코드가 호스트 쓰기·비밀 접근·외부 통신을 시도한다
    Then 컨테이너 경계로 원본과 자격증명 및 호스트 소켓 접근을 제공하지 않는다
    And 컨테이너 작업 결과는 검증 보고서 외에 프로젝트로 복사하지 않는다

Feature: 가벼운 시안
  Scenario: 기본 UI 요청
    When UI 작업을 계획한다
    Then 이미지 API 없이 텍스트 구조안을 준비하고 승인을 기다린다
    And 명시적으로 이미지 버튼을 누르면 이미지 생성 비용을 안내한다

Feature: 첫 실행 공구함
  Scenario: 누락된 설치
    Given 필요한 도구가 없거나 Node 버전이 낮다
    When 시작 준비가 끝난다
    Then 첫 실행 안내 전에 설치 목록을 표시한다
    And 공식 설치 버튼을 누른 경우에만 브라우저를 연다
    And 재검사 결과로 상태를 갱신한다
```

## 근거와 검증

코드: `call-quota.js`, `handoff.js`, `docker-execution.js`, `layout-preview.js`, `prerequisites.js`, `tool-paths.js`, `mac-terminal.js`, Workflow·preferences·renderer 및 플랫폼 CI.

검증: `test/platform-upgrade.test.js`, `check-prerequisites-ui.mjs`, `smoke-v07.mjs`, `check-startup.mjs`, `check-startup-recovery.mjs`, `check-docker-isolation.mjs --require`, 플랫폼별 패키지 검사. 실제 실행 범위와 실패·수정 이력은 [VALIDATION.md](../VALIDATION.md)에 남긴다. 유료 추론·실제 새 사용자 로그인 및 Apple 공증을 수행했다고 주장하지 않는다.
