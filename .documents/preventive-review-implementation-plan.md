# 사전 예방형 리뷰 플랫폼 구현 계획

작성일: 2026-09-12

상태: 구현 진행 중. 이 문서는 phase·commit·검증·릴리스 단위를 정의한다. 아래 계획표 자체는 완료 증거가 아니며 실제 변경과 검증은 [P00 실행 기록](./execution/preventive-review/P00.md)과 [P01 실행 기록](./execution/preventive-review/P01.md)에 남긴다. 2026-09-12 사용자의 전체 개발·배포 goal 요청에 따라 현재 세션에서 phase checkpoint를 순차 진행한다.

## 1. 범위와 설계 기준

Git Code Reviewer(GCR)에 축적한 리뷰 판단을 Commit Defender(CD)의 개발 중 리뷰에 연결한다. 기존 CD를 확장하며 별도 VS Code 제품을 만들지 않는다. Standalone에서도 실제 리뷰와 로컬 메모리·Skill 관리를 제공하고, centralized에서는 승인된 중앙 자료를 동기화한다.

| 기준 문서                                                     | 이 계획에 적용하는 내용                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [플랫폼 기획](./preventive-review-platform-plan.md)           | 리뷰 목적, 네 trigger, 공통 core·CLI·MCP, 근거 수준, 초기 출시와 후속 범위 |
| [CD 재사용 검토](./commit-defender-integration-assessment.md) | 기존 결함 보완, backend 분리, 계정 CLI adapter 재사용, 저장소 간 책임      |
| [모드·지식 동기화](./client-review-knowledge-sync-design.md)  | standalone 선행 구현, 로컬 저장, bundle·manifest, offline·권한 철회        |
| [Client 인증](./client-authentication-design.md)              | GCR 발급 key·PKCE·device grant, bearer scope, broker·폐기                  |
| [Keycloak SAML·DB 배포](./keycloak-saml-deployment-design.md) | 웹 로그인, 사용자 이력 유지, 공유 PostgreSQL의 DB·role 분리, 복구          |
| [Extension 릴리스](./client-extension-release-plan.md)        | 실제 로컬 VS Code 검증, 최종 VSIX 고정, CLI 인증·게시·설치 확인            |
| [게시 사전 점검](./client-publish-preflight-2026-09-11.md)    | 인증·쓰기 권한·업로드 미확인 사항                                          |

후속 설계가 초기 기획의 예시를 구체화한 경우 후속 설계를 따른다. `rule-manifest`의 공용/개인 개별 조회 대신 사용자별 조합 manifest를 사용한다. 웹 로그인은 Keycloak SAML, client 인가는 GCR이 담당한다. `apps/vscode`를 새로 만들지 않고 CD의 `vscode-extension`을 연결한다. 원래 플랫폼 Phase 0–2는 아래 P00–P09로 세분화한다.

### 유지할 제품 계약

- 신규 설치는 `standalone`, 중앙 모델 실행은 선택 사항이다. 기존 CD 사용자의 provider·hook 설정은 보존하며 새 중앙 연결 설정으로 자동 승계하지 않는다.
- 중앙 cache와 사용자가 작성한 local memory·Skill을 분리한다. 연결 복구나 모드 변경만으로 로컬 자료를 업로드하지 않는다.
- 적용 범위가 같은 판단에서는 집단 메모리를 우선한다. 현재 source와 반증 조건을 확인하며 과거 지적을 기계적으로 반복하거나 생략하지 않는다.
- Save·Stage·Commit·Push는 독립 선택이고 신규 자동 실행은 모두 off다. 초기 판정은 advisory이며 CLI finding 종료 코드를 hook 차단 코드로 그대로 전달하지 않는다.
- Source·base·index·지식·설정 버전을 고정한다. 미수행·부분 완료·실패·stale을 성공으로 표시하지 않는다.
- Linter·formatter·lint rule 배포, 자동 PR 승인·merge, 별도 자율 수정 agent는 개발 범위에 넣지 않는다. 제품 코드 자체의 lint·test는 계속 수행한다.

## 2. 착수 기준과 저장소 경계

2026-09-12 로컬 조회 기준이다. 실제 개발 시작 시 P00에서 다시 확인하며 아래 값을 최신 원격·운영 상태로 간주하지 않는다.

| 대상                          | 확인한 기준                                                                     | 개발 시 처리                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| GCR                           | `feat/browser-review-service`, `6d86752`, 문서 작성 전 작업 트리 clean          | 이 문서 커밋을 포함한 실제 시작 SHA를 실행 기록에 고정                                            |
| CD 로컬                       | `main`, `1420304`, extension `2.0.3`                                            | untracked `AGENTS.md`와 `llm-templates/packages/phoenix`의 기존 변경 보존                         |
| CD의 로컬 remote-tracking ref | `origin/main=47dabfea718729b0ccc685ae173857476040d6ea`, extension `2.3.0`       | 네트워크 fetch 후 기준 재확인. 기존 checkout을 reset하지 않고 필요하면 별도 worktree에서 개발     |
| GCR runtime                   | Node `>=22`, private pnpm workspace packages                                    | 서버 package를 그대로 extension runtime dependency로 넣지 않음                                    |
| CD 검토 기준                  | Node `>=18`, VS Code `^1.90.0`, Node 18 bundle target                           | 최소 runtime·VS Code 지원 조합을 P00에서 검증하고 manifest와 실제 지원 범위를 일치시킴            |
| 기존 인증·메모리              | `AUTH_MODE=development/local/oidc/proxy`, 개인/집단 메모리와 Skill version 구현 | SAML·client bearer·배포 manifest는 신규 구현. 기존 메모리 상태와 새 rule 상태를 구분              |
| DB migration                  | 로컬 파일은 `0031_registry_deletion.sql`까지 존재                               | 새 번호는 해당 commit 시점에 배정. 이 계획에서 번호를 예약하지 않음                               |
| 게시 경로                     | 9월 11일 조회·TLS 성공, 게시 인증·업로드 미완료                                 | P00에서 막힌 조건을 확인하고 P09에서 실제 게시 검증. 과거 조회 성공을 쓰기 권한으로 해석하지 않음 |

### 코드 소유권과 배포 계약

| 저장소 | 위치                                                                 | 책임                                                                                |
| ------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| GCR    | 기존 `apps/runtime`, `apps/web`, `packages/db`, `packages/contracts` | 중앙 정책·인가·발행·API·관리 화면                                                   |
| GCR    | 신규 `packages/client-contract`                                      | 서버와 client가 공유하는 순수 schema·상태·호환성 계약                               |
| GCR    | 신규 `packages/client-core`                                          | snapshot·local store·sync·scheduler·대화·결과 처리. VS Code·서버 DB 의존 금지       |
| GCR    | 신규 `packages/client-executors`                                     | 기존 CD adapter에서 재사용할 공통 실행 코드와 executor port 구현. 출처·license 보존 |
| GCR    | 신규 `apps/cli`, `apps/mcp`, `skills/gcr-prevention`                 | headless 서비스·CLI·stdio MCP·agent 활용 절차                                       |
| GCR    | 신규 `deploy/helm/gcr-identity`, `compose.identity.yaml`             | Keycloak companion·공유 DB provisioning·SAML 통합 환경                              |
| CD     | 기존 `vscode-extension/src`                                          | VS Code UI·설정·이벤트·hook 설치 adapter·제품 packaging                             |

신규 경로는 이 계획의 구현 위치다. 기존 `review-contract`의 모든 서버용 dependency를 client에 끌어오지 않고 필요한 순수 계약을 추출·재노출한다. Package 이름·export·최소 runtime은 P00-C02에서 확정한다.

공통 패키지는 GCR이 소유하고 CD는 고정 버전의 배포 artifact를 소비한다. 개발 검증에는 `pack`한 tarball과 hash를 사용한다. 실제 배포용 package/artifact 저장 위치와 설치 명령은 P00-C02의 필수 결정이며, 외부 package 공개나 새 registry 생성이 이미 승인됐다고 가정하지 않는다. 깨끗한 환경에서 두 저장소를 각각 build할 수 있어야 한다. 사용자 PC의 절대 경로, mutable branch URL, sibling repository의 `src` 직접 import를 release dependency로 남기지 않는다.

Executor 구현의 최종 원본은 `client-executors` 한 곳에 둔다. CD의 계정 설정·로그인 UI는 유지하고 실행 adapter만 순차 전환한다. Core는 executor port에 의존하고 CLI·CD가 executor를 조립한다. GCR 공통 package가 CD extension을 다시 import하는 순환 의존은 만들지 않는다.

## 3. Goal과 commit 운영

### Goal의 단위

기본은 **phase 하나당 goal 하나**다. 아래 각 phase의 목표·commit 목록·완료 조건을 goal의 범위로 사용한다. 한 번에 전체 제품의 개발·운영 전환·Marketplace 게시를 하나의 완료 조건으로 묶지 않는다. 인증처럼 작업이 큰 phase는 같은 ID를 유지한 채 연속된 commit 범위와 그 범위의 검증으로 goal을 나눌 수 있다.

개발을 시작할 때 사용할 요청 형식:

```text
.documents/preventive-review-implementation-plan.md의 P00을 goal로 진행해 줘.
P00의 필수 commit과 완료 조건을 달성하고 실행 기록을 남겨 줘.
선행 조건과 현재 저장소 상태를 먼저 확인하고 기존 변경은 보존해 줘.
구현·검증·commit·push 및 적용되는 배포 절차까지 처리하되,
다음 phase는 이 goal에 포함하지 마.
```

