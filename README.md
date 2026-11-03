<p align="center">
  <img src="assets/banner.png" alt="AI Program — Built for Real Work, Not Just Demos" width="100%">
</p>

# CW_Handsoff_sys

Windows x64 · v0.1.4

만들고 싶은 앱을 한 번 설명하면, **Hands off**가 기능 명세를 정리하고 여러 AI에 구현과 테스트를 나눠 맡깁니다. 컨트롤 타워에서 작업 진행과 검토 결과를 확인하고, 완성된 코드는 내 프로젝트 폴더에서 바로 열어볼 수 있습니다.

> “거래를 추가하고 검색할 수 있는 가계부를 만들어줘. 월별 수입과 지출도 보고 싶어.”

이렇게 요청하면 컨트롤 타워가 필요한 화면과 완료 기준을 정리합니다. 기능과 UI를 맡은 AI가 각자 작업하고, 테스트 역할을 배정했다면 테스트 코드와 실행 결과도 남깁니다. 검토에서 문제가 발견되면 컨트롤 타워가 해당 작업을 맡은 AI에 수정을 요청합니다.

## Windows에서 시작하기

포터블 빌드가 있다면 `release/CW_Handsoff_sys 0.1.4.exe`를 실행하세요. GitHub Releases에 실행 파일을 등록하기 전까지는 아래 방법으로 소스에서 실행하거나 직접 빌드할 수 있습니다. 소스 실행에는 저장소 접근 권한이 있는 GitHub 계정, Git, Node.js 24 이상이 필요합니다.

```powershell
git clone https://github.com/ccw00325-spec/Hands_off_system.git
cd Hands_off_system
npm ci
npm start
```

포터블 실행 파일을 만들려면 같은 폴더에서 다음 명령을 실행하세요. 현재 버전의 `.exe`가 `release/`에 생성됩니다.

```powershell
npm run package:win -- --config.compression=store
```

## 첫 작업 요청하기

1. **새 프로젝트**를 눌러 작업 폴더를 선택하고 접근 범위를 확인합니다.
2. **계정 · 연결**에서 사용할 AI를 연결합니다. 이미 공식 CLI에 로그인했다면 그 계정을 사용할 수 있습니다.
3. **AI 역할 변경**에서 2~4개 패널에 역할을 배정합니다. 한 AI에 여러 역할을 맡기거나 같은 계정을 여러 패널에 쓸 수 있습니다.
4. 맨 위 **컨트롤 타워**에 원하는 기능을 설명합니다. 작업자 패널에서 진행 내용을 보고 각 AI에 직접 질문할 수 있습니다.
5. 오른쪽 **실행 현황**에서 테스트 결과와 남은 검토 사항을 확인합니다. 프로젝트별 대화와 작업 기록은 왼쪽 목록에서 다시 열 수 있습니다.

## 테스트에서 배포까지

**테스트 설계·실행**을 역할로 추가하면 요구사항에 맞춰 테스트 코드와 재현 절차를 작성합니다. 프로젝트 코드 실행에 동의한 뒤 Node 내장 `node:test` 또는 지정한 npm 스크립트로 검증합니다. 실행 검증을 통과하고 최종 검토 지적이 해소되면 작업을 완료로 표시합니다.

**보조 서비스 연결**에서는 공식 CLI 로그인 상태를 확인하고 프로젝트별 대상을 정할 수 있습니다.

| 서비스 | 할 수 있는 일 |
| --- | --- |
| GitHub | 검증된 소스를 새 비공개 저장소에 커밋·푸시합니다. 저장소 이름을 비워 두면 컨트롤 타워가 이름을 제안합니다. |
| Vercel | 지정한 계정 또는 팀의 프로젝트에 배포합니다. 기본값은 미리보기이며, 운영 배포는 설정에서 선택할 수 있습니다. |
| Supabase | 계정 연결 상태를 확인하고 프로젝트별 참조 ID를 저장합니다. 프로젝트 연결과 DB 마이그레이션은 Supabase CLI에서 진행합니다. |

검증이 끝나면 GitHub 푸시와 Vercel 배포 여부를 각각 묻습니다. **아니요**를 누르면 이번 작업에서 해당 서비스만 건너뜁니다. **다음부터 묻지 않기**를 체크하고 **예**를 누르면 같은 프로젝트와 대상에 대해 이후 작업부터 자동으로 진행합니다. 보조 서비스 설정에서 자동 승인을 해제할 수 있습니다.

## 연결할 수 있는 AI

| AI | 연결 방식 |
| --- | --- |
| GPT | 공식 Codex CLI의 ChatGPT 로그인과 계정에 제공되는 모델 목록을 사용합니다. |
| Claude | Claude Code 로그인으로 연결합니다. |
| Grok | Cursor Agent 계정에서 사용할 수 있는 Grok 모델을 선택합니다. |
| Gemini | Gemini CLI의 Google 계정으로 연결합니다. |
| 이미지 생성 | 개인 OpenAI API 키를 등록해 GPT Image를 사용합니다. 이미지 API 사용료는 ChatGPT 구독과 별도입니다. |

같은 계정을 여러 패널에서 쓰면 사용 한도를 공유합니다. 프로젝트 코드 실행은 동의한 경우 현재 Windows 사용자 권한으로 진행됩니다. [보안과 실행 범위](docs/security-0.7.md)

## 개발과 검증

```powershell
npm run check
npm test
npm run test:desktop
npm run verify:package
```

`test:desktop`은 테스트 응답으로 UI와 작업 흐름을 검사합니다. `test:timer:live`, `test:timer:qa:live`, `test:chat:live`는 실제 AI 계정의 사용 한도를 소비합니다. 포터블 빌드를 검증한 뒤에는 이전 버전 실행 파일을 정리합니다. [검증 기록](VALIDATION.md) · [배포 관리 규칙](docs/release-policy.md)
