# GCR 리뷰 이력 저장과 Commit Defender pulling 구현 계획

작성일: 2026-09-15
상태: G01·G02 완료. G03 구현과 VSIX 로컬 설치는 완료했으나 실제 계정 모델 리뷰가 취소·시간 초과로 끝나 G03은 미완료다. 최신 검증 선택은 사용자 지정 `gpt-5.6-luna / high`다. Marketplace 게시는 별도 작업으로 보류한다. G04는 미착수다. 근거와 검증 범위는 [G01 실행 기록](execution/review-memory-pull/G01.md), [G02 실행 기록](execution/review-memory-pull/G02.md), [G03 실행 기록](execution/review-memory-pull/G03.md)을 따른다.
근거: [원래 요구 범위 점검](reviews/original-scope-review-2026-09-15.md)

## 목적과 적용 순서

GCR의 기존 PR 리뷰 동작을 유지하면서 과거 리뷰 코멘트를 저장한다. Commit Defender는 기존 로컬 모델·계정으로 리뷰하며 GCR의 리뷰 이력·Skill·검증 지침을 읽기 전용으로 가져와 활용한다.

이번 재개 작업의 범위·순서·완료 조건은 이 문서를 따른다. 이전 [P00–P13 구현 계획](preventive-review-implementation-plan.md)은 구현 경위와 코드 재사용을 확인하는 참고 자료로 남긴다. 이전 문서의 미완료 항목을 새 goal에 자동으로 포함하지 않는다.

| Goal | 결과 | 의존성 | 현재 상태 |
| --- | --- | --- | --- |
| G01 | 기존 WIP 보관·분리와 문서 정리, GCR 리뷰 동작 복구·보존 | 없음 | 완료 |
| G02 | 과거 리뷰 이력 저장·중앙 조회·읽기 API | G01의 운영 복구 | 완료: 실제 두 PR 대조·reader API·출처 지침 1건 발행 |
| G03 | CD pulling과 기존 로컬 provider 리뷰 연결 | G02의 읽기 계약 | 미완료: 로컬 설치 완료, Luna/high 실제 리뷰 시간 초과 |
| G04 | 실제 과거 사례로 전체 흐름 검증·최종 전달 | G01–G03 | 미착수 |

한 번에 한 goal만 실행한다. 완료 후 결과를 보고하고 다음 goal은 사용자가 지정했을 때 시작한다. 이 계획의 작성은 네 goal 전체의 실행 요청이 아니다.

## 제품 범위

### 유지할 기능

- GCR의 PR 수집·분석·보고서·기존 게시 동작, 중앙 모델·계정 설정.
- 과거 코멘트 원문, 답글 관계, 출처 PR·commit·파일 위치, 수정·상태 관측 이력.
- CD의 로컬 provider·모델·계정 선택과 리뷰 결과 표시, 현재의 source 수집·민감 파일 제외·취소·실패 처리 보완.
- 기존 중앙 읽기용 인증·저장소 인가, 버전 확인·서명 검증·로컬 캐시, Skill·프롬프트 지침 전달.
- 이미 요청받아 배포한 Keycloak·Helm·DB TLS. 새 SAML 전환이나 인증 체계 확장을 이번 기능의 선행 조건으로 추가하지 않는다.

### 이번에 보완할 기능

| 기능 | 구체적인 범위 |
| --- | --- |
| 이력 확보 | 이미 저장한 코멘트의 조회와 재사용을 먼저 연결하고, 지정한 저장소·PR/기간의 과거 이력을 제한된 작업으로 추가 수집 |
| 메모리 저장 | 원문·출처·버전을 이력 메모리로 영속 보관. 필요하면 출처에 연결된 요약·적용 조건을 별도로 저장 |
| 읽기 API | CD가 허용된 저장소의 이력 목록·요약과 필요한 원문·답글·변경 이력을 조회. 페이지·revision·수집 범위 표시 |
| 로컬 적용 | 기존 로컬 provider가 중앙 자료를 추가 리뷰 문맥으로 사용. 결과에 실제 사용한 자료와 버전을 기록 |
| 확인 화면 | CD에서 내려받은 자료와 해당 원문을 읽고, 현재 리뷰에 어떤 자료가 사용됐는지 확인 |

### 보류·제외