다음 phase는 ID만 바꾸어 진행한다. 일부 commit만 맡길 때는 `P04-C01–C03`처럼 범위를 지정한다. 이 경우 해당 범위의 완료와 P04 전체 완료를 구분한다. 명시적인 요청이 없으면 token budget·모델·추가 agent 수를 임의로 정하지 않는다.

Goal 착수 시 현재 goal 상태와 선행 phase의 증거를 확인한다. 이미 활성 goal이 있으면 목적을 임의로 덮어쓰지 않는다. 필요한 구현·검증·전달이 남아 있으면 완료 처리하지 않는다. 외부 입력이 필요한 동안에는 독립적인 작업을 계속하고 차단 원인·재개 조건을 기록한다. Goal의 `blocked` 전환은 도구의 실제 조건을 따르며 계획서의 `waiting-input` 상태와 동일시하지 않는다.

### Commit 작성·전달 규칙

- 아래 ID는 작업 식별자이며 SHA가 아니다. 각 행은 관련 구현·회귀 테스트·필요한 migration을 포함한 검토 가능한 commit을 뜻한다. 테스트를 전부 마지막 commit으로 미루지 않는다.
- 같은 phase 안에서는 표 순서대로 진행한다. 별도 의존성이 적힌 행은 해당 commit의 검증까지 선행한다. 같은 ID를 나눌 때는 `-a`, `-b`를 붙이고 실제 SHA를 기록한다. 구현 도중 명칭을 바꾸면 전체 의존 표도 갱신한다.
- GCR과 CD의 변경을 하나의 commit으로 표현하지 않는다. GCR 계약/artifact 확정 → CD dependency pin·adapter 전환 → 양쪽 통합 검증 순서를 지킨다.
- DB는 additive migration을 우선하고 구버전 Server/Worker와 호환 기간을 둔다. 데이터 변환·권한 전환·폐기는 별도 검증한다. DB schema를 되돌리지 못하는 변경에 image downgrade만을 rollback으로 제시하지 않는다.
- `client-auth/config`와 UI capability에는 구현·검증한 기능만 게시한다. 중간 commit의 미완성 기능은 비활성 상태로 배포 가능해야 한다.
- 기능·설정 변경은 기존 [handoff의 전달 기준](./handoff.md)에 따라 commit·push 후 PRISM-DEV 배포·검증까지 포함한다. 연속 commit은 검증된 phase checkpoint에서 전달하고, 중간 전달이 필요하면 미완성 기능을 비활성화한 호환 빌드만 사용한다. SAML 운영 전환은 P03/P04의 관련 gate를 통과한 뒤 수행한다.
- CD의 source commit·push와 Marketplace publish는 구분한다. 최초 통합 제품의 게시 checkpoint는 P09다. 이전 phase에서 중간 extension 릴리스를 요청받으면 동일한 로컬 VS Code·VSIX·CLI 게시 절차를 적용하고 미구현 기능을 공개 지원으로 표시하지 않는다.
- 문서만 바뀐 commit은 실행 image를 새로 배포하지 않는다. Goal에 포함된 배포·게시가 미완료면 구현 완료와 구분해 보고한다.

### 실행 기록

각 phase 시작 시 `.documents/execution/preventive-review/Pxx.md`를 만든다. CD의 대응 검증 기록은 해당 저장소에 두고 GCR 기록에 CD SHA·artifact hash와 참조를 남긴다. 계획표의 상태는 기본 `planned`다.

```text
Phase / goal 목표 / 시작 시각
GCR·CD 작업 경로, branch, 시작 SHA, 보존할 기존 변경
선행 phase와 검증 증거 / 확정한 결정 / 이번 범위
Commit ID | 저장소 | SHA | 구현 상태 | 검증 상태 | push 상태
Test: 명령·환경·결과·실행/skip 구분·증거 경로
실제 모델: executor·모델·허용 source 범위·호출/예산·결과 ID
Delivery: source SHA·package/image/chart/VSIX version·digest·배포/게시 상태
미완료·waiting-input·실패 사유 / 다음 commit / 재개 조건
Phase 완료 조건별 근거 / goal 종료 결과
```

새로 실행하지 않은 과거 테스트·운영 상태를 이번 결과로 복사하지 않는다. 증거에는 token·SAML 원문·개인 메모리·실제 비공개 source를 넣지 않는다. 최종 보고는 실제 변경·검증·SHA·전달 결과와 미완료 사항으로 끝낸다.

## 4. Phase 순서

| Phase | Goal에서 달성할 결과                              | 선행 조건                      | 출시 범위             |
| ----- | ------------------------------------------------- | ------------------------------ | --------------------- |
| P00   | 기준 revision·runtime·배포 계약·평가 fixture 확정 | 없음                           | 초기                  |
| P01   | CD의 source 수집·snapshot·실패·표시 안전성 보완   | P00                            | 초기                  |
| P02   | standalone core·로컬 자료·수동 실제 리뷰          | P01                            | 초기                  |
| P03   | SAML 웹 로그인·사용자 이력·공유 DB 배포 기반      | P00; 기본 실행은 P02 뒤        | 초기                  |
| P04   | GCR client key·PKCE·device·credential broker      | P02, P03                       | 초기                  |
| P05   | 중앙 리뷰 기준 승인·불변 bundle 발행·인가 API     | P04                            | 초기                  |
| P06   | CD 중앙 연결·원자적 sync·offline·권한 철회        | P02, P04, P05                  | 초기                  |
| P07   | Save·Stage·Commit·Push의 공통 자동 리뷰           | P06                            | 초기                  |
| P08   | 리뷰 대화·MCP·Skill·명시적 feedback 순환          | P07                            | 초기                  |
| P09   | 두 환경 E2E·운영 rollout·검증한 VSIX 게시         | P00–P08 완료                   | 초기 출시 완료        |
| P10   | 선택적 중앙 모델 proxy                            | P09                            | 후속 선택 기능        |
| P11   | 격리 runner·재현 근거·선택적 critic               | P09                            | 후속, 원 기획 Phase 3 |
| P12   | Thread·수정·예외·증분 이력 기반 지속 학습         | P09                            | 후속, 원 기획 Phase 4 |
| P13   | 중앙 PR 기준 통일·trusted evidence·성과 운영      | P09, P12; 실행 근거 경로는 P11 | 후속, 원 기획 Phase 5 |

기본 실행은 P00→P09의 순차 진행이다. P03을 P02와 독립적으로 진행할 수 있는 구조이지만 이 계획 자체가 병렬 agent 실행을 요청하는 것은 아니다. P10·P11·P12는 서로 완료를 기다리지 않아도 되며 후속 목표를 선택해 시작한다.

## 5. 초기 출시 구현

### P00. 기준·호환성·평가 입력 확정

**Goal 목표:** GCR과 CD의 보존할 변경, 개발 기준, package 전달 경로, 첫 executor와 평가 입력을 확정해 이후 commit을 재현 가능하게 시작한다.

| Commit ID | 저장소·제안 메시지                                                        | 변경 범위                                                                                                                                                                          | Commit 검증                                                                                                                                           |
| --------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| P00-C01   | GCR · `docs: record preventive review development baseline`               | 두 저장소 SHA·branch·dirty 상태, 기존 기능, 실제 개발 worktree를 기록. 설계의 구현/미구현 표와 migration 현황 대조                                                                 | 기존 CD 변경 보존 확인. Remote URL·설정 출력에서 credential 제거                                                                                      |
| P00-C02   | GCR · `build: define versioned client package delivery`                   | `client-contract/core/executors` package skeleton·최소 export·dependency 경계, tarball 제작·검증 경로, CD 소비 방식, headless 설치 artifact 결정. Node·VS Code 최소 지원 조합 고정 | 깨끗한 temp consumer에서 package build/import. VS Code·DB·서버 secret dependency가 순수 계약으로 유입되지 않음. 실제 배포 위치와 명령이 기록돼야 완료 |
| P00-C03   | GCR · `test: add preventive review evaluation fixtures`                   | Python·TypeScript와 두 언어 간 API 계약 표본. 결함·수정·정상·반증 사례, partial stage·삭제·rename·worktree·다중 ref fixture. 기존 PR #953 주제는 source 확인 후 익명화해 채택      | Git tree·expected outcome·필요 근거 고정. 모의 결과와 실제 AI 평가 구분. 허위 결함 수·성능 목표 생성 금지                                             |
| P00-C04   | CD · `test: establish extension and executor baseline`                    | 기준 버전의 clean install·build·provider test, Extension Host runner·debug task 준비. 첫 로컬 계정 executor의 실제 호출·취소·읽기 범위 PoC                                         | 지원 runtime과 최소/현재 stable VS Code 조합 기록. 실제 호출 가능한 경로·허용 테스트 source·예산 확인. 모델 계정 자체를 새로 구매하지 않음            |
| P00-C05   | GCR · `docs: finalize implementation decisions and release prerequisites` | package 경로, executor, 설정 namespace, pilot repository·두 환경, SAML PoC 후보, GUI·publisher 인증 장애와 담당 단계를 결정 기록으로 묶음                                          | P02 시작에 필요한 runtime·package·executor 결정은 미정으로 남기지 않음. DNS/TLS/SMTP·게시 권한 등 외부 조건은 해결 단계와 재개 조건 명시              |

