# Commit Defender 로컬 검증과 CLI 게시 절차

작성일: 2026-09-11  
상태: 향후 client 개발·릴리스의 필수 절차. 이번 문서 작성에서 extension build·실행 테스트·인증·publish는 수행하지 않음.  
관련 문서: [Commit Defender 재사용](./commit-defender-integration-assessment.md), [중앙 연결·sync](./client-review-knowledge-sync-design.md), [client 인증](./client-authentication-design.md)

## 게시 조건

**Extension을 변경한 작업자는 로컬 VS Code를 직접 실행해 결과를 확인한 뒤 CLI에서 publisher 인증·권한 확인을 마치고 게시한다.** 자동 테스트 성공·bundle 생성·VSIX 생성만으로 publish하지 않는다. 개발 작업을 수행하는 agent도 테스트를 사용자에게 떠넘기지 않고 직접 VS Code 화면·명령·설정·리뷰 결과를 확인한다. 사용자 비밀번호 입력·MFA처럼 본인 확인이 필요한 단계만 사용자에게 요청한다.

필수 순서는 다음과 같다.

```text
소스·version·지원 범위 확정
  → build·자동 테스트
  → 로컬 Extension Development Host 실동작 확인
  → 최종 VSIX package·내용/secret 검사·SHA-256 기록
  → 격리된 로컬 VS Code에 그 VSIX 설치·실동작 재검증
  → CLI 로그인·publisher 게시 권한 확인
  → 검증한 동일 VSIX를 CLI로 publish
  → Marketplace 버전 확인·새 환경 설치·smoke test
```

각 단계 실패·미완료는 다음 단계 진입을 막는다. GUI를 실행할 수 없거나 실제 모델 경로가 준비되지 않았다면 해당 검증을 미완료로 남기고 게시하지 않는다. CI는 이 로컬 검증을 보완하며 대체하지 않는다. Extension publish와 GCR 서버 배포는 별도 결과로 기록한다.

## 준비와 build

개발 대상은 Commit Defender repository의 `vscode-extension`이다. 기존 미커밋 작업을 보존하고 사용할 기준 revision을 확인한다. 현재 로컬 manifest의 ID는 `pydemia.commit-defender`지만 게시 직전에는 해당 checkout·VSIX manifest·Marketplace의 publisher/name을 다시 대조한다. 새 publisher·제품 ID·공개 채널을 임의 생성하지 않는다.