범용 CLI/MCP 제품 확대, 별도 리뷰 채팅, watcher·Save/Stage/Commit/Push 자동화 확대, Docker runner·critic, trusted CI, 재발·성과·비용 대시보드, 신규 PKCE/device/refresh 체계, Marketplace 공개 게시는 이번 완료 조건에 넣지 않는다. 현재 설치된 기능과 사용자 설정은 필요한 수정 외에는 보존한다.

로컬 코드·결과·피드백·대화·개인 Memory 업로드와 중앙 모델 대행 실행은 계속 제외한다. 남은 제출 코드·DB 구조를 전부 삭제하는 작업도 별도 리팩터링으로 확대하지 않는다. 실제 제품 명령·API에 노출된 쓰기 경로는 차단 상태를 유지하고 필요한 노출만 정리한다.

## 검토용 동작 기준

아래 두 항목은 원래 요구를 구체화하기 위한 제안이다. 사용자 선택이 오면 해당 항목과 G02/G03의 범위를 수정한다. 답변이 없더라도 문서 초안을 완성할 수 있지만 이를 실행 코드 배포까지 승인받은 것으로 해석하지 않는다.

| 항목 | 이번 계획의 제안 | 포함하지 않는 확장 |
| --- | --- | --- |
| 히스토리 pulling | 이력 목록·요약·출처를 받고 필요할 때 관련 코멘트 원문·답글·변경 이력을 조회. 이미 조회한 자료는 현재 인가·캐시 정책 안에서 보관 | 전체 조직·모든 과거 PR 원문의 무제한 복제 |
| 검증로직 pulling | GCR의 Skill·프롬프트 지침·검토 절차·적용 조건·반증 조건을 로컬 모델에 적용 | 중앙에서 받은 임의 코드 실행, 신규 테스트 runner·격리 환경·CI 서명 체계 |

원문 히스토리와 검토된 지침은 다르게 취급한다. 원문은 당시 누가 무엇을 지적하고 답했는지에 대한 기록이며, 저장·조회에 메모리 승인이나 집단 승격을 요구하지 않는다. resolved·merged·승인 상태를 결함 수정의 증명으로 바꾸지 않는다.

요약은 원문과 연결된 파생 자료다. 원문 없이 모델이 만든 내용을 과거 사실로 저장하지 않는다. 검토된 지침으로 활성화할 때는 기존 저장소 관리 권한으로 한 번의 명시적인 작업을 사용한다. 개인 후보→집단 정족수→집단 승인→별도 배포 승인을 기본 사용의 필수 경로로 만들지 않는다. 기존 개인 자료를 공용으로 자동 전환하지 않는다.

중앙 자료의 관련성 선택은 로컬에서 수행한다. GCR 요청에는 서버가 이미 알고 있는 저장소·PR·이력 ID, cursor·revision만 사용하며 로컬 diff·파일 내용·질문·리뷰 결과를 검색 요청으로 보내지 않는다. 로컬 provider가 사용자가 선택한 외부 모델 API/계정 CLI인 경우 그 provider 호출과 GCR 업로드는 구분한다.

## 현재 기준과 재사용 위치

아래 운영 숫자는 2026-09-15 14:06–14:07 KST 점검 결과다. goal 착수 시 해당 작업에 필요한 상태만 다시 확인한다.

| 대상 | 기준과 처리 |
| --- | --- |
| GCR 소스 | `feat/preventive-review-platform`, `f8d2048`. 현재 runtime·GitHub 수집·memory·knowledge 코드를 재사용 |
| GCR 배포 | PRISM-DEV, `0.8.0-alpha.60`. server Ready, worker NotReady, lease 만료 running 분석 1건 관측. 원인은 미확정 |
| CD 소스·설치 | `/Users/a09255/git/commit-defender-preventive-review`, `8bb3916`, 설치 `2.10.0`. 원래 `/Users/a09255/git/commit-defender` checkout의 사용자 변경 보존 |
| 실제 이력 | PR 대화 235건, 메모리 4건은 모두 finding 출처 개인 후보. 승인된 배포 메모리와 기준 각각 0건. 수집 이력과 활성 지침 수를 구분 |
| 보류 중 변경 | 미커밋 P11 runner 파일 및 CLI/index 연결 변경이 있음. 후속 build/release에 섞이지 않도록 변경 목록·patch를 보존하고 작업 경계를 분리. 임의 삭제·reset으로 정리하지 않음 |
| 공통 코드 | `packages/client-contract`, `packages/client-core`, `packages/client-executors`의 필요한 부분만 수정. CD는 검증한 고정 package artifact 사용 |