**완료 조건:** 개발 기준과 fixture가 재현되고 GCR package를 CD에 전달할 경로 및 첫 실제 executor가 확인돼야 한다. 원격 ref 조회·빌드·가짜 provider 응답만으로 executor 검증을 대신하지 않는다. SAML 라이브러리·Keycloak image의 지원/보안 상태는 P03 PoC에서 공식 자료와 선택 버전으로 확인한다.

### P01. Commit Defender 선행 결함 보완

**Goal 목표:** 기존 CD의 민감 파일 수집, staged/working-tree 혼합, 실패의 성공 집계와 신뢰하지 않은 출력 처리를 수정한다.

| Commit ID | 저장소·제안 메시지                                                   | 변경 범위                                                                                                                                           | Commit 검증                                                                                                                      |
| --------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| P01-C01   | CD · `fix: exclude credentials and ignored files from review inputs` | `gitHelper.ts`, `excludeFilter.ts`, 전체 repository·파일·hook 수집에 공통 경로 정책 적용. `.env`, hook credential, local/central store·QA 자료 제외 | Tracked 여부와 무관한 민감 파일·ignored·symlink escape 차단. 명시적으로 포함한 일반 untracked는 수집하고 제외 사유·coverage 표시 |
| P01-C02   | CD · `fix: evaluate findings against the selected git snapshot`      | `diff.ts`, `skipMarkers.ts`, Git 조회의 index/source 일치. 삭제·rename 포함. TODO·타입 억제 marker의 포괄적 AI 리뷰 면제 제거                       | Stage 후 working tree에만 marker를 추가해도 staged finding 불변. 삭제에 따른 소비자 파손 표본 유지                               |
| P01-C03   | CD · `fix: preserve partial and failed review outcomes`              | `ai/reviewer.ts`, 결과 schema·`exitResolver.ts`의 완료/부분/실패/취소와 severity 분리. 기존 hook 정책과 신규 advisory 연결 경계 표시                | 전체 provider 실패는 error, 일부 실패는 partial. P3·모델 `blocking`·미완료 각각의 기존/신규 동작 회귀                            |
| P01-C04   | CD · `fix: constrain review rendering and repository instructions`   | `comments.ts`, formatter·webview 경로/line 검증, Markdown trust·command URI 제한. Repository Skill은 제한된 리뷰 자료로 취급                        | 악성 링크·HTML·임의 경로·Skill의 도구 권한 확대 거부. 정상 code link·finding 위치 유지                                           |
| P01-C05   | CD · `refactor: isolate review backend and execution ownership`      | UI의 직접 Reviewer 호출을 `ReviewBackend` port로 모음. Legacy 설정·계정 UI 유지, 중복 실행·최신 결과 갱신 책임 분리                                 | 같은 요청이 legacy와 새 backend에 이중 전달되지 않음. 기존 provider 설정·history 표시·취소 회귀                                  |

**완료 조건:** 검토 문서에서 재현한 수집·suppression·전체 실패 사례가 회귀 테스트로 고정되고 실제 CD 화면에서 결과 상태가 맞아야 한다. 기존 사용자의 hook·provider 설정을 초기화하지 않는다.

### P02. Standalone 공통 core와 수동 리뷰

**Goal 목표:** 중앙 서버 없이 로컬 메모리·Skill을 저장·관리하고 고정된 Git snapshot으로 실제 리뷰를 수행한다. 같은 core를 extension과 headless CLI가 사용한다.

| Commit ID | 저장소·제안 메시지                                                  | 변경 범위                                                                                                                                                                      | Commit 검증                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P02-C01   | GCR · `feat: define local review and knowledge contracts`           | `client-contract`: mode, repository identity, source/context hash, run 상태, evidence·severity·enforcement, legacy report projection                                           | 기존 `verified`는 anchor 검증으로 보존하고 근거 미평가 표시. 계약 fixture를 CD projection에서도 소비                                                                                      |
| P02-C02   | GCR · `feat: add persistent local knowledge stores`                 | `LocalKnowledgeStore`, profile·repo key, memory CRUD/활성화/보관/가져오기·내보내기, Skill 본문·범위·version/hash, review/chat retention                                        | 재시작 복원, 동명 repo·worktree·profile 격리, 쓰기 충돌·디스크 실패. 개인 자료 암호화·OS key store·Skill 파일 권한. Key store 부재 시 평문 fallback 금지                                  |
| P02-C03   | GCR · `feat: capture immutable local source snapshots`              | 저장된 working tree·index·base SHA snapshot, 고정 view의 관련 source 조회. 기존 `git-engine`의 안전한 읽기 로직 추출                                                           | Partial stage·초기 commit·삭제·rename·binary·LFS/submodule 제한·missing object 표시. 사용자 index/checkout 변경 없음                                                                      |
| P02-C04   | GCR · `feat: resolve local review context and execution policy`     | `ModeResolver`, local 지식 index·필수 context 선택, source 전송 정책·예산, 미수행/needs-context 처리. Centralized 미지원 상태 계약                                             | 중앙 설정이 남아 있어도 standalone에서 중앙 요청 0. 필수 근거 부족은 incomplete. 무승인 provider 전환·Skill 실행 거부                                                                     |
| P02-C05   | GCR · `feat: reuse account executors for standalone reviews`        | CD의 검증된 계정 CLI 실행 코드를 `client-executors`로 이동·정리하고 attribution 보존. 고정 source view와 제한된 읽기 port에 연결                                               | 선택 executor의 실제 모델 리뷰·cancel·timeout·하위 프로세스 정리. 원래 mutable cwd를 읽어 snapshot 밖 source를 섞지 않음. 지원 불가 경로는 capability off                                 |
| P02-C06   | GCR · `feat: expose standalone review and knowledge commands`       | `apps/cli`: status/context/review/result 및 local memory/Skill 명령. 종료 코드 0/1/2, JSON report, 재시작 후 이력                                                              | Extension 없이 설치 artifact로 실제 리뷰. CLI 오류·질문·finding 구분, 모델 없음은 실행 미완료. 임시 tarball 외 sibling src 의존 없음                                                      |
| P02-C07   | CD · `feat: connect standalone review core and local knowledge UI`  | 고정 package 소비, `ReviewBackend` 연결, Local Memory/Skills 관리, source·evidence·최신성 표시. 기존 provider 로그인 UI adapter 유지                                           | 신규 설치 중앙 요청 0, 기존 설정 migration, 두 process에서 자료 공유, 재시작·실제 finding 이동·삭제/비활성화 반영                                                                         |
| P02-C08   | CD · `fix: remove model secrets from repository hook configuration` | P02-C02의 OS credential adapter를 모델 credential용 별도 namespace로 연결. 기존 settings/hook 원문은 명시적 migration으로 전환하고 신규 hook config에는 credential 참조만 저장 | 새/기존 설치·extension 종료 후 hook에서 같은 모델 credential 사용, key store 실패·migration 중단 복구. 확인 전 기존 credential을 삭제하지 않으며 secret이 source/VSIX/log에 포함되지 않음 |

**완료 조건:** 중앙 미설치·미로그인 상태에서 CD와 CLI의 실제 리뷰, memory·Skill CRUD 및 재시작 복원이 동작한다. Python·TypeScript의 결함/수정/정상 표본에 대해 실제 읽은 base·source와 결과를 기록한다. 전체 언어의 동일 정밀도를 주장하지 않는다. P02가 끝나도 중앙 연결·네 trigger·MCP 전체가 완료된 것은 아니다.

### P03. Keycloak SAML과 공유 PostgreSQL

**Goal 목표:** Keycloak SAML로 GCR 웹에 로그인하고 기존 사용자 ID·권한·메모리를 유지한다. Keycloak과 GCR을 하나의 PostgreSQL 자원에 서로 다른 DB·role로 연결한다.