`@vscode/vsce`, Extension Host 테스트 runner, build 도구를 개발 dependency·lockfile에 고정한다. 현재 CD의 `build`는 typecheck·extension bundle·hook bundle을 수행한다. 여기에 공통 core의 회귀 테스트와 `@vscode/test-cli`/`@vscode/test-electron` 기반 실제 Extension Host 통합 테스트를 연결할 계획이다. 기존 fake CLI 테스트는 유지하되 실제 모델·VS Code 화면 검증과 구분한다. [VS Code extension 테스트](https://code.visualstudio.com/api/working-with-extensions/testing-extension)

Extension 개발 workspace의 `.vscode/launch.json`에 `extensionHost` debug 설정과 build 선행 task를 제공한다. 개발 호스트의 `--extensionDevelopmentPath`는 실제 extension root를 가리키도록 한다. 테스트 root가 별도 runner 폴더일 때 경로를 혼동하지 않는다. Dev Host에서 동작해도 package 파일 누락을 발견하지 못할 수 있으므로 최종 VSIX 설치 검증을 생략하지 않는다.

최신 stable과 `engines.vscode`의 최소 지원 버전에서 자동 통합 테스트를 실행한다. 설치된 로컬 VS Code에서는 GUI 실동작을 직접 검증한다. macOS에서만 확인한 결과로 Windows/Linux·SSH/WSL 지원까지 검증했다고 표시하지 않는다. 게시 manifest에서 지원한다고 명시한 runtime·platform은 추가 검증하거나 공개 전에 지원 범위를 축소한다.

## 로컬 VS Code 직접 검증

일상 작업 창과 분리한 user-data·extensions 디렉터리, 테스트 repository, 테스트 GCR 사용자·tenant를 사용한다. 계정 broker/OS credential도 테스트 profile에 격리해 실제 사용자의 token·설정을 교체하지 않는다. Git hook 시험은 임시 repository와 로컬 bare remote에서 수행해 실제 작업 branch를 commit/push하지 않는다.

최종 VSIX 설치·실행은 다음 형태로 수행한다. 변수는 작업자가 생성한 전용 QA 경로와 검증 대상 VSIX를 가리킨다. 자동 업데이트·Settings Sync는 QA 환경에서 꺼 설치한 빌드가 다른 버전으로 바뀌지 않도록 한다.

```sh
code --user-data-dir "$QA_USER_DATA" --extensions-dir "$QA_EXTENSIONS" --install-extension "$VSIX_PATH"
code --user-data-dir "$QA_USER_DATA" --extensions-dir "$QA_EXTENSIONS" --list-extensions --show-versions
code --user-data-dir "$QA_USER_DATA" --extensions-dir "$QA_EXTENSIONS" --new-window "$QA_WORKSPACE"
```

`code`가 PATH에 없으면 macOS의 `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`를 사용한다. CLI 설치 성공 외에 화면에서 실제 활성 버전·activation·명령 실행을 확인한다. [VS Code CLI의 격리 디렉터리·설치 옵션](https://code.visualstudio.com/docs/configure/command-line)

매 릴리스의 변경 기능과 아래 baseline을 직접 확인한다.

| 시나리오               | 통과 조건                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 설치·업데이트·재시작   | 신규 설치와 기존 사용자 업그레이드에서 activation 성공, 기존 설정·local memory/Skill 보존, reload 후 정상 동작                    |
| Standalone             | 중앙 로그인 없이 실제 AI 리뷰 완료, Summary·findings·근거 표시, local memory/Skill 저장·재조회                                    |
| Centralized            | 서버 URL 설정, 실제 Keycloak SAML 브라우저 로그인 후 GCR client 승인 또는 API key 연결, 정책·집단/개인 메모리 sync                |
| 권한·계정 전환         | 테스트 사용자 간 개인 메모리 격리, repo 접근 거부, token 폐기·만료, 서버 변경 시 기존 credential 비전송                           |
| Save·Stage·Commit·Push | 각각 on/off 확인, 모두 off일 때 자동 LLM 요청 없음, partial stage·dedup·취소·stale·예산·hook 대기 동작                            |
| Review chat            | 관련 코드·base·리뷰 결과를 이용한 질문, 추가 정보 요청·응답 후 재개, Enter 전송·Shift+Enter 줄바꿈                                |
| 실패·오프라인          | 모델 오류·한도·timeout이 성공으로 표시되지 않음, 중앙 장애 시 유효 cache/local fallback, 401/403을 단순 offline으로 취급하지 않음 |
| 화면·진단              | 분석 중·완료·실패 화면과 실제 finding 위치 확인, Output/Extension Host 로그에서 crash·누락 asset·비밀 노출 없음                   |

아직 출시 범위가 아닌 기능은 명시적으로 미구현으로 표시하고 활성 기능처럼 노출하지 않는다. Centralized 기능을 출시하면서 해당 시나리오를 미구현으로 제외할 수는 없다. 실제 모델 호출은 허용된 테스트 코드·계정·예산으로 수행하며 fixture 결과를 AI 분석 완료 화면으로 제시하지 않는다.

검증 증거에는 source revision, dependency lock hash, extension/VS Code/OS 버전, VSIX SHA-256, 시나리오별 결과, 실제 화면 캡처·비밀을 제거한 로그를 남긴다. 캡처는 공유 가능한 테스트 데이터로 만들고 릴리스 보고에 첨부한다. 이 기록은 게시용 VSIX에 넣지 않는다.

## 최종 artifact 고정

Version·release channel·changelog를 packaging 전에 확정한다. `vsce package`의 `vscode:prepublish` hook이 다시 build할 수 있으므로 마지막 package 이후 설치한 VSIX의 결과를 게시 기준으로 삼는다. VSIX 내부 manifest·extension/hook bundle·필수 asset·runtime dependency가 모두 포함됐는지 확인한다.

`.env`, `.commit-defender/hook.json`, 로그인 cache, 개인/중앙 메모리, 소스 snapshot, QA profile, 로그, secret이 VSIX에 들어가면 차단한다. Secret 검사를 우회하는 publish/package 옵션은 사용하지 않는다. 테스트 후 소스·version·bundle·VSIX가 바뀌면 새 artifact로 관련 검증을 다시 수행한다.

게시에는 `vsce publish --packagePath "$VSIX_PATH"`를 사용해 검증한 파일을 올린다. 게시 직전 SHA-256을 대조하고 소스 디렉터리에서 재빌드하는 publish나 `publish patch/minor/major`로 바꾸지 않는다. Commit·tag·Git push는 별도 명시 요청에 따르며 publish 명령의 부수 효과로 임의 생성하지 않는다.

## CLI 인증과 publish

Marketplace publisher 인증은 Keycloak/GCR 로그인, GitHub 인증, 모델 제공자 인증과 별개다. Publisher credential은 extension·client 설정·VSIX에 포함하지 않는다. 게시 절차는 CLI에서 시작·완료하며 Marketplace 관리 페이지의 수동 VSIX 업로드로 대체하지 않는다. 최초 publisher 권한 부여나 브라우저 MFA는 필요할 수 있다.

아래 `vsce`는 release 작업에서 버전을 고정한 CLI를 뜻한다. 인증 전에 publisher, 게시 계정, tenant, VSIX의 이름·version·채널과 권한을 확인한다. Azure에 로그인돼 있다는 이유만으로 publisher 게시 권한이 있다고 판단하지 않는다.

Entra ID 기반 CLI 인증을 우선 경로로 검토한다. 해당 identity가 publisher에 등록되어 있어야 하며, 기존 다른 계정의 environment credential 등이 CLI 계정보다 우선 선택되지 않도록 release 환경을 분리한다. 실제 계정의 publisher 권한 검증이 실패하면 게시하지 않는다.

```sh
az login --tenant "$PUBLISHER_TENANT_ID" --allow-no-subscriptions
vsce verify-pat "$PUBLISHER" --azure-credential
vsce publish --packagePath "$VSIX_PATH" --azure-credential
```

`verify-pat`는 CLI 이름과 달리 `--azure-credential`로 Azure identity도 검사한다. 다만 설치된 `vsce 3.9.1`의 구현은 publisher 역할 조회를 사용해 Reader도 통과할 수 있다. 성공 메시지만으로 게시 권한을 확정하지 않고 현재 principal에 Owner/Contributor 등 해당 extension의 게시를 허용하는 역할과 필요한 scope가 있는지 별도로 확인한 뒤 위 publish 단계를 실행한다. 로그인은 CLI가 시작한 공식 브라우저/MFA 흐름을 사용하고 token 원문을 추출·출력하지 않는다. [Azure CLI 로그인](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli), [vsce 검증 구현](https://github.com/microsoft/vscode-vsce/blob/main/src/store.ts)

현재 publisher가 PAT를 사용하는 경우에는 지원 여부·만료를 확인한 뒤 아래 CLI 로그인 경로를 사용할 수 있다. 필요한 Marketplace Manage scope와 publisher 권한만 사용하며 PAT는 터미널의 비밀 입력으로 전달한다. CLI/OS의 승인된 credential 저장소를 사용하고 원문 파일 fallback을 조용히 허용하지 않는다. `--pat <원문>`·명령 이력·일반 환경 덤프·대화에 secret을 남기지 않는다.

```sh
vsce login "$PUBLISHER"
vsce verify-pat "$PUBLISHER"
vsce publish --packagePath "$VSIX_PATH"
```

Microsoft 공식 안내에 따르면 Azure DevOps의 global PAT는 2026-12-01에 종료될 예정이므로 PAT 전용 배포에 고정하지 않는다. 실제 publish 시점의 지원 인증 방식을 재확인한다. Entra publisher 연결이 필요하더라도 앱 로그인 설계가 바뀌거나 Azure 유료 자원을 자동 생성하는 것은 아니다. [Marketplace 게시·인증 안내](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

인증·권한 확인과 publish는 test 통과 뒤 순차 실행한다. MFA·만료·권한 부족은 상태를 보고하고 필요한 본인 확인을 요청한다. 다른 publisher로 바꾸거나 credential을 찾아 무단 재사용하지 않는다. 이 문서 작성만으로 지금 계정 로그인·VSIX 업로드를 수행하지 않는다.

## 게시 후 확인과 복구

CLI 성공 메시지에 이어 Marketplace의 정확한 publisher/name/version/channel이 공개됐는지 확인한다. 별도의 깨끗한 VS Code QA 환경에서 Marketplace로부터 해당 version을 설치하고 activation·설정·리뷰 smoke test를 다시 수행한다. 게시 요청 성공, 공개 반영, 실제 설치 검증을 구분해 보고한다.

게시 응답이 유실되면 version 조회로 상태를 먼저 확인하고 무조건 재게시·version 증가하지 않는다. 같은 version의 중복을 성공으로 숨기는 옵션도 쓰지 않는다. 문제가 발견되면 배포 확대를 멈추고 새 patch version에 수정 또는 이전 정상 코드를 담아 동일 검증 절차를 반복한다. Marketplace에서 기존 version을 덮어쓰거나 최신 version을 임의 삭제하는 방식으로 복구하지 않는다.

최종 보고에는 Marketplace 링크·게시 version, source revision·VSIX hash, 로컬/게시 후 검증 결과, 실제 화면 캡처, 미지원 환경을 남긴다. QA 로그인·테스트 hook·임시 profile은 확인된 작업 소유 범위만 정리하고 사용자의 원래 VS Code 창·설정·credential은 변경하지 않는다.

## 이번에 확인한 환경

2026-09-11 기준 이 Mac에는 VS Code `1.135.0` arm64, `vsce 3.9.1`, Azure CLI 실행 파일이 있다. VS Code CLI는 app bundle 안에 있으며 `code` 명령은 현재 PATH에서 발견되지 않았다. `vsce`의 `--packagePath`, `--azure-credential`, `login`, `verify-pat` 옵션은 help로 확인했다. Publisher 인증 상태·권한·현재 Marketplace version은 조회하지 않았으며 GUI 테스트나 게시를 수행한 상태도 아니다.

후속 요청으로 실시한 실제 접속·인증 사전 점검은 [2026-09-11 결과](./client-publish-preflight-2026-09-11.md)에 별도 기록했다. Marketplace 조회는 성공했지만 PAT의 로컬 credential 조회 정지와 Azure refresh token 만료로 인증 검증은 완료되지 않았다. 초기 환경 확인과 실제 게시 성공을 구분한다.