### 기존 goal에서 인계할 미완료 작업

| 항목 | 확인한 상태 | 이번 계획에서 끝낼 일 |
| --- | --- | --- |
| P11 로컬 Docker runner | 새 소스·테스트와 CLI 명령·공통 package export가 미커밋 상태. 마지막 테스트 기록은 27건 통과이나 실제 Docker 실행 검증과 제품 전달은 미완료 | 기능 개발은 보류하고, 추적·미추적 파일을 모두 복원 가능하게 보관한 뒤 새 작업의 source·build·package에서 분리 |
| 점검 결과·새 계획 | 점검 문서·증거, 새 계획과 이전 문서의 대체 안내가 미커밋 | runner 코드와 구분한 문서 commit·push. 실제 보관 위치와 실행 기준도 기록 |
| GCR worker | NotReady와 만료된 실행권의 running 분석이 관측됨. 원인 미확정 | G01에서 최신 상태를 확인하고 원인 수정·작업 복구/종결·운영 검증 |
| GCR alpha60·CD 2.10.0 | 마지막 배포·설치와 전달 기록은 완료. CD 작업 트리는 점검 시 clean | 기존 전달 기준으로 유지. WIP 보관이나 문서 수정만으로 재배포·재설치하지 않음 |

WIP 보관 완료는 P11 기능 완료를 뜻하지 않는다. 실제 Docker 실행 검증·runner UI·추가 실행 기능은 이번 goal의 완료 조건으로 가져오지 않는다.

## G01 — WIP 정리와 기존 GCR 동작 복구·보존

**완료 목표:** 미완성 runner와 문서를 구분해 보존·전달하고, runner가 제외된 작업 기준에서 worker의 기존 PR 분석 처리와 복구를 정상화한다. 중앙 메모리 배포의 실패가 기본 PR 리뷰를 중단시키지 않는다.

**시작 작업 G01-W01 — runner 보관·분리:** 실제 변경 목록을 다시 확인하고 runner 관련 추적 파일의 diff와 미추적 소스·테스트를 함께 보관한다. 별도 WIP branch의 commit 등 복원 가능한 보관본을 만들고 파일 목록·기준 SHA·보관 SHA·미검증 항목을 기록한다. 보관본의 파일 내용과 원래 변경이 일치하는지 확인한 뒤 runner를 포함하지 않는 깨끗한 실행 worktree를 마련한다. 현재 checkout과 사용자의 다른 변경은 보존한다. 새 작업에서는 해당 worktree에서만 build·package를 수행하며, 이전 runner가 포함됐을 수 있는 dist나 tarball을 재사용하지 않는다.

보관용 WIP commit은 기능·릴리스 commit과 구분한다. CLI의 `runner` 명령 연결과 `client-contract/core` export까지 분리됐는지 확인하고 WIP branch를 새 실행 branch에 merge하지 않는다. 이 작업을 위해 runner를 완성하거나 Docker 저장소를 초기화하지 않는다.

| Commit | 저장소·작업 | 검증 |
| --- | --- | --- |
| G01-C00 | GCR · `docs: preserve prior work and establish the scoped restart plan` — 점검 결과·증거, 새 계획과 이전 계획의 대체 안내, WIP 보관 위치·실행 기준을 문서만 commit·push | 문서 commit에 runner 코드가 없음. 원격 commit 확인, 보관본 복원 가능성과 새 실행 worktree의 runner 연결 부재 확인 |
| G01-C01 | GCR · `fix: restore worker progress and expired analysis recovery` — 최신 상태·로그·DB 연결·실행권을 확인해 원인을 특정하고 최소 수정. 중단된 분석의 재개/종결과 job 상태를 일치시킴 | 확인한 원인의 재현, 기존 작업의 진행 또는 정합한 종결, 만료 실행권 회수, 중복 모델 실행·게시 방지. 단순 pod 재시작이나 readiness 완화만으로 완료 처리하지 않음 |
| G01-C02 | GCR · `fix: keep base reviews available without shared knowledge` — 기본 분석과 선택적인 중앙 메모리 보강 상태를 분리. 지식 부재·발행 실패 시 기존 기본 Skill/리뷰 경로를 사용하고 중앙 자료 미적용을 표시 | 지식 정상/부재/손상/철회 조건. 무효 자료를 사용하지 않으며 source·모델 자체의 실패는 그대로 실패/미완료. 기본 분석 성공을 중앙 기준 검증 성공으로 표시하지 않음 |