| Commit ID | 저장소·제안 메시지                                                 | 변경 범위                                                                                                                         | Commit 검증                                                                                                                                                                |
| --------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P03-C01   | GCR · `test: validate keycloak saml integration contract`          | 격리된 PoC의 SAML SP library·Keycloak image/version/digest, persistent NameID·binding·metadata·key rotation 계약 고정             | 실제 HTTPS 로그인/로그아웃, POST cookie, 이메일 변경 후 identity 유지. XML 검증을 직접 구현하지 않고 서명·issuer·audience·recipient·만료·wrapping·replay 악성 fixture 거부 |
| P03-C02   | GCR · `feat: persist saml transactions and identity mappings`      | `user_identities`, AuthnRequest/Response/Assertion 일회성 소비, SessionIndex·freshness·관리 operation/outbox의 additive migration | 두 replica 동시 소비 중 하나만 성공. 이메일 자동 연결·OIDC subject 덮어쓰기 없음. 기존 ID·repo grant·개인 owner fixture 보존                                               |
| P03-C03   | GCR · `feat: add saml web authentication and logout`               | `AUTH_MODE=saml`, login/ACS/metadata/SLO, host-only transaction cookie, web session·LoginPage 연결                                | 멀티탭·nonce·InResponseTo·CSRF·open redirect·SessionNotOnOrAfter. Safari/Chrome 실제 callback. SAML 장애 시 local/development 자동 전환 없음                               |
| P03-C04   | GCR · `feat: provision keycloak users from gcr administration`     | GCR 사용자 UI·Admin API adapter, pending/provisioned/failed·재시도·초대/재설정, 명시적인 기존 계정 mapping                        | 중복 요청·응답 유실에도 계정 중복/잘못된 연결 없음. 관리 service account 최소 realm 권한. 기존 이력 보존·SMTP 실패 표시                                                    |
| P03-C05   | GCR · `feat: reconcile identity revocation and security freshness` | GCR 차단 우선, Keycloak outbox·security/admin event 수집·누락 재조정, 일반 SLO/전체 기기 폐기 구분. Client grant 폐기 port 준비   | Keycloak 직접 차단·비밀번호 변경·수집 공백·재활성화. Freshness 만료의 `503 IDENTITY_UNAVAILABLE`, 확인된 철회의 즉시 반영. P04에서 실제 grant 폐기 회귀 추가               |
| P03-C06   | GCR · `feat: provision isolated databases on shared postgres`      | DBA provisioning, `gcr_app/gcr_migrator/gcr_keycloak` ACL, existing-volume 재실행, pool 예산·secret 분리                          | 빈/기존 볼륨 모두 데이터 유지, non-superuser·양방향 cross-DB 접근 거부, migration 권한 분리. PUBLIC·membership·기존 연결 검사                                              |
| P03-C07   | GCR · `feat: deploy keycloak with compose and companion chart`     | `compose.identity.yaml`, `gcr-identity` chart, GCR saml schema/Secret/ConfigMap, TLS·probe·NetworkPolicy·공식 optimized image     | PostgreSQL 하나, legacy Keycloak dependency off, 반복 bootstrap에서 사용자/키 보존, 공개 admin 경로 차단·replica 교체·pool 제한                                            |
| P03-C08   | GCR · `docs: verify saml migration and identity recovery`          | 테스트 복원본의 계정 mapping·초대·local 로그인 종료, 앱/identity DB 복구·키 회전·관리자 복구 절차. 단계적 운영 전환 기록          | 복원 뒤 session/credential 재인증, 계정 혼동·과거 차단 부활 차단. 이미지 downgrade만으로 Keycloak DB rollback하지 않음. 실제 지원 버전과 검증 환경 기록                    |

**완료 조건:** 실제 Keycloak 로그인·로그아웃, 두 replica replay 차단, 기존 계정 연결, 생성/차단/복구, 공유 DB 격리와 복구 rehearsal을 통과한다. DNS/TLS/SMTP·운영 전환이 남으면 그 범위를 별도 미완료로 기록한다. 이 phase의 grant 폐기 port만으로 client token 폐기를 구현했다고 표시하지 않는다.

### P04. GCR client 인증과 credential broker

**Goal 목표:** 동일한 GCR 사용자·repository 권한으로 API key, 브라우저 PKCE, headless device 연결을 제공하고 갱신·폐기를 CD와 CLI에 일관되게 적용한다.

| Commit ID | 저장소·제안 메시지                                                | 변경 범위                                                                                                                                           | Commit 검증                                                                                                                                       |
| --------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| P04-C01   | GCR · `feat: add scoped client grants and bearer authorization`   | 등록 public client, authorization/device transaction, grant·scope·repo 집합, token family·digest, key·audit schema. 전용 bearer guard·config/me API | 발급 범위와 현재 권한의 교집합, audience·tenant·repo·owner 검증. Browser cookie/development 사용자 fallback 거부. 미구현 flow는 config에 미노출   |
| P04-C02   | GCR · `feat: manage personal client api keys`                     | 웹의 key 생성·1회 표시·목록·만료·폐기 API/UI. 이름·repo·scope·수명, 요청별 인가, opaque secret digest                                               | CSRF·본인/관리자 권한·다른 사용자 key 접근 거부. 재조회·로그에 원문 없음. 기본 read scope로 source/feedback/model 호출 거부                       |
| P04-C03   | GCR · `feat: authorize native clients with pkce`                  | authorize/decision/token, SAML session 기반 승인, S256·등록 callback·loopback·state·issuer 결합                                                     | Code 재사용·verifier 불일치·redirect 변조·승인 거절·만료. 두 replica code 교환 경쟁. SAML transaction과 PKCE transaction 혼동 방지                |
| P04-C04   | GCR · `feat: authorize headless clients with device grants`       | device 발급·확인 UI·decision·polling/token 교환, 시도 제한·slow_down·만료                                                                           | 미승인/거절/만료·사용자 코드 추측·polling 남용, 요청 기기·scope·repo 표시. SAML assertion이 CLI로 전달되지 않음                                   |
| P04-C05   | GCR · `feat: rotate and revoke client credential families`        | Refresh 일회성 rotation·reuse detection, grant/key 폐기, 모든 기기 logout·계정 차단·비밀번호 재설정과 P03 lifecycle 연결                            | 동시 refresh·응답 유실·family 재사용·Keycloak 직접 변경/수집 공백. 폐기 후 다음 API 차단, 일반 웹 logout의 별도 범위 유지                         |
| P04-C06   | GCR · `feat: share client credentials through a local broker`     | `client-core`의 OS credential adapter·사용자 전용 IPC·refresh 직렬화, connection profile·서버 신뢰 확인, CLI login/logout/key/device                | 여러 process refresh가 한 번 수행됨. 응답 유실은 재인증, 다른 origin redirect·server/account 변경에 token 비전송. Extension 종료 후 headless 사용 |
| P04-C07   | CD · `feat: add centralized connection and credential management` | 서버 URL·연결 테스트·login/api-key 선택·승인 callback, 연결된 사용자/기기·권한·만료·연결 해제 UI. P04-C06 artifact pin                              | 실제 SAML→client 승인 및 API key 연결, 비밀 입력, URL 변경 확인. URL 입력만으로 mode 변경 없음. Sync 미구현 상태는 별도 표시                      |

**완료 조건:** 두 사용자·두 tenant/repository의 교차 접근 차단, key·PKCE·device 실제 연결, refresh 경쟁·폐기·서버 변경을 검증한다. Token·key·웹 session·SAML assertion·모델 계정·게시 credential을 서로 대체하지 않는다. 인증 모듈 검토와 회귀 결과가 없으면 외부 client endpoint를 활성화하지 않는다.

### P05. 중앙 기준 관리와 배포 API

**Goal 목표:** 기존 리뷰 원천·메모리로 검토 기준을 만들고 승인한 버전만 불변 bundle로 발행한다. 인증된 사용자는 자기 repository·개인 범위의 일관된 manifest를 받는다.

| Commit ID | 저장소·제안 메시지                                                       | 변경 범위                                                                                                                                             | Commit 검증                                                                                                                                     |
| --------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| P05-C01   | GCR · `feat: model review decisions and versioned criteria`              | 기존 memory/source 확장, `review_decisions`, rule/revision·counter-evidence·appliesTo·exception·evaluation 계약/DB. 기존 memory 상태와 rule 상태 분리 | Immutable revision·source hash·supersedes, 기존 메모리 호환. `verified`·confidence로 결함 재현·영구 rule ID를 추정하지 않음                     |
| P05-C02   | GCR · `feat: curate and evaluate repository review criteria`             | 기존 source에서 수동/모델 후보 생성, maintainer-curated provenance, repo maintainer·고위험 승인, evaluated/shadow/active/퇴역 전이                    | 승인 없는 모델 후보·미해결 질문 배포 거부. 결함/수정/정상/반증 fixture 평가 기록. 개인 기여 수를 꾸며 집단 승격하지 않음                        |
| P05-C03   | GCR · `feat: manage review criteria and exceptions in web ui`            | `Review criteria` 목록·상세, 원문→판단→평가→revision, 승인/퇴역·범위/기간 예외. 기존 memory UI 연결                                                   | 일반 사용자 조회/정정·maintainer 변경 권한, stale 수정·동시 승인 충돌, desktop/mobile·키보드 동작                                               |
| P05-C04   | GCR · `feat: publish immutable knowledge bundles from an outbox`         | 정책/Skill·집단·본인 개인 배포 projection, 같은 transaction의 outbox, canonical serialization·hash·크기 제한·artifact staging·release pointer         | 미승인/퇴역/비공개 원문 혼입 거부. Worker crash·중복 이벤트·부분 저장에도 준비되지 않은 artifact 미발행. Skill 실제 본문 포함                   |
| P05-C05   | GCR · `feat: sign coherent manifests and revocation leases`              | 조합 manifest·서명된 빈 personal component·audience·authorization revision·offline lease·key ID·호환성. Rollback은 높은 sequence로 재발행             | 개인 component만 갱신, source 삭제/제외 시 재검토·필요한 철회 발행, signing key 회전. Bundle 크기 초과·개인 발행 실패를 빈 자료로 대체하지 않음 |
| P05-C06   | GCR · `feat: expose authorized repository knowledge endpoints`           | repo resolve, manifest·bundle·source API, ETag/If-None-Match·권한별 projection. Fork·여러 remote·GHES host 명시 매핑                                  | Body owner 위조·bundle ID 추측·다른 tenant·repo 접근 거부. 304 전에도 인가, lease 갱신은 새 서명/200. 임의 URL로 원문 fetch하지 않음            |
| P05-C07   | GCR · `feat: show knowledge publication and client compatibility status` | 발행 실패·현재 component/version·지원 client 표시, sync 상태 수신 계약·최소 metadata 보관 정책. 운영 feature flag와 검증 기록                         | 동기화 관측 없음은 unknown, 내용·개인 메모리 원문·source를 상태 telemetry로 자동 수집하지 않음. 비호환 client 거부 이유 표시                    |

