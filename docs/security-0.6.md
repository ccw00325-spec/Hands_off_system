# v0.6.0 보안 검사 · 2026-11-03

이 앱은 현재 OS 사용자의 권한으로 실행하는 로컬 도구다. 아래는 무료 검사와 방어 조치의 확인 범위이며 취약점·악성코드·백신 오탐 부재의 보증이 아니다. 개인 소스나 실행 파일을 VirusTotal 등 외부 분석 서비스에 업로드하지 않았다. 기존 V3·Windows 보안 설정·예외·방화벽·시작 프로그램을 변경하지 않았다.

## 적용한 경계

- renderer: Node 비활성, sandbox·context isolation·webSecurity 활성, 직접 네트워크 차단 CSP, 외부 창·탐색·webview·권한 거절. 제한된 preload와 main-frame 출처를 검사하는 IPC.
- 인증: Windows OS 암호화와 기기·OS 사용자 결합. 다른 저장소는 복호화 전 거부하고 원본을 보존. CLI 토큰·브라우저 쿠키를 복사하거나 IP만으로 인증하지 않음.
- 파일: 동의된 경로·기기·사용자·디스크 식별·grant ID, traversal·ADS·링크·하드 링크·외부 해시 변경 검사. `.env`, CLI 인증 폴더·키·vault·일반 인증 파일 제외.
- 실행: shell 문자열 조합 대신 인수 배열, 모델 ID의 옵션 주입 차단, 상속된 API 키·토큰·Node 실행 주입 옵션 제거. 별도 worker 작업 디렉터리와 호스트 적용 manifest. 실제 Cursor 호출 후 종료 대기를 포함한 정리.
- Codex/Claude 도구·hook 제한, ACP 클라이언트 도구·자동 승인 거절, Gemini 확장 제한·MCP 허용 목록·모든 도구 거부 정책. 외부 URL은 공식 HTTPS 호스트만 허용.
- npm 검증: 별도 사용자 동의와 지정 스크립트만, 프로젝트 npm.cmd 대신 절대 Node/npm, 자동 pre/post hook 비활성. 스크립트 본문은 **OS 사용자 권한**이며 컨테이너 격리는 아직 없음.
- 배포: 소스·package allowlist, 개인 프로필·개발 도구·인증 제외 검증, ASAR 무결성 확인.

## 무료 검사

| 도구                        | 확인                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| npm audit, production       | 취약점 0 (`artifacts/audit-production.json`)                                                                              |
| npm audit, 전체 빌드 의존성 | 중간 15, 높음·치명 0. 아래 잔여사항 참조                                                                                  |
| Gitleaks 8.30.1             | Git 이력과 최종 소스에서 비밀 유출 탐지 0. 출력은 redacted                                                                |
| Electronegativity 1.10.3    | 아래 검토 항목 4개. 미검토 경고를 성공으로 숨기지 않음                                                                    |
| ClamAV 1.5.4                | 공식 서명 DB 사용, 소스·ASAR·최종 실행 파일을 로컬 검사. 최종 결과는 아래 검사 기록과 `artifacts/clamav-final-output.txt` |
| 회귀·경계 검사              | 전체 84개, 데스크톱 23개, 다른 기기 저장소·권한 이탈·인증 URL·도구 거부·모델 옵션 주입 검사                               |

Gitleaks와 ClamAV는 공식 GitHub 배포본의 게시된 SHA256 digest와 다운로드 파일을 대조한 뒤 실행했다. ClamAV DB는 공식 freshclam으로 내려받아 서명 검증했다. 서비스 설치나 파일 삭제·격리 옵션은 사용하지 않았다.

Electronegativity의 네 항목은 다음과 같이 검토했다.

1. `CSP_GLOBAL_CHECK`(note): 로컬 `self`와 생성 PNG용 `data:` 이미지 허용. script/style은 self, connect/object/base/frame/form은 차단. inline/eval/원격 스크립트는 허용하지 않는다. file 프로토콜의 추가 권한 fuse는 기존 로컬 모듈 호환성을 위해 유지한다.
2. `OPEN_EXTERNAL_JS_CHECK`(note): 기본 브라우저 호출 전 `officialExternalURL`로 HTTPS·호스트·포트·사용자정보를 검사한다. 로그인 출력의 URL도 공급자별로 제한한다. URL 원문·승인 코드는 renderer 로그에 보내지 않는다.
3. `AUXCLICK_JS_CHECK`(warning): 구형 정적 검사의 일반 경고다. `setWindowOpenHandler`의 deny, `will-navigate`, `will-attach-webview`, CSP로 창·탐색·frame을 차단한다.
4. `PRELOAD_JS_CHECK`(note): renderer에 임의 require·파일·shell API 대신 고정된 IPC 메서드만 노출한다. main에서 송신 webContents·main frame·정확한 로컬 URL을 검사한다.

## 배포 fuse

RunAsNode 끔, NODE_OPTIONS 끔, Node inspect 인수 끔, CookieEncryption 켬, EmbeddedAsarIntegrityValidation 켬, OnlyLoadAppFromAsar 켬. `scripts/verify-package.mjs`가 실제 바이너리 값을 읽고 불일치 시 실패한다. 디버그 권한을 다시 열어 테스트하지 않고 별도 빈 프로필의 renderer IPC로 패키지 시작을 확인했다.

## 남은 위험과 검토

- 빌드 의존성 `minimatch <11.0.1`의 globparts 자원 소모 경고가 전체 audit에 중간 15개로 전파된다. 런타임 패키지에는 포함되지 않는다. 최신 electron-builder에서도 남아 있으며 npm의 자동 수정 제안은 큰 버전 변경을 요구한다. 구형 glob API에 11을 강제 주입하지 않았다. 빌드 패턴은 고정하고 신뢰할 수 있는 저장소만 빌드한다. [공식 권고](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- 기존 CLI 자체·사용자 전역 설정·권한을 신뢰한다. 호스트 도구 거부는 OS 격리와 다르며 임의 코드의 파일·네트워크 접근을 완전히 제한하지 않는다. 검증 실행에 컨테이너/별도 OS 계정 격리를 추가하는 작업은 남아 있다.
- 임의 이름의 비밀, 소스에 직접 적힌 개인 정보, 새로운 취약점은 탐지에서 빠질 수 있다. 소스 전송 동의가 필요하고 민감 프로젝트는 별도 검토해야 한다.
- Windows 서명 인증서 미등록. 무료 악성코드 검사 통과가 V3·SmartScreen 등 모든 제품의 탐지·평판을 보장하지 않는다. V3 자체의 수동 검사는 수행하지 않았다. 오탐 시 정상 배포 절차와 공식 오탐 신고를 사용하며 보안 예외나 회피 기법을 요구하지 않는다.

패키지 SHA256과 최종 악성코드 검사 결과는 아래에 기록한다.

## 최종 검사 기록

- 파일: `CW_Handsoff_sys 0.6.0.exe`, 375,927,943 bytes.
- SHA256: `782e2e9680b46a70fbbc3227b6e29543ae9af89e5cd268b650794da1e76f8b55`.
- ClamAV 1.5.4, 서명 3,628,245개, 소스·패키지 40개 파일, 감염 **0건**.
- 최종 패키지 소스 38개 일치, 불일치·개인 데이터·fuse 불일치 0.
- 검사 로그와 원문 SARIF·audit·Gitleaks 보고서는 로컬 `artifacts/`에 보존하고 Git에는 올리지 않는다.