**전달 작업 G01-D01:** 수정이 필요한 runtime만 build·image·Helm으로 배포한다. server/worker의 준비 상태, 실제 작업 처리·실행권 회수, 기존 분석·보고서·게시 경로 회귀와 DB TLS를 확인한다. 데이터와 provider·계정 설정을 보존한다. 복구한 작업 ID·결과·원인·release를 실행 기록에 남긴다.

**종료 조건:** WIP 복원 검증과 실행 경로 분리, 문서 commit·push, worker 원인·복구 결과, 기본 분석과 선택적 지식 보강의 분리, 필요한 운영 전달을 모두 확인한다. 보관한 runner의 개발은 재개하지 않고 G01 완료 후 멈춘다.

**범위 제한:** 수집 API·CD·새 인증·대시보드는 개발하지 않는다. 원인이 배포 설정뿐이면 불필요한 애플리케이션 변경을 만들지 않고 실제 변경 단위로 commit을 조정한다. 외부 PR 댓글을 새로 쓰는 검증은 기존에 명시된 대상이 있을 때만 수행하며, 대상이 없으면 통제한 HTTP fixture로 게시 동작을 검증하고 실제 게시 미검증을 기록한다.

## G02 — 과거 리뷰 이력 저장·중앙 조회·읽기 API

**완료 목표:** 지정한 실제 PR의 이력과 출처를 중앙에서 읽고, 동일 인가 범위의 client가 조회할 수 있다. 파생 지침이 없어도 원문 이력은 사용할 수 있다.

| Commit | 저장소·작업 | 검증 |
| --- | --- | --- |
| G02-C01 | GCR · `feat: collect selected review history with resumable progress` — 기존 원문·버전·관측 저장과 polling을 재사용. 이미 저장한 이력부터 제공하고 명시한 저장소·PR 목록/기간의 과거 수집을 추가. 작업별 cursor·한도·재개 상태를 보관 | review/inline comment/답글/관련 일반 댓글, 중복 수집·원문 수정·순서 역전·실패 후 재개. 조회 실패·삭제·댓글 없음·미수집을 구분. GitHub와 대조한 범위만 수집 완료 표시 |
| G02-C02 | GCR · `feat: expose review history for read-only clients` — 기존 원문·이력 조회를 확장해 현재 client 인증으로 접근 가능한 읽기 계약 제공. 목록·출처·관련 원문·답글·변경 이력·revision·범위/누락 상태를 반환 | 유효 reader만 접근, 다른 저장소·개인 자료 접근 거부, pagination·원문 일치·변경/삭제 반영. local 내용 없는 GET만으로 조회하고 추가 OAuth 체계를 만들지 않음 |
| G02-C03 | GCR · `feat: publish source-linked review guidance without repeated approval` — 원문에 연결된 요약·적용 조건·반증을 기존 memory/knowledge 구조로 저장. 필요할 때 한 번의 활성화 작업으로 배포 준비까지 처리. 중앙 조회 화면에서 원문과 파생 지침을 함께 확인 | 실제 코멘트에서 만든 지침의 출처 추적, candidate/active 구분, 기존 개인 자료 비공개 유지, 원문 변경 시 재검토 표시. 내용이 없는 release를 메모리 활용 실적으로 집계하지 않음 |

**전달 작업 G02-D01:** 필요한 migration·runtime·web을 검증해 PRISM-DEV에 배포하고 읽기 API를 확인한다. 현재 client의 기존 Skill bundle 읽기 호환성을 유지한다. 저장소·대상 PR/기간·수집 한도는 작업 시작 시 기록하며 무제한 과거 전체 수집을 실행하지 않는다.

**완료 증거:** 선택한 실제 과거 PR의 코멘트 원문과 답글 관계 일치, 수정 이력 및 수집 범위, reader API 조회, 출처가 있는 파생 지침 한 건의 중앙 활성화·발행. 합성 데이터 검증과 실제 과거 데이터 검증을 분리한다. 사용자가 지침 승인을 맡는 경우에는 원문·초안을 검토 가능한 상태로 준비한 뒤 그 결정만 요청한다.

## G03 — CD pulling과 기존 로컬 provider 리뷰 연결

**완료 목표:** CD가 중앙 이력·Skill·검증 지침을 가져와 기존 로컬 provider로 리뷰하고, 결과에서 사용한 출처를 확인할 수 있다.