**완료 조건:** 실제 기존 원천 또는 명시적 테스트 원천으로 기준 후보→평가→승인→발행→API 다운로드→수정/퇴역을 수행한다. 동일 인가 범위의 두 client fixture가 같은 조합을 받고 다른 사용자의 personal bundle은 받지 못해야 한다. 이 phase는 API 수준 검증이며 실제 CD sync·리뷰는 P06의 완료 조건이다.

### P06. 중앙 연결·원자적 동기화·fallback

**Goal 목표:** CD와 CLI가 중앙 지식을 안전하게 갱신하고 해당 snapshot으로 수동 실제 리뷰를 수행한다. 장애·만료·권한 철회·계정 변경을 서로 다르게 처리한다.

| Commit ID | 저장소·제안 메시지                                                    | 변경 범위                                                                                                                                                 | Commit 검증                                                                                                                                           |
| --------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| P06-C01   | GCR · `feat: resolve trusted centralized repository profiles`         | 서버 identity·신뢰 키 pin·URL/base path 검증, credential을 제거한 remote→tenant/repo 매핑, profile별 cache 범위                                           | 동일 이름 repo·fork·여러 remote·같은 URL의 다른 server ID 구분. Bundle 자체가 제공한 key를 신뢰 anchor로 채택하지 않음                                |
| P06-C02   | GCR · `feat: synchronize and atomically activate knowledge snapshots` | 조건부 manifest, 변경 bundle만 staging download, audience/schema/signature/hash/size/compatibility 검증, 암호화 store/index·cross-process lock·generation | 다운로드 실패·디스크 부족·오래된 작업·동시 sync에서도 부분 조합/옛 pointer 활성화 없음. 개인 download 실패와 빈 component 구분                        |
| P06-C03   | GCR · `feat: enforce offline leases and connection lifecycle`         | 시작/수동/주기/review freshness sync, backoff·jitter·절전 복귀, configured/effective mode·fallbackReason, logout/cache 폐기                               | 일반 장애·첫 sync 실패·lease 만료·401 제한 갱신·403 철회·503 identity 장애 구분. 304로 lease 연장 금지. Local 자료 보존·재접속 업로드 없음            |
| P06-C04   | GCR · `feat: apply shared knowledge precedence to review context`     | 중앙/로컬 공통 resolver, 적용 범위·branch·예외·현재 반증, 지식/source hash 고정·결과 재사용 key·critical revocation 취소                                  | 관련 없는 collective가 personal을 가리지 않음. Standalone 결과의 중앙 결과 재사용 거부. 일반 갱신은 고정 실행 후 stale, 철회는 context 추가 사용 중단 |
| P06-C05   | CD · `feat: surface knowledge sync and connected review states`       | Mode·server·repo·계정·bundle 버전·만료·출처·readonly UI, sync/status/disconnect, 중앙 및 local 기준을 사용한 수동 backend                                 | P06-C04 artifact pin 후 실제 리뷰. 온라인/cache/fallback·모델 unavailable 구분, 로컬 편집본 보존, 중앙 자료 편집·export 인가                          |
| P06-C06   | GCR · `test: verify connected reviews across client environments`     | macOS CD와 Linux headless의 실제 GCR 연결·같은 release·다른 사용자 격리·수정 후 재리뷰, CD SHA·package hash 증거 기록                                     | Sync 자체 모델 호출 0. Base·관련 코드·메모리 근거가 있는 실제 리뷰, 모델 장애는 미완료. 두 환경을 하나의 모의 process로 대체하지 않음                 |

**완료 조건:** 두 환경의 실제 client가 발행·수정·퇴역을 반영하고 정상 장애에는 허용 cache/fallback을, 확인된 철회에는 중앙 context 중단을 적용한다. 모델 실행 경로가 없으면 cache 성공만으로 리뷰를 완료하지 않는다. Linux credential store·실행 환경이 준비되지 않으면 두 환경 검증을 미완료로 남긴다.

### P07. 네 trigger와 공통 실행 서비스

**Goal 목표:** 사용자가 선택한 Save·Stage·Commit·Push만 정확한 source 범위로 실제 리뷰를 시작하고, 여러 창·CLI·hook의 중복 요청과 오래된 결과를 관리한다.

| Commit ID | 저장소·제안 메시지                                                         | 변경 범위                                                                                                                                    | Commit 검증                                                                                                                                        |
| --------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| P07-C01   | GCR · `feat: persist review requests and source-based deduplication`       | Trigger 사유 집합·work_completed·수동 요청, source/base/context/knowledge/profile/tool/model 기반 key, durable queue·owner lease·재시작 복구 | Trigger 이름만 다른 동일 입력 병합, partial stage/base/설정 변경은 별개. 처리 중 crash·lease 회수 때 이중 실행 방지·불명확한 모델 상태 표시        |
| P07-C02   | GCR · `feat: schedule reviews with budgets and freshness guards`           | Debounce·최소 간격·우선순위·사용자/repo 호출·token·시간 예산, 취소·latest generation·pause/resume                                            | 제어 시계로 연속 변경·한도·재시도·toggle off 검증. 취소 불가 응답의 최신 결과 덮어쓰기 차단. 각 executor의 관측 불가능한 token 비용은 unknown      |
| P07-C03   | GCR · `feat: host reviews in a headless local service`                     | CLI service/watch, 사용자 전용 IPC·repo owner·broker 연결, lifecycle/재시작, 설치 경로와 독립적인 hook 실행 진입점                           | Extension·hook 종료 후 실행 지속, 다른 OS 사용자 IPC 접근 거부, 두 창/CLI 중복 방지, 시작·절전 복귀 재조회. 서비스 없음은 연결 실패                |
| P07-C04   | CD · `feat: configure independent automatic review triggers`               | 네 toggle·repo override·전체 자동 분석 off·수동 실행, Save 하위 Auto Save/외부 변경, 실제 실행 상태·대기 이유 UI                             | 신규 all off·기존 선택 보존. 공유 workspace/중앙 bundle이 자동 분석을 켜지 못함. Watcher 설정 즉시 반영, typing 미호출                             |
| P07-C05   | CD · `feat: schedule save and index changes through the shared core`       | Save와 실제 Git index 변경 감지·debounce, multi-root·하위 폴더·worktree, source 제외·stale 표시                                              | Auto Save/외부 변경 옵션별 호출 수, unstage·변경 없음 미호출, 누락 이벤트 재조회, 같은 저장 입력의 중복 모델 실행 방지                             |
| P07-C06   | GCR · `feat: review commit and push snapshots without blocking by default` | 실제 hook index·amend·부분 commit, pre-push stdin의 모든 ref·신규/삭제 ref·force push 범위, advisory/선택적 대기·timeout adapter             | 임시 index·초기 commit·새 remote branch·여러 ref를 로컬 bare remote로 검증. 확정 불가 입력은 unsupported/incomplete. Queue 접수와 리뷰 완료를 구분 |
| P07-C07   | CD · `feat: integrate non-destructive git hook adapters`                   | P07-C06 artifact pin, `git rev-parse` 기반 hook 경로, core.hooksPath·기존 hook manager 연동, 설치/해제·서비스 상태                           | 기존 hook 내용/종료 의미 보존·stdin 전달. 관리 중 아닌 hook 삭제/덮어쓰기 없음. 실제 commit/push 결과와 리뷰 상태 별도 표시                        |

**완료 조건:** 네 toggle의 16개 조합은 모의 executor와 제어 시계로 호출 여부를 검증하고 각 trigger 단독 및 중복 경로는 실제 모델로도 확인한다. 모든 조합에서 실제 유료 호출을 반복할 필요는 없다. 같은 입력은 한 번 실행하고 서로 다른 index/base/ref 범위는 합치지 않는다. Advisory hook의 Git 명령 진행을 ‘검증 통과’로 표시하지 않는다.

### P08. 리뷰 대화·MCP·Skill·feedback

**Goal 목표:** Finding에 대해 추가 코드를 조회·질문하고 답변 후 재개한다. 같은 기능을 CLI/MCP에서 사용하며 사용자가 제출한 판단만 중앙 후보로 되돌린다.

| Commit ID | 저장소·제안 메시지                                                 | 변경 범위                                                                                                                 | Commit 검증                                                                                                                                                |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P08-C01   | GCR · `feat: persist interactive local review conversations`       | 기존 chat-run의 질문·checkpoint·citation 계약에서 순수 부분 재사용, local 대화 저장·ask_user·응답·재개·취소·예산          | 프로세스 재시작 후 복원, 중복 응답·stale source·철회·질문 미답변 처리. Executor의 대화 지원 capability를 실제 경로로 확인                                  |
| P08-C02   | CD · `feat: discuss findings with source-linked review chat`       | Finding 질문, 관련 base/source 추가 조회·사용자 확인·재개, Summary/findings/근거·질문 분리, Thinking·진행 상태            | 실제 질문→추가 조회→응답 후 재개, Enter/Shift+Enter, 취소·재연결·위치 이동. 긴 상세 설명과 간결한 요약 형식 유지                                           |
| P08-C03   | GCR · `feat: add explicit review feedback and result submission`   | Feedback·최소 result metadata API, snapshot/rule/source 참조·idempotency·scope·retention, connection별 offline 제출 queue | 명시적 사용자 제출만 전송. 중복/서버 전환·권한 철회·개인 원문 누출 거부. 모델 동기화 실패와 feedback 실패 분리                                             |
| P08-C04   | GCR · `feat: expose review workflows through stdio mcp`            | status/sync/context/prepare/review/result/get-rule/submit-review/feedback 도구, 고정 Git root·capability·protocol 호환    | 두 실제 host 연결 또는 지원 host별 재현 기록, 도구 실패·취소·재접속. prepare를 AI 리뷰 완료로 표시하지 않고 self-report는 trusted evidence로 승격하지 않음 |
| P08-C05   | CD · `feat: submit reviewed feedback as central candidates`        | 오탐·예외·새 판단의 대상 서버/공개 범위·내용 확인, 제출/보류·후속 승인 상태, local memory 생성 선택                       | 사용자 선택→중앙 후보→권한자의 승인→새 bundle sync→재리뷰. 중앙 readonly bundle 직접 patch 없음                                                            |
| P08-C06   | GCR · `docs: package preventive review skill and client workflows` | `skills/gcr-prevention`, CLI/MCP 설치·context→review→질문/수정→재리뷰 안내, 지원 executor·OS·권한·예산 명시               | 깨끗한 headless 환경의 실제 설치·도구 호출. Skill 설치만으로 watcher·모델·자동 수정이 활성화되지 않음. 로컬 기록/CLI 결과/UI의 계약 일치                   |

