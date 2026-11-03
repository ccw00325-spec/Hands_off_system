# 현재 배포 기준 0.1.0 · 최상단 컨트롤 타워

2026-11-03 사용자 요청으로 배포 번호를 0.1.0으로 다시 맞췄다. 기존 기능은 유지하며 이전 `Agent Control Tower 0.1.0.exe` 실험판과 현재 제품을 구분한다. 현재 파일명은 `CW_Handsoff_sys 0.1.0.exe`다.

- `npm run check`: 소스·테스트 구문 검사 통과.
- `npm test`: **101개 통과**, 실패·skip 0. 버전 0.1.0→0.1.1 및 0.1.9→0.2.0, manifest/lock 일치, 새 파일 없이 삭제 금지, 현재 파일·다른 파일 보존, 외부 정션 정리 금지를 포함한다.
- `npm run test:desktop`: 실제 Electron UI **20개 통과**. 컨트롤 타워가 맨 위이고 작업자보다 큰지, 그 다음 DOM이 하향 dispatch인지, 실제 앱 버전이 헤더에 표시되는지 확인했다.
- 기존 테스트 역할·대화·설정·파일 접근 동의·원 담당자 수정·캐릭터 전달·2~4패널·재시작 복원과 320~1920px 가로 넘침 검사도 통과했다.
- UI 공급자 응답은 명시적 fixture이며 실제 coordinator/Node 테스트/IPC를 검사한다. 이번 배치·버전 변경으로 유료 AI 추론을 다시 실행하지 않았다. 이전 실추론 결과와 제한은 [이전 검증](verification-0.7.md)에 보존한다.

## 빌드와 정리 재현

```powershell
npm run package:win -- --config.compression=store
powershell -NoProfile -File scripts/check-packaged-startup.ps1
```

첫 명령은 버전을 자동 증가시키지 않는다. 빌드 성공 후 ASAR 소스·개인 데이터 제외·강화 fuse 검증을 통과하면 이전 제품 이름의 실행 파일과 builder-debug.yml을 정리한다. 모든 삭제 대상은 먼저 release 내부의 일반 파일인지 확인하며 재귀 삭제는 하지 않는다. 새 파일이 없으면 기존 파일을 삭제하지 않는다. [버전·정리 정책](release-policy.md)

## 최종 배포와 정리 결과

- 파일 `CW_Handsoff_sys 0.1.0.exe`, 376,018,197 bytes.
- SHA256: `4b38ee7527c66fd556eb5a4dd4a78a8c3806332ab9c0fec88f26d00155bc7b0b`.
- ASAR 소스 46개 일치, 개인 데이터·불필요 SDK 포함 0, 강화 fuse 6개 일치.
- 별도 빈 프로필 시작 성공: ProductVersion `0.1.0.0`, renderer IPC 초기화 성공, 개발자 vault 복사 없음.
- 이전 Agent Control Tower 0.1.0/0.2.0/0.3.0/0.4.0, CW_Handsoff_sys 0.5.0/0.6.0/0.7.0 실행 파일과 builder-debug.yml 삭제 확인. release 최상위 실행 파일은 현재 0.1.0 한 개다.
- 첫 정리 시 실행 중이던 0.7.0의 Windows 파일 잠금으로 일부 정리가 보류됐다. 종료 후 재시도해 모두 제거했다. 잠금 안내·제한된 재시도를 보완했고 관련 안전성 검사 4개를 다시 통과했다.
- 로컬 원문은 `artifacts/release-reset-report.json`, `package-verification.json`, `packaged-startup-v07.json`, `tests-reset-010.txt`, `smoke-reset-010.txt`에 보존한다. 산출물·프로필은 Git에 포함하지 않는다.
- ClamAV 1.5.4, 공식 서명 3,628,245개로 최종 소스·exe·ASAR 48개 파일 검사: 감염 **0**. 2026-11-03 12:34~12:37 KST, 삭제·격리·외부 업로드 없음. `artifacts/clamav-reset-010-output.txt`.
- Gitleaks로 커밋 대상 변경을 redacted 모드로 검사: 비밀정보 유출 탐지 **0**. 새 런타임 의존성은 추가하지 않았다. 기존 빌드 의존성 경고·서명 미등록·OS 격리 부재는 [이전 보안 기록](security-0.7.md)에 보존한다.
