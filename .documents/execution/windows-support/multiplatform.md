# 2.12.6: 플랫폼 package와 Linux Codex 리뷰

2026-09-16에 Windows, macOS, Linux의 ARM64·x64 VSIX 6개를 만들고
Marketplace에 게시했다. x64는 amd64와 같다. 공개 Gallery의 6개 VSIX가
업로드한 bytes와 일치하고 Details 문서 377줄이 반영됐음을 확인했다.
[공개 검증 기록](evidence/multiplatform-gallery.json)에 hash를 남겼다.

Extension Details의 README를 빠른 시작, provider 설정, 리뷰 범위·상태,
근거, 저장 결과, 대화, Memory/Skills, 중앙 자료, 자동 trigger·hook,
명령·설정·문제 해결을 포함하는 사용 문서로 복원했다. `vsce`는 개발 의존성
4.0.0으로 고정했으며 전역 설치 없이 `npm run package:platforms`를 사용한다.

## 실행 코드와 전달 파일

- GCR 고정 artifact source: `2958d916abbca7f598818e6821db64349c20d3d1`.
- CD 제품·vendor 변경: `3be0dc0ff3e243bb8e8fa7aa4fcac254d9ad7977`.
- CD VSIX 패키징 source: `3a39933b64750e89b8e5dc793bf4d0ab24cff124`.
- contract alpha.48, core alpha.49, helper 1.0.3은 기존 파일을 재사용했다.
  executors alpha.50, private CLI/service alpha.39를 새로 고정했다.
- VSIX는 `vscode-extension/test-results/packages-2.12.6/`에 있다.
  6개 파일 각각의 SHA256과 공통 package·실행 파일 hash는
  [artifact 대조 기록](evidence/multiplatform-artifact-linkage.json)에 있다.

각 VSIX의 52개 항목에 포함 파일 검사와 기본 secret 검사를 적용했다.
실행 파일 11개가 모두 실제 Linux 리뷰에 사용한 파일과 일치한다.
helper, 라이선스, 출처 문서를 포함하며 credential, vendor tarball,
test와 임시 파일은 제외했다. 기존 artifact는 덮어쓰지 않았다.
공통 package와 CLI는 private 전달물이며 공개 npm 게시를 하지 않았다.
GCR 서버 image·chart의 추가 게시나 운영 배포는 수행하지 않았다.

게시 후 source 문서의 플랫폼 안내 마지막 문장을 역사적 표현으로 고쳤다.
실행 파일은 바뀌지 않았다. 게시된 주 README는 2.12.6 안내이며, 동봉된
보조 `docs/platforms.md` 끝에는 게시 전의 2.12.5 현재 버전 문장이 남아 있다.
이 문서 수정만으로 기존 VSIX를 덮어쓰거나 다시 설치하지 않았다.

## Linux 실제 검증

사용자가 허용한 WSL2 Ubuntu 24.04.1 ARM64에서 Linux VS Code 1.137.0
Extension Host(Node 24.18.1)를 실행했다. 기존 WSL 로그인과 별도로 검증한
Codex 0.153.4 바이너리를 사용했다. 기존에 설치된 Codex alpha CLI와 전역
설정은 변경하지 않았다. Windows native 검증으로 집계하지 않는다.

[호출 전 계획](evidence/multiplatform-linux-plan.json)에 고정 source,
base·caller·테스트 문맥과 실행 파일 hash를 기록했다. 추가 실제 호출은
`gpt-5.6-luna / high` 1회, 최대 240초였다.

| 확인 | 결과 |
| --- | --- |
| 실제 리뷰 | 약 52.4초, `report.status=completed`, `problems=[]` |
| 결함 판단 | `sum.ts:2`의 뺄셈 때문에 `[2,3]`의 합계가 5 대신 -5가 됨 |
| 근거 | source·base·caller·테스트 read ID와 anchor hash 검증 통과 |
| 경계값 | 빈 배열의 결과 0은 유지됨을 응답에서 구분 |
| 저장 | 암호화 history를 다시 열어 report 전체가 같은지 확인 |
| 표시 | 실제 `showHistoryEntry` 명령 실행 |
| 종료 | Host exit 0, 소유 process·임시 profile·keyring·auth link 정리 |

모델은 테스트를 실행했다고 주장하지 않았다. fixture의 결함 재현 검사는
호출 전에 검증 실행기가 수행했으며 모델의 source 읽기와 별도 근거다.
실제 모델 응답은 [review1](evidence/multiplatform-linux-host-review1.json),
종료·정리는 [launcher](evidence/multiplatform-linux-host-review1.json.launcher.json)에 있다.

Secret Service가 없어서 승인받은 `libsecret-tools`, `gnome-keyring`과
검증용 VS Code의 누락 시스템 라이브러리를 설치했다. 별도 DBus와 암호화
keyring을 사용했고 password는 메모리·stdin으로만 전달했다. 준비 단계의
keyring 초기화 실패 3건은 모델 0회로 남겼다. 준비 검사 4번째와 최종
VSIX 설치본 Host 검사에서 정상 활성화·종료를 확인했다.