**완료 조건:** 실제 모델 대화의 관련 source 조회와 사용자 응답 후 재개, MCP의 같은 snapshot 리뷰, 명시적 feedback의 승인·재동기화 순환을 검증한다. 공용 결과에 개인 memory·chat 원문을 자동 포함하지 않는다. 자동 코드 수정·commit·PR 게시를 Skill이나 save 이벤트의 부수 효과로 추가하지 않는다.

### P09. 통합 검증·운영 배포·extension 게시

**Goal 목표:** 초기 출시의 모든 사용자 경로를 실제 환경에서 검증하고 검증한 서버 artifact와 VSIX를 배포·게시한 뒤 설치 결과까지 확인한다.

이 phase의 `C`는 Git commit, `R`은 실제 환경에서 수행하는 release 작업이다. 업로드·로그인을 가상의 Git commit으로 표시하지 않는다. Commit·push, 서버 배포, Marketplace 게시, 새 환경 설치는 각각 증거를 남긴다.

| Commit ID | 저장소·제안 메시지                                                | 변경 범위                                                                                                                           | Commit 검증                                                                                                                         |
| --------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| P09-C01   | GCR · `test: complete preventive review end-to-end coverage`      | P00 fixture와 실제 GCR/Keycloak/macOS/Linux client를 연결한 E2E, 호환 구버전·계정/tenant/repo 경계·offline·복구 검증 보강           | 아래 초기 출시 검증표 충족. 자동 테스트 skip·fake provider·실제 호출을 구분하고 미확인 항목을 통과로 표시하지 않음                  |
| P09-C02   | CD · `chore: prepare the verified client release`                 | Core/executor dependency pin·lockfile, extension version·channel·changelog, 최소 지원 VS Code/OS, VSIX 포함 파일·license·asset 확정 | Clean build·Extension Host tests, package 파일 목록·secret 제외·manifest 대조. P09-R01에서 해당 commit으로 최종 VSIX 고정           |
| P09-C03   | GCR · `chore: pin preventive review server and identity releases` | 검증 source로 만든 image·chart·Keycloak·client 호환 version/digest, migration·feature flag·점진 전환·운영 설정 기록                 | Helm lint/template·migration rehearsal·기존 Secret/PVC/계정/권한/worker 설정 보존. 원문 secret·제안 hostname을 무검증 적용하지 않음 |
| P09-C04   | GCR · `docs: record deployed preventive review verification`      | P09-R02 결과, 실제 image/migration/health·SAML·sync·review 검증, source/artifact/client SHA 연결                                    | 운영 rollout·기존 PR/chat 회귀·rollback 준비 증거. 문서 commit 때문에 실행 image 재빌드하지 않음                                    |
| P09-C05   | CD · `docs: record marketplace release and installation checks`   | P09-R03의 publisher/name/version/channel·VSIX hash·게시/새 설치·smoke 증거·지원 제한                                                | Source 재빌드로 VSIX가 바뀌지 않았는지 확인. QA 증거가 VSIX에 포함되지 않음                                                         |
| P09-C06   | GCR · `docs: close the initial preventive review milestone`       | P00–P09 실제 SHA·완료 조건·CD 게시 기록·잔여 후속 항목, 제품/운영 가이드·handoff 갱신                                               | 구현·push·배포·게시·설치 결과를 별도 확인. 미완료 초기 기능을 후속 범위로 옮겨 완료 처리하지 않음                                   |

| Release 작업                    | 수행 시점과 내용                                                                                                                        | 완료 증거                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| P09-R01 · 최종 VSIX 검증        | C02 이후. 로컬 Development Host 실동작 → 최종 package → SHA-256 기록 → 격리된 VS Code에 해당 VSIX 설치 → 전체 신규 기능 재검증          | Source/lock hash·VS Code/OS·VSIX hash, 실제 화면·redacted log, 설치 버전, standalone/centralized·네 trigger·chat·실패 상태      |
| P09-R02 · 서버·identity rollout | C03 push 이후. 기존 운영 기준을 확인하고 DB 준비·migration·호환 Server/Worker·identity 배포·관리자 pilot·일반 사용자 확대 순서 실행     | 실제 image/chart/digest·migration checksum, health·로그인·차단·sync·두 client 리뷰, 기존 데이터/Secret/PVC 보존, 장애/복구 확인 |
| P09-R03 · CLI 인증·게시·설치    | R01·R02 통과 및 C04 이후. 실제 publisher 역할/scope 확인 → CLI 인증 → hash 재대조 → 동일 VSIX 게시 → Marketplace 반영 → 새 QA 환경 설치 | CLI 게시 결과, 정확한 공개 version/channel, Marketplace 설치 버전·activation·설정·리뷰 smoke. 응답 유실은 조회 후 처리          |

실행 순서는 `C01 → C02 → R01 → C03 → R02 → C04 → R03 → C05 → C06`이다. 실패 수정은 새로운 source commit과 artifact를 만들고 영향을 받은 gate부터 다시 검증한다. 게시 명령은 검증한 파일을 지정하는 `vsce publish --packagePath` 경로를 사용하며 게시 직전에 version 자동 증가·재빌드로 artifact를 바꾸지 않는다.

R03의 인증 경로는 현재 지원하는 CLI 방식과 해당 publisher의 실제 계정·권한으로 확인한다. 9월 11일의 Azure refresh token 만료·로컬 credential 조회 정지는 재검증 대상이다. `verify-pat` 성공이나 Marketplace GET 성공만으로 게시 권한·업로드 통과를 판정하지 않는다. 사용자 본인 인증이 필요한 경우 구체적으로 요청하고 나머지 준비·검증은 작업자가 수행한다.

**완료 조건:** R01·R02·R03의 실제 성공과 C06의 근거가 모두 있어야 초기 출시 goal을 완료한다. Code 완료만 목표로 별도 요청받았다면 code goal은 종료할 수 있지만 이 P09와 제품 출시 완료를 선언하지 않는다. 최초 지원은 실제 검증한 macOS·Linux 경로로 기록하고 Windows/Remote SSH/WSL/Dev Container 지원은 별도 검증 없이 확대하지 않는다.

## 6. 후속 확장

P10–P13은 P09를 완료하기 위해 끼워 넣는 선행 과제가 아니다. 기존 모델 API/계정 executor와 로컬 source 조회만으로 초기 실제 리뷰를 제공한다. 후속 phase도 같은 commit·회귀·전달·goal 기록 규칙을 적용한다.

### P10. 선택적 중앙 모델 실행

**Goal 목표:** 사용자가 중앙 executor를 명시적으로 선택하면 허용한 source만 GCR로 보내고 중앙의 계정 할당·예산·취소·보존 정책으로 리뷰한다.

| Commit ID | 저장소·제안 메시지                                                | 변경 범위                                                                                                         | Commit 검증                                                                                                                     |
| --------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| P10-C01   | GCR · `feat: define authorized remote review jobs`                | Client source/context upload·job/status/cancel/result 계약, `ai:invoke`·repo 인가·전송 범위·retention·idempotency | 미커밋 source를 기존 PR snapshot으로 위장하지 않음. Read-only sync credential의 모델 호출 거부·크기/경로/source 검증            |
| P10-C02   | GCR · `feat: execute client reviews with central model admission` | 중앙 local-review job·worker/checkpoint, 기존 account registry·admission·사용자/repo 예산, source 정리            | 계정 grant 변경·worker crash·capacity 부족·partial 실패. 중앙 credential이 artifact·응답·client에 노출되지 않음                 |
| P10-C03   | GCR · `feat: add a recoverable central review executor`           | Core remote executor, 접수 후 응답 유실·상태 조회·취소·모델 대체 정책, 장기 context 및 결과 retention             | Job 상태 불명 시 로컬 이중 실행 금지. 캐시 지식만 있을 때 중앙 모델 실행 가능으로 표시하지 않음. 명시 승인된 source 경로만 전송 |
| P10-C04   | CD · `feat: select and monitor centralized model execution`       | Local/centralized executor 선택·전송 범위·예산·진행/미확정 상태 UI, package pin                                   | 실제 중앙 모델 리뷰, 선택되지 않은 provider 미호출, 서버/계정 전환·취소·fallback 사전 동의 검증                                 |