| Commit | 저장소·작업 | 검증 |
| --- | --- | --- |
| G03-C01 | GCR 공통 client + CD · `fix: preserve local provider selection in knowledge-assisted reviews` — 기존 provider adapter를 필요한 공통 입력/출력 경계에 연결. 중앙 지식 사용 여부와 provider·model·reasoning 선택을 분리. 특정 Astra/xhigh 고정 제한을 제거하되 provider별 실제 capability를 확인 | 중앙 연결 전후 같은 로컬 provider 사용, 모델·reasoning 인자 전달, source 수집 안전성·오류/취소 유지. 기존에 지원을 표시하는 provider는 adapter 계약 회귀를 확인하고 실제 계정 검증 범위는 별도 기록. 로그인 메뉴만 남아 있는 것을 리뷰 지원으로 계산하지 않음 |
| G03-C02 | GCR 공통 client + CD · `feat: pull review history and inspect its sources locally` — G02 읽기 계약을 소비하고 기존 연결/다운로드 화면에 이력과 원문 조회를 추가. 로컬에서 관련 자료 선택·캐시 | 최초 수신·증분/다음 페이지·관련 원문 조회, 계정/저장소 전환·접근 철회·offline 정책. 중앙 요청에 로컬 코드·검색 문맥·결과가 포함되지 않음 |
| G03-C03 | GCR 공통 client + CD · `feat: apply central history and skills to local reviews with citations` — 선택한 원문 이력·활성 지침·Skill을 리뷰 문맥에 넣고 사용한 ID/버전을 결과에 기록. 원문 코멘트는 과거 관측으로 취급 | 관련 사례 적용, 무관한 사례 제외, 반박·수정·예외 문맥 보존. 중앙 자료 없음/서버 장애 시 설정된 로컬 동작, 모델 실패 시 미완료, 중앙 모델 대체 실행 없음. 리뷰 중 갱신된 문맥을 섞지 않음 |

**전달 작업 G03-D01:** 변경된 공통 package를 고정 artifact로 만들고 CD VSIX에 포함한다. source/build/package·실제 Extension Host·설치 파일을 확인한다. 사용자의 provider·계정·자동 실행 설정을 유지하며 전역 CLI 교체나 강제 VS Code 재로드를 하지 않는다. 이미 열린 Extension Host의 적용 상태는 설치 상태와 구분한다.

Marketplace 게시는 사용자 후속 요청으로 별도 작업으로 보류한다. G03은 로컬 VSIX 설치와 계정 모델의 실제 리뷰 검증까지 완료하며 게시 인증 대기를 완료 조건에 포함하지 않는다.

**범위 제한:** 복구 대상은 기존에 제품이 지원하던 provider이며 신규 provider framework나 모든 OS에 대한 새 인증 체계는 만들지 않는다. provider마다 관련 코드 조회 기능이 다르면 실제 제공한 입력과 한계를 표시한다. 기존 source 보호 장치를 제거하고 과거 코드를 통째로 되돌리는 방식은 사용하지 않는다. CLI 변경은 CD에 전달하는 공통 계약과 번들 호환성 유지에 필요한 부분으로 한정한다.

## G04 — 실제 사용 흐름 검증·최종 전달

**완료 목표:** 실제 과거 리뷰가 다음 로컬 리뷰에서 사용되는 것을 확인하고 기존 GCR 동작도 함께 보존한다.

| Commit | 저장소·작업 | 검증 |
| --- | --- | --- |
| G04-C01 | GCR + CD 해당 저장소별 · `test: verify historical review reuse through local pulling` — 대상과 기대 결과를 고정한 회귀 추가. G02의 실제 과거 사례를 사용한 실행 절차 마련 | 아래 수용 기준. 실제 계정 호출이 필요한 검증은 기존에 허용된 로컬 계정/provider와 명시한 source·호출 한도를 사용. 첫 실패의 원인을 확인하고 필요한 검사만 재실행 |
| G04-C02 | GCR + CD 해당 저장소별 · `docs: record review history reuse and delivered versions` — 실제 확인한 결과·사용 자료·제약·artifact·설치/배포 상태와 간단한 사용 절차 기록 | 원문→메모리/지침→pull→로컬 리뷰의 추적, 기존 GCR 회귀, 사용자 설정 보존, 완료 기준별 증거 확인 |

