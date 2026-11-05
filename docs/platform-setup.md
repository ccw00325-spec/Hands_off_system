# Windows · Mac 설치와 실행

같은 소스와 버전을 두 저장소에 함께 반영합니다.

Mac의 최종 네이티브 검증 대상은 macOS 26 Apple Silicon과 macOS 15 Intel 러너입니다. 다른 모든 macOS 버전의 실행까지 확인했다는 의미는 아닙니다.

| 환경 | 저장소 | 패키지 |
| --- | --- | --- |
| Windows x64 | [Hands_off_system_window](https://github.com/ccw00325-spec/Hands_off_system_window) | 포터블 `.exe` |
| Mac Apple Silicon | [Hands_off_system_mac](https://github.com/ccw00325-spec/Hands_off_system_mac) | arm64 `.dmg`·`.zip` |
| Mac Intel | [Hands_off_system_mac](https://github.com/ccw00325-spec/Hands_off_system_mac) | x64 `.dmg`·`.zip` |

저장소의 Actions에서 성공한 `Platform verification and packages` 실행을 열고 자신의 OS·CPU에 맞는 Artifacts를 내려받습니다. GitHub 로그인이 필요하며 파일은 30일 동안 보관합니다. 검증이 실패한 실행에는 배포 패키지를 올리지 않습니다. Mac은 ad-hoc 서명만 사용하므로 Developer ID 서명·Apple 공증을 받은 앱과 다르며 Gatekeeper 경고가 날 수 있습니다. 보안 설정을 전역으로 끄는 절차를 제공하지 않습니다.

## 처음 켰을 때

패키지에는 앱을 표시할 Electron 런타임이 포함됩니다. 소스 실행에 필요한 개발용 Node.js를 앱 자체 실행 조건과 혼동하지 마세요. 프로젝트 테스트와 일부 CLI에는 외부 Node.js가 필요합니다.

1. 중앙의 흰색 시작 창에서 도구·연결·모델 목록을 점검합니다.
2. 빠진 도구가 있으면 공식 설치 페이지를 여는 안내가 나옵니다.
3. 설치를 마친 뒤 **설치 후 다시 확인**을 누릅니다. 사용할 AI의 CLI만 준비하면 됩니다.
4. **나중에 준비하고 둘러보기**를 누르면 설치를 강요하지 않고 화면을 먼저 살펴볼 수 있습니다. 해당 도구가 필요한 작업의 성공을 대신 표시하지는 않습니다.
5. 이후에는 **설정 → 설치 도구 확인**에서 다시 열 수 있습니다.

공식 설치 안내:

- [Node.js·npm](https://nodejs.org/en/download): 이 앱은 24 이상을 확인합니다.
- [Git Windows](https://git-scm.com/install/windows), [Git Mac](https://git-scm.com/install/mac): GitHub 전송에 사용합니다. Mac에서 설치되지 않은 `/usr/bin/git` 스텁을 실행해 설치창을 강제로 띄우지 않습니다.
- [Codex CLI](https://developers.openai.com/codex/cli), [Claude Code](https://code.claude.com/docs/en/setup), [Cursor CLI](https://cursor.com/docs/cli/installation), [Gemini CLI](https://geminicli.com/docs/get-started/installation/): 사용할 AI만 설치하고 각자의 계정으로 로그인합니다.
- [Docker](https://docs.docker.com/get-started/get-docker/): 격리 실행에 필요합니다. Desktop의 이용 조건은 [공식 라이선스 안내](https://docs.docker.com/subscription/desktop-license/)를 확인하세요.

설치 파일을 자동 실행하거나 `curl | sh`, PowerShell 원격 설치 스크립트를 앱이 실행하지 않습니다. 설치 페이지는 버튼을 눌렀을 때만 기본 브라우저에서 엽니다. Windows의 기본 설치 위치와 Mac의 Homebrew·`~/.local/bin`·nvm 설치 경로도 검색하므로 새 PATH가 앱에 상속되지 않은 경우를 줄입니다. 임의의 모든 버전 관리자·사용자 지정 경로를 발견한다고 보장하지는 않습니다.

## Docker 실행 준비

엔진을 실행하고 Linux 컨테이너 모드를 사용합니다. 터미널에서 기본 이미지를 준비하세요.

```sh
docker pull node:24-bookworm-slim
```

앱은 이미지를 자동으로 내려받거나 네트워크를 허용해 의존성을 설치하지 않습니다. 기본 이미지는 Node 내장 테스트에 적합합니다. npm 라이브러리가 필요한 프로젝트는 신뢰하는 환경에서 의존성을 준비한 이미지를 사용하고 설정의 **로컬 Linux 격리 이미지**에 지정하세요. `/opt/node_modules`에 준비한 의존성은 임시 작업 공간에 연결됩니다. Windows의 `node_modules`를 Linux 컨테이너에 그대로 전달하지 않습니다.

테스트의 원본 폴더·사용자 홈·`.env`·로그인·Docker 소켓을 컨테이너에 마운트하지 않습니다. 안전한 복사본만 읽기 전용으로 전달하고 결과 코드는 모두 임시 공간에 남겨 폐기합니다. 변이 검사의 작은 JSON 보고서만 호스트가 정해진 내부 경로에 저장합니다. 원격 Docker 컨텍스트도 허용하지 않습니다. Docker가 없거나 이미지가 미비하면 보류하고 PC 직접 실행으로 자동 전환하지 않습니다.

부득이하게 호스트에서 실행하려면 **설정 → 현재 PC**를 선택하고 별도 경고에 동의해야 합니다. 전역 실행 동의와 폴더별 실행 승인도 필요합니다. 선택한 npm 스크립트는 임의 코드를 실행할 수 있으므로 이 모드는 신뢰하는 프로젝트에 한정하세요.

## 직접 빌드와 두 저장소 반영

Windows에서는 `npm run package:win`, Mac에서는 `npm run package:mac -- --arm64` 또는 `--x64`를 실행합니다. Mac 앱의 빌드·서명·네이티브 실행 검증은 macOS에서 합니다. [electron-builder의 플랫폼별 빌드 안내](https://www.electron.build/v26/docs/features/multi-platform-build/)

Mac CI는 `macos-26` arm64와 `macos-15-intel` x64에서 각각 단위 검사·Electron 시뮬레이션·패키지 고지·fuse·서명 무결성·빈 프로필의 실제 앱 시작을 확인합니다. Docker 격리는 Ubuntu 러너에서 실제 컨테이너로 검사합니다. [GitHub 러너 사양](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)

유지보수자는 변경을 검증하고 커밋한 뒤 `npm run sync:platforms`를 실행합니다. 이 명령은 승인된 `origin`·`mac` 주소를 확인하고 같은 커밋을 양쪽 main에 푸시한 뒤 원격 HEAD를 대조합니다. 강제 푸시는 하지 않습니다. 한쪽 반영이 실패하면 성공으로 보고하지 않으며 해당 차이를 해결해야 합니다. 이 원칙은 루트 [AGENTS.md](../AGENTS.md)에도 기록합니다.