**완료 조건:** 중앙 credential 복사 없이 실제 리뷰를 수행하고 source·계정·예산 경계와 job 응답 유실을 검증한다. Centralized knowledge sync를 선택했다는 이유로 이 executor를 자동 선택하지 않는다.

### P11. 실행 runner와 검증 근거

**Goal 목표:** 승인된 기존 테스트·타입·contract 검사를 격리된 source snapshot에서 실행하고 실제 재현 근거를 review evidence에 연결한다.

| Commit ID | 저장소·제안 메시지                                                       | 변경 범위                                                                                                           | Commit 검증                                                                                                                       |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P11-C01   | GCR · `feat: define runner profiles and reproducible evidence`           | Runner image/command/args·network·resource·source 권한, evidence의 input/assertion/expected/actual/environment 계약 | Rule/Skill의 자연어가 runner 권한을 생성하지 않음. Anchor/source/test-confirmed와 policy 판정 분리                                |
| P11-C02   | GCR · `feat: execute approved checks in isolated snapshots`              | 일회용 source·임시 쓰기 공간·secret/home/socket 미마운트·기본 network off·timeout/output limit·정리                 | 실제 지원 OS/runtime의 탈출·자원·network·symlink 검증. 격리 미충족 시 unavailable, 단순 subprocess 실행을 sandbox로 표시하지 않음 |
| P11-C03   | GCR · `feat: attach reproduction and counterexample results to findings` | 같은 fixture의 base/변경본 실행, coverage와 재현 조건·반례 연결, stale invalidation, 선택적 critic의 독립 context   | 수정본/정상 반례·실패 fixture, process exit 0만으로 해결 판정 금지. 두 모델의 합의를 test-confirmed로 승격하지 않음               |
| P11-C04   | CD · `feat: display verified review evidence and execution limits`       | Evidence 상세·명령/환경/범위·미실행 원인, 승인된 runner 선택·source 재검토                                          | 실제 재현·timeout·runtime 부재 표시. 긴 테스트를 Save에 자동 추가하지 않음                                                        |

**완료 조건:** 허용한 runner의 실제 재현·정상 반례와 격리 검증을 통과하고 결과를 두 client에서 확인한다. Linter 제품·rule engine을 새로 개발하지 않는다. 실행 fixture의 성공을 전체 시스템 안전성으로 확대하지 않는다.

### P12. 리뷰 이력과 지속 학습

**Goal 목표:** PR thread의 지적·반박·수정·합의와 source 변화를 추적하고 검토를 거친 판단을 다음 로컬 리뷰에 반영한다.

| Commit ID | 저장소·제안 메시지                                                     | 변경 범위                                                                                                     | Commit 검증                                                                                                   |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| P12-C01   | GCR · `feat: preserve review threads and revision provenance`          | GitHub/GHES thread/reply·review state·resolved/outdated·수정 SHA·merge 시각, 관측·삭제/접근 불가/unknown 구분 | API 미지원·누락 상태를 사실로 생성하지 않음. 댓글 ID·version/hash·원문 변경 이력 유지                         |
| P12-C02   | GCR · `feat: reconcile incremental and closed pull request history`    | 기존 polling 증분 cursor·실패 재시도, 최근 종료 PR 회수·webhook 보정, bounded backfill·quota                  | 중복/역순/유실·pagination 중단 재개, scope/기간/처리량 제한. 전체 과거 PR 자동 수집 금지                      |
| P12-C03   | GCR · `feat: derive review decisions from discussion and code changes` | 여러 원문·수정 전후에서 결함/오탐/예외/설계 결정/질문 후보, provenance·평가·명시적 승인 연결                  | Merge·resolve를 결함 해결로 단정하지 않음. 의미 유사도만으로 다른 endpoint의 위반을 합치지 않음               |
| P12-C04   | GCR · `feat: re-evaluate criteria when sources or exceptions change`   | 원문 삭제/비공개·전제 변경·예외 만료·재발의 재검토·퇴역·critical revocation·재발행                            | 과거 지적 blanket suppression 없음. 예외 만료 후 재등장, 권한 사라진 원문의 배포 projection 정리              |
| P12-C05   | GCR · `feat: trace recurring findings and feedback outcomes`           | Occurrence의 open/fixed/false-positive/exception/superseded, 원문→판단→배포→리뷰→수정 연결·관리 UI            | 동일 revision 중복과 새 SHA 재발 구분, feedback 중복 제출 집계 방지. 실제 표본으로 다음 client 리뷰 적용 확인 |

**완료 조건:** 실제 확인 가능한 논의와 수정 표본으로 후보→검토→배포→다음 로컬 리뷰를 연결하고 전제가 바뀐 판단을 재검토한다. 개인별 기여나 결함 수를 추정으로 채우지 않는다. Webhook·backfill은 사용자가 지정한 저장소·범위와 기존 권한 안에서 운용한다.

### P13. 중앙 PR 리뷰와 운영 지표

**Goal 목표:** 중앙 PR 분석에 같은 공용 기준을 적용하고 로컬/중앙/CI 근거의 신뢰 수준을 구분해 재발·오탐·검토 비용을 관측한다.

| Commit ID | 저장소·제안 메시지                                                     | 변경 범위                                                                                                     | Commit 검증                                                                                                                    |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| P13-C01   | GCR · `feat: pin shared criteria in central pull request reviews`      | 중앙 분석에서 공용 bundle·resolver·result 계약 고정, 개인 context의 PR projection 제외                        | 동일 fixture에서 client/central 기준 적용 일치, queued/running 이전 revision 보존, 개인 원문/ID 누출 거부                      |
| P13-C02   | GCR · `feat: link client reports and trusted validation evidence`      | Source/tree/context/rule/tool/profile/environment 일치 검증, self-report와 trusted central/CI provenance 분리 | 위조 client 결과·CI issuer/repo/ref 불일치·stale evidence 거부. P11 미완료 시 test-evidence 경로 비활성                        |
| P13-C03   | GCR · `feat: present recurring findings without duplicate pr messages` | 같은 발생 항목 managed comment 갱신, 새 SHA의 재발·미확인·잔여 위험 구분, 위험별 담당 검토 경로               | 동일 SHA retry 중복 게시 방지·다른 결함 suppression 없음. 실제 PR 게시 검증은 명시된 대상/권한으로 수행, 자동 승인·merge 없음  |
| P13-C04   | GCR · `feat: report review outcomes with explicit observation gaps`    | Outcomes·Client sync·품질/비용 지표: 확인된 재발·오탐·수정·미완료·sync 지연·관측 가능한 호출/시간             | 미제출 telemetry는 unknown, 미판정은 분모 분리. Reviewer 개인 평가·확인되지 않은 사고 감소율 생성 금지                         |
| P13-C05   | GCR · `docs: verify staged rollout and review recovery operations`     | Canary·오탐 기준 rollback·키/계정 폐기·복원·model/DB pool 운영, 지원 환경과 known limitations 갱신            | 규칙은 높은 sequence rollback, client는 검증한 patch 릴리스, identity DB는 검증한 복구 절차. 실제 배포 후 기준/인가/리뷰 smoke |

**완료 조건:** 같은 공용 기준의 로컬/PR 적용과 신뢰 구분을 검증하고 관측 누락이 있는 지표를 사실대로 표시한다. 운영 확대·복구를 검증하되 local hook을 중앙 강제 통제의 증거로 사용하지 않는다.

## 7. 검증과 초기 출시 판정

### 검증 계층

| 계층        | 실행 기준                                                           | 증거와 제한                                                                           |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Commit 회귀 | 변경한 계약·상태 전이·인가·Git·store의 단위/통합 테스트와 typecheck | 새로운 실패 조건을 검증. 구현을 그대로 복제한 테스트·문서만 바뀐 테스트 추가는 불필요 |
| GCR 통합    | 실제 전용 PostgreSQL·Server/Worker·artifact, 필요 시 Keycloak       | `GCR_TEST_DATABASE_URL` 미설정으로 skip된 DB tests를 통과로 계산하지 않음             |
| CD 통합     | 고정 dependency의 build·provider tests·Extension Host runner        | 모의 CLI는 인자/취소/error 계약 근거. 실제 모델 품질·GUI 검증을 대신하지 않음         |
| 모델 평가   | 허용 source·계정·예산으로 P00 fixture의 실제 리뷰                   | Exact 문장 일치 대신 필요한 source 조회·판단 조건·반증·미완료 표시를 확인             |
| GUI 검증    | 변경 UI의 실제 조작, release는 Development Host와 최종 VSIX 둘 다   | 설치 성공만으로 activation·설정·finding·대화 확인을 대신하지 않음                     |
| Release     | 실제 배포 artifact·최종 VSIX·새 설치                                | Source 검증 결과와 배포 결과를 연결. Token·개인 source 없는 증거만 저장               |

현재 GCR에서 확인한 명령은 다음과 같다. Phase에 필요한 전용 integration 환경을 준비한 뒤 실행하고, 테스트가 실제로 포함됐는지 결과를 확인한다.

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

CD 기준 `2.3.0`의 `vscode-extension`에는 `npm run build`, `npm test`, `npm run package`가 있다. 현재 `npm test`는 provider 테스트이므로 이후 core·Extension Host 테스트 명령을 P00/P02에서 추가하고 그 실제 이름을 실행 기록에 남긴다. 존재하지 않는 명령을 이미 지원하는 것처럼 계획에 적지 않는다. CI나 test runner가 DB·브라우저·모델 검증을 건너뛰면 미수행을 명시한다.