Linux Codex는 원본의 현재 사용자 소유 private `auth.json` inode에
임시 hard link를 만든다. credential을 복사하지 않으며 전역 AGENTS와
설정을 모델에 싣지 않는다. symlink·공유 권한은 거부한다.
keyring에만 저장된 Codex 계정은 지원하지 않으며 평문 export로 우회하지
않는다. extension 결과 저장용 Secret Service와 Codex 로그인은 별개다.

## 회귀 범위와 제한

[회귀 기록](evidence/multiplatform-validation.json)은 최초 실패와
재검증을 함께 보존한다.

- Windows ARM64: GCR 실행기 관련 12개 통과, 다른 OS 대상 17개 skip.
  CD 수동 리뷰 16, 설정 4, provider 6, 결과 판정 23, 자동 리뷰 17,
  hook 6, 대화 4개 통과. package 검사도 수정 후 22개 통과했다.
- trigger matrix: 15/16 통과 후 `1111`의 service 시작이 실패했다.
  같은 코드를 해당 조합만 한 번 재실행해 통과했다. 내부 native 시작
  실패 원인은 오류 응답에서 확인되지 않았으며 해결된 제품 결함으로
  기록하지 않는다. 시험 executor는 합성 응답이다.
- legacy provider fixture: Windows 3/9, Linux ARM64 container 9/9.
  Windows 실패 6개는 POSIX shebang fake 실행 파일의 가정이다.
  이를 skip하거나 전체 `npm test` 성공으로 바꾸지 않았다.
- Linux ARM64 container: 격리·process·설정 25개 통과, Mac 대상 1개 skip.
  실제 CLI의 합성 provider 검사에서 전역 지침 canary와 금지 도구가
  유입되지 않았다. Linux x64는 ARM64 PC의 Docker 에뮬레이션에서 같은
  CLI 도구 검사를 통과했다. 실제 x64 하드웨어 검증과 구분한다.
- Windows ARM64의 기존 W01–W04 native 근거와 macOS ARM64의 W04
  회귀 근거는 해당 범위에서 재사용한다. 이번 macOS VSIX Host, Intel Mac,
  Windows x64, WSL 밖 Linux desktop과 Linux service 경유 실제 모델
  호출은 검증하지 않았다.

## 설치·사용 상태

Windows 기본 extension 저장소에 2.12.6을 설치하고 실행 파일 11개를
대조했다. 이미 열린 사용자 Host의 적용 버전은 미확인이다. VS Code와
사용자 updater를 강제 종료·재로드하지 않았다. 운영 service도 교체하지
않았다. Linux는 별도 QA 설치 및 Host로 검증했으며 기존 Remote WSL
사용자 Host의 적용 상태와 다르다.

Marketplace ID 설치는 최초 version-not-found 후 한 번 재시도해 통과했다.
공개 설치본의 실행 파일 11개를 대조하고 Linux Host 활성화·종료를 다시
확인했다. 추가 모델 호출은 0회이며 Linux 시험 설치본과 `/tmp`의 임시
도구를 정리했다. Windows 쪽 공개 도구 다운로드 cache는 남겨 두었다. 계획했던 120초 대기보다 일찍 설치만 재시도한 사실도
정리 기록에 남겼다.

Marketplace에서 OS/CPU에 맞는 package를 설치하고 기존 작업이 끝난 후
필요할 때 직접 창을 다시 로드한다. Linux에서는 Secret Service를 사용할
수 있는 사용자 세션과 지원되는 CLI의 기존 로그인을 준비한다.
`Select Account Provider and Model`을 설정하고 작은 변경에
`Analyze Staged Files`를 실행한다. 자동 리뷰는 별도 opt-in이다.
서버 연결이나 중앙 자료의 새 수집 없이 로컬 리뷰를 사용할 수 있다.

## 수동 정리

다음 4개 경로의 삭제는 자동 승인 검토가 차단했다. 처음 두 곳은 이전
2.12.5 검증에서 남았고, 나머지는 이번 trigger 시작 실패의 시험 자원이다.
차단된 삭제는 다른 도구나 명령 변형으로 재시도하지 않았다.

- `C:\Users\pydemia\git\commit-defender\vscode-extension\test-results\publish-2.12.5`
- `C:\Users\pydemia\git\commit-defender\vscode-extension\test-results\marketplace-2.12.5`
- `C:\Users\pydemia\AppData\Local\Temp\cd-source-policy-QQGHEI`
- `C:\Users\pydemia\AppData\Local\CommitDefender\local-service\profiles\trigger-matrix-acf3a964-4f1c-48cb-94b1-0cff90661dc4`

마지막 profile은 합성 in-memory key를 사용한 암호화 시험 데이터다.
실행 중인 service나 운영 credential은 아니다. 그 밖의 정리·기존 설정
hash 확인은 `evidence/multiplatform-preservation.json`에 기록한다.