**전달 작업 G04-D01:** G03 이후 결함 수정이 있으면 해당 제품만 다시 전달하고 영향받는 검사만 반복한다. 문서·증거만 추가됐으면 같은 runtime/VSIX를 다시 빌드·배포하지 않는다. Marketplace 게시나 새 registry 구축은 하지 않는다.

### 수용 기준

| ID | 통과 조건 |
| --- | --- |
| A01 | 기존 GCR PR 수집→분석→보고서 흐름이 정상이고 중단 작업이 정합하게 복구/종결됨. 게시 경로의 중복 방지·권한 회귀 통과 |
| A02 | 지정한 실제 과거 PR의 코멘트·답글·출처·변경 이력을 중앙에서 확인. 원천 대조 범위와 미수집 상태를 명시 |
| A03 | 원문 이력을 승인된 요약으로 대체하지 않고 조회 가능. 파생 지침은 출처·상태·버전이 있고 활성화된 실제 항목이 있음 |
| A04 | CD에서 이력·Skill·지침을 받고 관련 원문까지 확인. 다른 저장소·사용자의 자료는 접근하지 못함 |
| A05 | 같은 유형의 결함을 포함한 로컬 변경을 기존 provider로 리뷰하고 사용한 과거 코멘트·Skill을 추적. 수정된 사례와 무관한 사례에서는 과거 지적을 기계적으로 반복하지 않음 |
| A06 | GCR 연결의 요청을 관찰해 local source/result/feedback 업로드 0회와 중앙 모델 대행 실행 없음 확인. 사용자가 선택한 모델 provider 트래픽과 구분 |
| A07 | 중앙 지식 부재·일반 장애·권한 철회·로컬 모델 실패를 구분. 무효 자료 재사용이나 실패의 성공 표시 없음 |
| A08 | 배포한 GCR와 설치한 CD가 확인한 artifact와 일치하고 provider·계정·자동 실행 설정을 보존. 기존 공개 지원 범위와 이번 실제 검증 범위를 구분 |

테스트 수·commit 수·배포 횟수로 기능 진행률을 계산하지 않는다. goal마다 완료한 수용 기준과 남은 항목을 보고한다. 실제 호출 없이 만든 응답으로 A05를 완료 처리하지 않는다. 원문 내용과 계정 비밀정보는 검증 보고서에 불필요하게 복제하지 않는다.

## Goal 실행과 변경 통제

실행 기록은 `.documents/execution/review-memory-pull/G01.md`부터 해당 goal 착수 때 만든다. 빈 실행 기록을 미리 생성하거나 계획표를 완료 증거로 사용하지 않는다.

각 commit 행은 변경·관련 테스트를 함께 검토하는 단위다. 두 저장소에 걸친 행은 각 저장소의 source SHA와 공통 artifact 버전으로 연결한다. 구체적인 결함 때문에 commit 분리가 필요하면 같은 goal 안에서 이유를 기록한다. 단계 숫자를 늘리기 위해 별도 기반 구축 작업을 만들지 않는다.

기존의 source·DB·인증 계약을 유지하는 데 필요한 수정은 해당 goal에서 처리한다. 보류 기능을 새로 넣어야 할 상황이면 왜 현재 목표의 완료에 필요한지 문서에 제시하고 사용자 판단 전까지 추가하지 않는다. 외부 대기 조건이 생겨도 다른 goal로 넘어가지 않고 현재 goal 안에서 할 수 있는 검증·패키징을 진행한다.

### G01 실행 요청 예시

```text
.documents/review-memory-pull-implementation-plan.md의 G01만 goal로 실행해 줘.
먼저 미완성 P11 runner를 복원 가능한 별도 WIP로 보관·검증하고,
새 작업의 source·build·package에서 분리해 줘.
점검 결과와 새 계획은 코드와 구분해 commit·push해 줘.
그다음 worker 장애 복구와 메모리 보강 실패 시 기본 리뷰 유지까지
구현·검증하고 필요한 commit·push·PRISM-DEV 배포와 실행 기록을 완료해 줘.
기존 코드·데이터·사용자 설정을 보존하고 runner 개발과 G02는 시작하지 마.
G01 완료 조건을 충족하면 결과를 보고하고 멈춰 줘.
```

G02 이후도 선택한 goal 하나의 이름과 완료 조건만 목표에 넣는다. `전체 계획대로 계속 개발·배포` 같은 포괄 목표를 다시 생성하지 않는다. 명시된 token budget이 없으면 임의로 설정하지 않는다.