매 commit에는 변경에 맞는 검증을 수행하고 phase의 통합 checkpoint에서 관련 전체 회귀를 수행한다. 통과한 전체 검사를 변경 없이 반복하는 대신 실패 수정·새 변경·새 환경이 있을 때 다시 검증한다. 인증·snapshot·동시성의 회귀를 실제 모델의 확률적 응답에만 의존하지 않는다.

### 초기 출시 필수 시나리오

| 검증 ID | 사용자 경로와 실패 조건                                                                 | 구현·검증 책임     |
| ------- | --------------------------------------------------------------------------------------- | ------------------ |
| V01     | 중앙 미설치/미로그인에서 CD·CLI 실제 리뷰, local memory·Skill CRUD·재시작 복원          | P02, P09           |
| V02     | 실제 SAML login/logout·기존 사용자/권한/owner 보존·cross-replica replay 차단            | P03, P09           |
| V03     | 공유 DB 하나·별도 role·양방향 cross-DB 거부·기존 볼륨·backup 복원                       | P03, P09           |
| V04     | Keycloak 직접 차단·event 유실·freshness·grant/key 폐기·재활성화                         | P03, P04, P09      |
| V05     | API key·PKCE·device 실제 연결, refresh 경쟁·응답 유실·서버 변경                         | P04, P09           |
| V06     | 두 사용자/tenant/repo의 manifest·bundle·source·feedback 격리, 304 인가                  | P04–P06, P08       |
| V07     | 승인→발행→두 환경 sync→변경/퇴역, 개인 component만 갱신·빈 component 검증               | P05, P06, P09      |
| V08     | 부분 download·잘못된 서명·크기/호환성·오래된 작업·동시 sync·key rotation                | P05, P06           |
| V09     | 일반 장애/cache 없음/만료/401/403/identity 503·복귀·local 자료 보존                     | P06, P09           |
| V10     | Python·TypeScript 및 혼합 API 계약의 결함/수정/정상/반증에 대한 실제 맥락 리뷰          | P00, P02, P06, P09 |
| V11     | 네 trigger all off/on 조합·repo override·Auto Save/외부 변경·즉시 설정 반영             | P07, P09           |
| V12     | Partial stage·amend·초기/부분 commit·alternate index·삭제/rename·worktree·다중 push ref | P02, P07           |
| V13     | 여러 창·CLI·hook 중복, queue crash·예산·취소·절전/재시작·stale 결과                     | P07, P09           |
| V14     | 기존 hook 보존, advisory/대기/timeout, 서비스 부재·unsupported의 정확한 표시            | P07, P09           |
| V15     | Finding 질문→관련 코드 조회→사용자 답변→재개, CLI/MCP의 같은 core·snapshot              | P08, P09           |
| V16     | 명시적 feedback→후보→승인→다음 sync, server/account 전환 시 전송 보류                   | P08, P09           |
| V17     | 모델 없음/오류/한도·필수 context 누락을 미완료로 표시, 개인 자료의 공용 결과 유출 방지  | P02, P06–P09       |
| V18     | 최종 VSIX 로컬 설치·CLI 게시·Marketplace 새 설치·서버 rollout·기존 기능 회귀            | P09                |

V01–V18 모두 검증 근거가 있어야 P09를 완료한다. 모의 테스트로 안정적으로 검증할 failure matrix와 실제 환경이 필요한 사용자 경로를 구분하며 테스트 건수 자체를 완료 기준으로 삼지 않는다.

## 8. 초기 설정값과 결정 시점

아래 값은 원 설계의 제안값이다. 측정된 최적값이나 현재 구현 설정이 아니다. 실제 채택값·상한·사용자 노출 위치는 담당 commit에서 확정해 contract·설정·test fixture가 같은 값을 사용하게 한다.

| 항목               | 설계 제안                                                                  | 확정 commit      |
| ------------------ | -------------------------------------------------------------------------- | ---------------- |
| Mode·executor      | standalone, 로컬 executor 기본; 중앙 모델 선택은 P10 이후                  | P00-C05, P02-C04 |
| 신규 자동 리뷰     | Save/Stage/Commit/Push 모두 off, advisory                                  | P07-C04          |
| Save               | 3초 debounce·최소 10분 간격, Auto Save/외부 변경 off                       | P07-C02, P07-C04 |
| Stage              | 3초 debounce, 실제 index 변화 확인                                         | P07-C02, P07-C05 |
| Sync               | 사용 중 300초+jitter, 리뷰 전 5분 이상 미확인 시 재조회                    | P06-C03          |
| 중앙 offline lease | 최대 24시간 제안, repo 정책으로 단축/금지                                  | P05-C05          |
| Client credential  | code 최대 10분·access 15분·refresh 30일 미사용/최대 90일·API key 기본 30일 | P04-C01–C05      |
| SAML               | Transaction 최대 5분·clock skew 최대 60초                                  | P03-C01–C03      |
| Identity freshness | 최대 5분 목표, 이벤트 연속성 확인 필요                                     | P03-C05          |
| Client CLI         | 완료/후속 조치 없음 0, finding/질문 1, 미완료/오류 2; hook adapter는 별도  | P02-C06, P07-C06 |

### 미리 해결할 의존성

| 결정·외부 조건                                                 | 해결 지점                                           | 해결 전 계속할 수 있는 작업                                                |
| -------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| Common package 배포 위치·version pin·Node/VS Code 호환         | P00-C02. 실제 설치/재현 가능 명령까지 필요          | Baseline·fixture·CD 기존 결함 재현                                         |
| 실제 executor·source 전송 범위·계정/예산                       | P00-C04/C05. Adapter의 읽기 범위와 모델 호출을 확인 | 결정적 계약·store·snapshot 테스트. 실제 리뷰 완료는 보류                   |
| SAML library·Keycloak image 지원/보안·persistent NameID·cookie | P03-C01. 공식 문서·선택 버전 PoC 결과로 결정        | Standalone core·fixture, identity schema 초안                              |
| 실제 운영 hostname·DNS/TLS·SMTP·관리자 mapping                 | P03의 통합·운영 전환 전                             | 로컬 HTTPS·격리 DB 검증, additive 코드·비활성 배포                         |
| macOS/Linux credential store·headless 설치                     | P02-C02, P04-C06                                    | 순수 resolver·Git·store port tests. 평문 credential 저장으로 대체하지 않음 |
| 기존 dirty CD checkout·미커밋 submodule 변경                   | P00-C01                                             | 기준 ref의 별도 worktree에서 개발. 사용자 변경 stash/reset·자동 stage 금지 |
| 게시 계정·실제 publisher 쓰기 역할·CLI 본인 인증               | P00-C05에 상태 기록, P09-R03에서 완료               | Build·GUI·VSIX·서버 검증까지 진행. 인증 전 실제 게시 성공을 주장하지 않음  |

Token budget이나 작업 시간이 소진될 것 같다는 이유로 필수 검증을 후속 phase로 옮기지 않는다. 범위 변경이 필요하면 원래 완료 조건·변경 이유·영향받는 phase를 실행 기록과 이 계획에 함께 반영한다.

## 9. 설계 요구와 구현 위치 대응

| 설계 요구                                         | 담당 commit/phase                            |
| ------------------------------------------------- | -------------------------------------------- |
| CD 재사용·안전성 선행 수정·legacy 설정 보존       | P01-C01–C05, P02-C07/C08                     |
| 서버 비의존 core·CLI·executor·artifact 배포       | P00-C02, P02-C01/C05/C06, P07-C03            |
| Standalone local memory·Skill·암호화·retention    | P02-C02/C04/C07                              |
| 정확한 snapshot·base·관련 source·혼합 언어·반증   | P00-C03/C04, P02-C03–C05, P06-C04            |
| Keycloak SAML·identity mapping·사용자 관리·복구   | P03-C01–C08                                  |
| 공유 PostgreSQL·별도 DB/role·기존 볼륨·companion  | P03-C06–C08                                  |
| API key·PKCE·device·rotation·폐기·broker          | P04-C01–C07                                  |
| 정책·Skill·집단/개인 배포 projection·승인·예외    | P05-C01–C04                                  |
| Outbox·불변 artifact·manifest·서명·lease·rollback | P05-C04–C06, P06-C02/C03                     |
| Repo resolve·scope·personal owner·304 인가        | P04-C01, P05-C06, P06-C01                    |
| 원자적 sync·key pin·cache/fallback·source 철회    | P06-C01–C06                                  |
| 네 trigger·예산·dedup·service·hook·stale          | P07-C01–C07                                  |
| 질문/재개·MCP·Skill·명시적 feedback 순환          | P08-C01–C06                                  |
| 실제 VS Code·동일 VSIX·CLI 인증/게시·새 설치      | P09-C02, P09-R01/R03, P09-C05                |
| 운영 배포·기존 사용자/권한/계정/데이터 유지       | P03-C08, 각 GCR 전달 checkpoint, P09-R02/C04 |
| 중앙 모델 proxy·source 동의·admission             | P10                                          |
| 실행 runner·근거 수준·critic                      | P11                                          |
| Thread/수정 이력·지속 학습·backfill·재검토        | P12                                          |
| 공용 PR 기준·trusted evidence·중복 게시·성과 지표 | P13                                          |

처음 시작할 goal은 P00이다. 이후에는 해당 phase 실행 기록의 실제 완료 조건을 확인하고 다음 goal을 시작한다.
