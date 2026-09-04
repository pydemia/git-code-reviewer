# Git Code Reviewer - 요구사항 명세서

## 1. 문서 정보

| 항목 | 내용 |
|---|---|
| 상태 | 신규 제품 기준안 v2 |
| 상위 설계 | `blueprint.md` |
| 상세 설계 | `functional-design.md`, `ui-implementation-design.md` |
| 사용자 접점 | 사내 HTTPS browser application, PRISM-DEV는 port-forward Local account |
| 운영 환경 | 사내 Kubernetes, OCI image, Helm |
| 기본 locale | `ko-KR` |

이 문서는 기존 CI/CD 중심 제품의 연장이 아니라 중앙형 browser review service의 검수 가능한 요구사항을 정의한다. 상세 구현이 이 문서와 충돌하면 요구사항을 먼저 변경하고 설계를 맞춘다.

- **필수:** MVP release 전에 충족한다.
- **조건부:** 해당 운영 옵션을 활성화할 때 충족한다.
- **후속:** MVP 밖이지만 확장 경계를 보존한다.
- **제외:** 현재 제품이 수행하지 않는다.

## 2. 용어

| 용어 | 정의 |
|---|---|
| GHES connection | 시스템 관리자가 등록한 GHES instance와 암호화된 access token credential의 조합 |
| registered repository | 시스템 관리자가 GHES connection의 token 권한을 검증하고 분석 대상으로 허용한 repository |
| Chat account | 시스템 관리자가 등록하고 tenant/user/group 사용 범위를 정한 server-side ChatGPT 또는 승인된 API account |
| snapshot request | Poll이 관측한 `repository + PR number + base SHA + head SHA` 분석 후보 |
| snapshot materialization | request를 clone한 뒤 merge-base 결과와 계산 정책을 포함해 append-only로 확정한 불변 입력. API에서는 `snapshotId`로 식별한다. |
| analysis revision | snapshot materialization, analyzer/model/policy version 조합으로 생성한 불변 report |
| finding | reviewer가 확인할 문제 후보와 priority, confidence, evidence의 묶음 |
| evidence | diff line, file, symbol, commit, history 또는 dependency edge처럼 주장을 검증할 근거 |
| partial | 일부 분석이 누락됐지만 coverage와 limitation을 함께 제공하는 사용 가능한 결과 |
| stale | report의 base/head가 현재 PR의 관측 base/head와 달라진 파생 상태 |
| superseded | 더 최신 snapshot의 run으로 대체된 queued/running run |
| LNB | Files, Findings, Outline, Impact를 제공하는 왼쪽 navigation |
| FNB | Evidence, Git graph, Impact, Tests를 제공하는 하단 dock |

## 3. 범위

### 3.1 MVP

- 단일 사내 GHES instance와 등록 repository
- OIDC로 인증하는 사내 사용자
- outbound polling과 사용자 manual refresh
- run별 isolated clone과 append-only snapshot materialization
- deterministic analyzer, model review, evidence verification
- browser review workspace와 snapshot-bound Chat
- PostgreSQL 기반 metadata와 durable job lease
- PVC 또는 S3-compatible artifact storage
- 동일 OCI image를 사용하는 server/worker
- Helm chart 기반 Kubernetes 배포와 운영

### 3.2 제외

- VS Code extension, browser extension, native application
- browser local storage에서 Git clone 또는 source 분석
- 대상 repository의 GitHub Actions/workflow 설치
- webhook을 전제로 한 inbound trigger
- GitHub Check, status, review comment 자동 게시
- PR source의 build, test, hook, package script 실행
- public signup, billing, 외부 고객용 SaaS multi-tenancy
- LLM 단독 판단에 의한 merge 승인 또는 차단

## 4. 사용자와 권한

| 사용자 | 허용 작업 |
|---|---|
| Reviewer/PR author | 허용된 repository/PR 조회, report 탐색, refresh 요청, 개인 Chat |
| Service administrator | Chat account/model/effort 정책, GHES access-token connection, repository/grant/polling, analysis profile, retention 설정 |
| Operator | 배포, metric/audit metadata 조회, backup/restore, 장애 복구 |

| ID | 수준 | 요구사항 |
|---|---|---|
| REQ-AUTH-001 | 필수 | 모든 browser route와 API는 인증된 server session을 요구한다. 운영은 application OIDC를 기본으로 하며 외부 OIDC endpoint가 없는 private pilot은 Local account를 사용할 수 있다. |
| REQ-AUTH-002 | 필수 | server는 요청마다 사용자의 repository grant를 검증한다. |
| REQ-AUTH-003 | 필수 | browser가 전달한 owner/name/path를 신뢰하지 않고 server-side ID로 scope를 결정한다. |
| REQ-AUTH-004 | 필수 | administrator와 operator 기능은 일반 reviewer와 분리한다. |
| REQ-AUTH-005 | 필수 | source, diff, Chat 원문을 audit log에 기록하지 않는다. |
| REQ-AUTH-006 | 조건부 | Local account mode는 scrypt password hash, 12자 이상의 비밀번호, 계정 존재 여부를 숨기는 오류, 로그인 실패 제한, HttpOnly session cookie와 로그아웃을 제공한다. |
| REQ-AUTH-007 | 필수 | 시스템관리자는 일반사용자와 시스템관리자 Local account를 생성하고 role, 활성 상태, tenant membership, repository grant와 비밀번호를 관리할 수 있다. 자신의 관리자 role 또는 접근 권한은 낮출 수 없다. |

## 5. GitHub 연결과 변경 감지

| ID | 수준 | 요구사항 |
|---|---|---|
| REQ-GH-001 | 필수 | 시스템 관리자는 승인된 service identity의 GHES access token을 connection으로 등록하며 token 권한은 대상 private repository의 Metadata, Contents와 Pull requests read에 필요한 최소 범위로 제한한다. |
| REQ-GH-002 | 필수 | GHES access token은 deployment master key로 암호화해 저장하고 API header와 ephemeral Git credential helper에서만 복호화해 사용한다. Browser response, clone URL, Git config, job payload와 log에 원문이나 ciphertext를 넣지 않는다. |
| REQ-GH-003 | 필수 | scheduler는 registered repository만 polling한다. |
| REQ-GH-004 | 필수 | open PR과 base/head SHA 변화를 browser가 닫혀 있어도 감지한다. |
| REQ-GH-005 | 필수 | active PR과 idle/draft repository에 서로 다른 poll interval과 backoff를 적용한다. |
| REQ-GH-006 | 필수 | pagination, conditional request와 rate-limit reset을 처리한다. |
| REQ-GH-007 | 필수 | 사용자는 현재 PR에 대해 우선순위가 높은 manual refresh를 요청할 수 있다. |
| REQ-GH-008 | 필수 | 같은 PR의 동시 refresh는 하나의 poll/snapshot 요청으로 합친다. |
| REQ-GH-009 | 필수 | GHES 장애나 quota 부족을 분석 없음으로 표시하지 않고 지연 사유와 마지막 성공 시각을 제공한다. |
| REQ-GH-010 | 후속 | webhook은 polling을 대체하지 않는 optional accelerator로만 추가할 수 있다. |
| REQ-GH-011 | 제외 | MVP는 GitHub에 report, comment, Check 또는 status를 쓰지 않는다. |
| REQ-GH-012 | 필수 | poll은 PR의 현재 base branch tip을 authoritative source에서 관측하고 base 또는 head가 바뀌면 새 snapshot request를 만든다. |
| REQ-GH-013 | 필수 | draft PR도 polling과 자동 분석 대상에 포함하되 idle tier를 기본으로 하며 관리자가 자동 분석을 끌 수 있다. Manual refresh는 항상 허용한다. |
| REQ-GH-014 | 필수 | 시스템 관리자는 GHES connection을 등록·검증·회전·비활성화하고 token expiry, 마지막 검증, rate-limit과 401/403 상태를 확인한다. |
| REQ-GH-015 | 필수 | 시스템 관리자는 token으로 실제 조회 가능한 repository만 tenant에 등록하고 automatic polling, hot/active/idle/draft interval과 Poll now trigger를 관리한다. |
| REQ-GH-016 | 필수 | GHES token의 외부 repository read 권한과 application의 tenant membership/repository grant를 별도 경계로 검사한다. |
| REQ-GH-017 | 필수 | 시스템 관리자는 repository별 user/group grant를 browser UI와 API에서 조회·부여·회수할 수 있다. |

## 6. Snapshot과 Git workspace

| ID | 수준 | 요구사항 |
|---|---|---|
| REQ-SNAP-001 | 필수 | poller는 repository/PR/base/head로 snapshot request를 deduplicate한다. |
| REQ-SNAP-002 | 필수 | canonical PR diff는 merge-base와 head의 three-dot 의미로 계산한다. |
| REQ-SNAP-003 | 필수 | merge simulation 결과와 canonical diff를 별도 artifact로 취급한다. |
| REQ-SNAP-004 | 필수 | 각 analysis run은 object DB, refs, config, worktree를 공유하지 않는 독립 clone을 사용한다. |
| REQ-SNAP-005 | 필수 | clone 경로는 server가 만든 opaque run ID만으로 구성한다. |
| REQ-SNAP-006 | 필수 | shallow/partial clone 후 merge-base가 없으면 제한 내에서 단계적으로 deepen한다. |
| REQ-SNAP-007 | 필수 | 정확한 merge-base를 얻지 못하면 추정 diff를 만들지 않고 report를 partial로 표시한다. |
| REQ-SNAP-008 | 필수 | submodule, LFS smudge, Git hook과 repository command를 자동 실행하지 않는다. |
| REQ-SNAP-009 | 필수 | 성공, 실패, 취소 후 workspace를 삭제하고 worker in-process cleanup이 자기 pod의 잔여물을 정리한다. |
| REQ-SNAP-010 | 필수 | 같은 snapshot materialization과 analysis key의 완료 결과는 재사용한다. |
| REQ-SNAP-011 | 필수 | changed file과 evidence context만 byte budget 안에서 versioned source artifact로 보존하고 전체 clone은 보존하지 않는다. |
| REQ-SNAP-012 | 필수 | worker는 merge-base SHA, `exact|unresolved` resolution과 계산 정책을 가진 append-only snapshot materialization을 생성한다. |
| REQ-SNAP-013 | 필수 | unresolved 뒤 exact 결과를 얻으면 새 materialization을 만들고 기존 report/Chat의 snapshot 의미를 변경하지 않는다. |
| REQ-SNAP-014 | 필수 | 같은 request와 계산 정책에서 서로 다른 exact merge-base가 나오면 publish하지 않고 integrity failure와 audit event를 기록한다. |
| REQ-SNAP-015 | 필수 | base tip 변경은 새 snapshot request와 전체 분석을 생성하며 이전 report를 stale로 표시한다. |

## 7. 분석과 report

| ID | 수준 | 요구사항 |
|---|---|---|
| REQ-AN-001 | 필수 | changed file, rename, binary/generated/vendor, hunk와 old/new line mapping을 생성한다. |
| REQ-AN-002 | 필수 | 우선 지원 언어에서 base/head symbol과 changed symbol을 추출한다. |
| REQ-AN-003 | 필수 | 가능한 범위에서 direct reference/import, history/blame, related test 후보를 생성한다. |
| REQ-AN-004 | 필수 | correctness, security, compatibility, testing 관점의 review를 지원한다. |
| REQ-AN-005 | 필수 | model은 필요한 change pack과 bounded tool만 받으며 shell/network/arbitrary path tool을 받지 않는다. |
| REQ-AN-006 | 필수 | verifier는 line/symbol/reference 존재 여부와 새로 발생한 문제인지를 검사한다. |
| REQ-AN-007 | 필수 | 중복 finding을 합치고 직접 evidence가 없는 P3 finding을 허용하지 않는다. |
| REQ-AN-008 | 필수 | finding은 `P0..P3` priority와 `low|medium|high` confidence를 별도 필드로 가진다. |
| REQ-AN-009 | 필수 | report는 coverage, omission, analyzer/model version, snapshot identity를 표시한다. |
| REQ-AN-010 | 필수 | 일부 analyzer/model 실패 시 성공 결과를 보존한 partial report를 생성한다. |
| REQ-AN-011 | 필수 | 새 head가 감지되면 이전 queued/running run을 superseded하고 최신 run을 우선한다. |
| REQ-AN-012 | 제외 | worker는 repository의 build/test/package script를 실행하지 않는다. |
| REQ-AN-013 | 필수 | 분석은 file/byte/model-call/time budget을 가지며 초과 범위는 partial report의 limitation으로 표시한다. |
| REQ-AN-014 | 필수 | Report는 Commit Defender `AnalysisReport schema_version: 1`의 summary, grade, per-file summary, P0-P3와 category 의미를 versioned compatibility adapter로 계승한다. |
| REQ-AN-015 | 필수 | Deterministic analyzer와 model 결과는 하나의 canonical finding normalizer를 거치며 producer, rule, original priority와 검증 결과를 보존한다. |
| REQ-AN-016 | 필수 | Canonical finding은 title, problem, impact, recommendation, priority, category, confidence, anchor와 evidence를 가진다. |
| REQ-AN-017 | 필수 | Report의 `hasCriticalFindings`는 검증된 P3 존재 여부로 계산하며 merge 가능 여부나 GitHub blocking status로 사용하지 않는다. |
| REQ-AN-018 | 필수 | 변경되지 않은 code object의 파급 가능성은 changed-line finding과 분리된 impact section에 기록한다. |
| REQ-AN-019 | 필수 | Symbol/file/module/package 관계를 structure parent/children과 dependency uses/used-by 방향으로 조회할 수 있다. |
| REQ-AN-020 | 필수 | 관계 edge는 relation kind, direct/transitive, mergeBase/head의 added/removed/unchanged 상태, confidence와 source evidence를 가진다. |

Priority와 category는 다음 contract를 사용한다.

| Priority | 표시 | 의미 | 추가 규칙 |
|---|---|---|---|
| P3 | 치명 | 보안, data loss, build 불가 또는 치명 오류 | high confidence와 직접 evidence 필수 |
| P2 | 결함 가능성 | merge 전에 reviewer가 확인할 문제 | 직접 evidence 필수 |
| P1 | 개선 | 선택적 개선 또는 정보 | advisory |
| P0 | 칭찬 | 검토할 가치가 있는 좋은 변경 | positive/file-level observation, 조치 불필요 |

Finding category enum은 Commit Defender category를 포함한 `correctness | security | compatibility | testing | maintenance | optimization | review-history | setting`이다. Specialist 관점과 category는 서로 다른 축이다. Grade enum은 `exceptional | proficient | adequate | insufficient | critical`이며 report 요약 신호일 뿐 merge 판정이 아니다.

## 8. Browser review workspace

| ID | 수준 | 요구사항 |
|---|---|---|
| REQ-UI-001 | 필수 | 첫 사용자 화면은 marketing page가 아닌 PR worklist 또는 review workspace다. |
| REQ-UI-002 | 필수 | review route는 repository, PR, analysis revision을 주소로 복원할 수 있다. |
| REQ-UI-003 | 필수 | desktop은 Header/LNB/Main/Chat/FNB topology를 제공한다. |
| REQ-UI-004 | 필수 | LNB는 Files, Findings, Outline, Impact view를 제공한다. |
| REQ-UI-005 | 필수 | Main은 split/unified diff, file/symbol/commit view와 maximized tool view를 제공한다. |
| REQ-UI-006 | 필수 | Chat은 desktop에서 persistent right dock이며 Findings와 상호 배타적인 tab이 아니다. |
| REQ-UI-007 | 필수 | FNB는 Evidence, Git graph, Impact, Tests를 제공하며 각 tab은 빈 placeholder가 아닌 현재 snapshot의 실제 데이터를 표시한다. |
| REQ-UI-008 | 필수 | finding 선택은 diff anchor, FNB evidence, Chat scope를 원자적으로 동기화한다. |
| REQ-UI-009 | 필수 | stale/partial/running/failed와 마지막 성공 report를 시각적으로 구분한다. |
| REQ-UI-010 | 필수 | diff, tree와 graph는 큰 입력에서도 virtualization 또는 pagination을 사용한다. |
| REQ-UI-011 | 필수 | keyboard navigation, focus, tooltip, contrast와 screen-reader label을 제공한다. |
| REQ-UI-012 | 필수 | browser storage에는 panel size, tab, theme, locale 같은 비민감 preference만 저장한다. |
| REQ-UI-013 | 필수 | source, diff, finding, Chat 원문과 credential을 localStorage/IndexedDB에 저장하지 않는다. |
| REQ-UI-014 | 필수 | 기준 시각 구조는 `visuals/review-workspace.html`과 preview를 따른다. |
| REQ-UI-015 | 필수 | UI는 report state와 merge simulation state를 별도로 표시한다. |
| REQ-UI-016 | 필수 | Main의 읽기 폭이 부족하면 split diff를 unified로 자동 전환하고 이유를 표시한다. |
| REQ-UI-017 | 필수 | run state와 UI badge mapping을 고정하고 stale을 별도 파생 상태로 표시한다. |
| REQ-UI-018 | 필수 | Report, finding, evidence, file/line, symbol, commit과 relation은 analysis revision에 고정된 공유 가능한 내부 deep link를 가진다. |
| REQ-UI-019 | 필수 | File/line evidence는 등록된 GHES origin과 exact commit SHA로 만든 external permalink를 제공한다. |
| REQ-UI-020 | 필수 | 사용자는 현재 report/finding/evidence/object link를 복사하고 권한이 있으면 GHES 원본을 새 tab에서 열 수 있다. |
| REQ-UI-021 | 필수 | Impact view는 선택 object를 중심으로 structure의 parent/children과 dependency의 uses/used-by를 명확히 구분한다. |
| REQ-UI-022 | 필수 | Relation graph는 direct 관계를 먼저 표시하고 transitive depth, cycle, truncation과 분석 coverage를 시각적으로 구분한다. |
| REQ-UI-023 | 필수 | Relation node 선택은 source definition, incoming/outgoing reference 목록과 관련 finding/test를 같은 revision에서 갱신한다. |

| Run state | UI badge | 표시 내용 |
|---|---|---|
| requested | 대기 | queue 상태와 대기 시간 |
| preparing, analyzing, persisting | 진행 중 | 현재 stage와 elapsed time |
| completed | 완료 | coverage와 완료 시각 |
| partial | 부분 완료 | omission 목록 필수 |
| failed | 실패 | 실패 stage, request ID와 retry 가능 여부 |
| superseded | 대체됨 | 최신 run link |
| cancelled | 취소됨 | 취소 주체와 시각 |

## 9. Chat

| ID | 수준 | 요구사항 |
|---|---|---|
| REQ-CHAT-001 | 필수 | Chat session은 한 사용자와 한 analysis revision에 고정한다. |
| REQ-CHAT-002 | 필수 | 새 head report가 생겨도 기존 대화의 snapshot을 자동 변경하지 않는다. |
| REQ-CHAT-003 | 필수 | 답변의 기술적 주장에는 file/line/symbol/commit/artifact citation을 연결한다. |
| REQ-CHAT-004 | 필수 | 허용 tool은 report, snapshot file, symbol, history, impact, test, diff 조회로 제한한다. |
| REQ-CHAT-005 | 필수 | 질문과 repository text를 untrusted input으로 취급한다. |
| REQ-CHAT-006 | 필수 | Chat stream이 끊기면 완료 message를 재조회하거나 명시적으로 재시도할 수 있다. |
| REQ-CHAT-007 | 필수 | 시스템 관리자는 여러 Chat account를 server-side registry에 등록·검증·회전·비활성화하고 tenant/user/group assignment를 설정한다. Credential과 refresh 결과는 deployment master key로 암호화하며 host home 자동 mount와 사용자 local CLI credential의 암묵 재사용을 금지한다. |
| REQ-CHAT-008 | 필수 | Chat은 사용자별 concurrency, rate, tool-turn과 timeout limit을 강제하고 초과 시 typed `429` 또는 limit error를 반환한다. |
| REQ-CHAT-009 | 필수 | Interactive model이 비활성화되면 Chat 가용 상태를 명시하고 message를 저장하기 전에 typed `503`을 반환한다. Report 문구를 합성 답변처럼 재사용하지 않으며 fixture GHES mode도 model 호출 여부를 바꾸지 않는다. |
| REQ-CHAT-010 | 필수 | 일반 사용자는 자신에게 할당된 enabled Chat account, 해당 account에 허용된 model과 reasoning effort를 선택할 수 있다. |
| REQ-CHAT-011 | 필수 | Chat session은 `user + analysis revision + account + model + reasoning effort + credential version`을 생성 시 고정한다. Account/model/effort 변경은 기존 session 수정이 아니라 새 session을 만든다. |
| REQ-CHAT-012 | 필수 | 시스템 관리자는 account별 model ID, 지원 effort 목록, 기본/최대 effort, account/user concurrency와 기간별 사용 한도를 관리한다. |
| REQ-CHAT-013 | 필수 | Server는 account assignment와 model/effort capability를 session 생성과 message 전송 시 다시 검사하고 허용되지 않은 조합을 provider 호출 전에 거부한다. |
| REQ-CHAT-014 | 조건부 | ChatGPT/Codex account token을 다중 사용자 service에서 보관·갱신하는 방식은 OpenAI와 조직 정책이 허용하는 인증 contract를 확인한 경우에만 활성화한다. 승인되지 않은 account로 자동 fallback하지 않는다. |

## 10. API, data와 상태

| ID | 수준 | 요구사항 |
|---|---|---|
| REQ-DATA-001 | 필수 | PostgreSQL에 users/tenants/memberships, GHES instances/encrypted credentials, repositories/grants/poll policies, Chat accounts/assignments/capabilities, PR, snapshot, run, job, report와 session metadata를 저장한다. |
| REQ-DATA-002 | 필수 | bounded source/diff/index/report artifact는 checksum과 schema version을 가진 별도 storage object로 저장한다. |
| REQ-DATA-003 | 필수 | analysis run은 `requested|preparing|analyzing|persisting|completed|partial|failed|superseded|cancelled` 상태를 가진다. |
| REQ-DATA-004 | 필수 | job claim은 lease와 heartbeat를 사용해 executor 종료 후 복구할 수 있다. |
| REQ-DATA-005 | 필수 | write API는 idempotency key 또는 domain unique key로 중복 요청을 방지한다. |
| REQ-DATA-006 | 필수 | Poll/snapshot/analysis progress와 Chat token은 SSE로 전달하고 최종 상태는 REST로 다시 조회할 수 있다. |
| REQ-DATA-007 | 필수 | report와 snapshot materialization은 retention 만료 전까지 immutable하다. |
| REQ-DATA-008 | 필수 | 비동기 refresh는 operation resource로 조회하며 중복 요청은 같은 active operation을 반환한다. |
| REQ-DATA-009 | 필수 | PR 범위 event stream은 poll, snapshot과 analysis 변화를 전달한다. |
| REQ-DATA-010 | 필수 | 상태 event는 durable log에 append하고 broker 없이 server replica 간 fan-out과 재연결 재생을 지원한다. |
| REQ-DATA-011 | 필수 | job type별 executor, priority, retry 상한, backoff와 terminal failure 처리를 정의한다. |
| REQ-DATA-012 | 필수 | lease와 heartbeat의 claim, renew와 expiry 판정은 DB clock을 사용한다. |
| REQ-DATA-013 | 필수 | artifact는 attempt staging과 checksum 검증 후 atomic commit하며 commit된 object를 재작성하지 않는다. |
| REQ-DATA-014 | 필수 | Report/finding/code object/relation/evidence는 immutable revision 안에서 안정적인 opaque ID를 가져 deep link와 export에서 재사용한다. |
| REQ-DATA-015 | 필수 | Relationship graph와 report export는 schema version, completeness, producer와 input snapshot identity를 포함한다. |

## 11. 보안과 privacy

| ID | 수준 | 요구사항 |
|---|---|---|
| REQ-SEC-001 | 필수 | OIDC/DB secret과 GHES·Chat credential을 암호화하는 master key는 runtime Secret으로 주입한다. Admin이 등록한 GHES·Chat credential은 이 key로 암호화한 DB row로 보존한다. |
| REQ-SEC-002 | 필수 | secret을 image layer, repository와 plain Helm values에 넣지 않는다. |
| REQ-SEC-003 | 필수 | server와 worker egress는 각 workload가 실제 사용하는 GHES, model, PostgreSQL, artifact backend와 필수 infrastructure로 제한한다. |
| REQ-SEC-004 | 필수 | model tool handler가 repository/snapshot/path scope를 server-side에서 강제한다. |
| REQ-SEC-005 | 필수 | rendered Markdown/code를 sanitize하고 raw HTML과 unsafe URL을 차단한다. |
| REQ-SEC-006 | 필수 | DB와 persistent artifact는 조직 정책에 따라 at-rest encryption과 backup을 적용한다. |
| REQ-SEC-007 | 필수 | log/metric/trace label에 source, diff, prompt, token, repository path를 넣지 않는다. |
| REQ-SEC-008 | 필수 | report/chat/source retention과 사용자 삭제 범위를 설정하며 Chat은 참조 report보다 오래 보존하지 않는다. |
| REQ-SEC-009 | 필수 | Chat account credential은 Server만, GHES credential은 polling Server와 clone Worker만, batch model credential은 Worker만 복호화할 수 있다. |
| REQ-SEC-010 | 필수 | CSP, referrer/content-type/permissions 보안 header와 외부 resource 차단 정책을 적용한다. HSTS는 ingress/platform 정책을 따른다. |
| REQ-SEC-011 | 조건부 | reverse proxy identity는 signed assertion 검증, client identity header 제거와 ingress network 제한이 함께 적용될 때만 신뢰한다. |
| REQ-SEC-012 | 필수 | audit event catalogue를 정의하고 source/prompt 원문 없이 actor/action/resource/outcome/request/time metadata만 기록한다. |
| REQ-SEC-013 | 필수 | External source link는 registered GHES origin, repository와 exact SHA로만 server-side 생성하고 credential, arbitrary URL과 open redirect를 허용하지 않는다. |

## 12. Container와 Kubernetes 배포

| ID | 수준 | 요구사항 |
|---|---|---|
| REQ-OPS-001 | 필수 | `serve`, `worker`, `migrate`, `retention` command를 하나의 immutable OCI image로 제공한다. |
| REQ-OPS-002 | 필수 | image는 non-root, read-only root filesystem과 stdout/stderr logging을 지원한다. |
| REQ-OPS-003 | 필수 | image에 source revision label, dependency manifest와 SBOM을 포함한다. |
| REQ-OPS-004 | 필수 | Helm chart는 server/worker Deployment, Service, Ingress, migration Job과 retention CronJob을 관리한다. |
| REQ-OPS-005 | 필수 | chart는 ServiceAccount/security context, ConfigMap, Secret reference, NetworkPolicy와 PDB를 제공한다. |
| REQ-OPS-006 | 필수 | artifact storage는 RWX PVC를 기본 contract로 하며 cluster가 지원하지 않으면 object storage를 선택할 수 있다. |
| REQ-OPS-007 | 필수 | clone workspace는 기본 `emptyDir`을 사용하고 persistent scratch가 필요하면 pod별 generic ephemeral RWO PVC를 사용한다. |
| REQ-OPS-008 | 필수 | existing PostgreSQL endpoint/Secret을 기본으로 사용하며 application chart가 DB를 암묵적으로 설치하지 않는다. |
| REQ-OPS-009 | 필수 | image repository/tag/digest, replica, resource, ingress, storage class/size와 secret name을 values로 설정한다. |
| REQ-OPS-010 | 필수 | migration은 idempotent Helm pre-install/pre-upgrade Job과 DB advisory lock을 사용하고 current/previous application과 호환된다. |
| REQ-OPS-011 | 필수 | worker는 SIGTERM 후 새 claim을 멈추고 완료 또는 lease 반환 후 종료한다. |
| REQ-OPS-012 | 필수 | startup은 config/schema compatibility, liveness는 process, readiness는 HTTP와 핵심 DB 처리 가능 여부를 검사하고 artifact/GHES/model 장애와 분리한다. |
| REQ-OPS-013 | 필수 | operator는 Helm upgrade/rollback, PVC backup/restore와 orphan cleanup runbook을 가진다. |
| REQ-OPS-014 | 조건부 | replica가 2개 이상이면 scheduler leader election과 PDB를 검증한다. |
| REQ-OPS-015 | 조건부 | HPA는 queue age/worker utilization 같은 의미 있는 metric을 기준으로 설정한다. |
| REQ-OPS-016 | 필수 | artifact, GHES와 model 의존성 상태는 별도 health endpoint와 기능별 degraded 응답으로 표시한다. |
| REQ-OPS-017 | 필수 | retention CronJob이 persistent artifact orphan, 만료 report/chat/source와 event log를 batch로 정리한다. |
| REQ-OPS-018 | 조건부 | 선택한 PVC 또는 object backend는 같은 artifact/checksum contract를 만족하고 backend별 config와 egress를 검증한다. |
| REQ-OPS-019 | 조건부 | workspace PVC mode는 Deployment pod마다 별도 generic ephemeral claim을 생성한다. |
| REQ-OPS-020 | 필수 | backup은 DB restore point가 artifact snapshot보다 늦지 않게 만들고 복구 후 reconcile 절차를 수행한다. |
| REQ-OPS-021 | 필수 | application startup validation과 Helm template validation이 Chat retention이 report retention을 넘지 않게 검사한다. |

## 13. 성능과 신뢰성

| ID | 수준 | 요구사항 |
|---|---|---|
| REQ-NFR-001 | 필수 | poll은 hot/active/idle tier와 request budget을 사용한다. 초기 목표는 60초/5분/15분이며 실제 값은 GHES 측정 결과로 확정한다. |
| REQ-NFR-002 | 필수 | manual refresh는 10초 이내 조회를 시작하거나 지연 사유를 표시한다. |
| REQ-NFR-003 | 필수 | 100 files/5,000 changed lines 이하의 일반 PR은 5분 안에 completed 또는 partial 결과를 만든다. |
| REQ-NFR-004 | 필수 | streaming endpoint를 제외한 metadata API p95는 정상 부하에서 500ms 이하다. |
| REQ-NFR-005 | 필수 | worker crash 후 lease 만료로 job을 재개하고 완료 artifact를 재사용한다. |
| REQ-NFR-006 | 필수 | run workspace는 종료 직후 또는 같은 worker의 startup/periodic cleanup으로 제거하고 persistent orphan은 retention CronJob이 정리한다. |
| REQ-NFR-007 | 필수 | poll lag, queue age, clone time/bytes, analyzer coverage, model latency/error, cleanup failure를 관측한다. |
| REQ-NFR-008 | 필수 | DB/GHES/model/storage 장애는 liveness restart loop를 만들지 않으며 영향 범위에 맞는 error/degraded 상태를 제공한다. |

## 14. 검수 시나리오

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| AC-01 | 새 PR | webhook/workflow 없이 polling으로 snapshot materialization과 completed/partial report를 생성한다. |
| AC-02 | base/head 변경 | 기존 report는 stale로 남고 새 snapshot/run이 우선된다. |
| AC-03 | 동시 refresh | 동일 snapshot run이 하나만 생성된다. |
| AC-04 | 일부 analyzer 실패 | 성공 evidence를 보존하고 omission이 있는 partial report를 제공한다. |
| AC-05 | finding 선택 | Main anchor, FNB evidence와 Chat scope가 같은 revision으로 맞춰진다. |
| AC-06 | Chat citation | 현재 snapshot의 file/line/symbol/history로 이동한다. |
| AC-07 | 권한 없는 ID 요청 | resource 존재 여부를 노출하지 않고 거부한다. |
| AC-08 | worker pod 종료 | DB clock lease로 재개하고 해당 pod의 workspace 또는 generic ephemeral claim을 정리한다. |
| AC-09 | Helm install | migration, server, worker, retention CronJob, Ingress와 artifact storage가 준비되고 로그인할 수 있다. |
| AC-10 | rolling update | 요청은 지속되고 job은 완료되거나 lease로 인계된다. |
| AC-11 | backup/restore | DB restore point 이후 artifact snapshot을 복구하고 reconcile하면 missing artifact는 unavailable, 미참조 artifact는 retention 대상으로 분류된다. |
| AC-12 | 민감정보 검사 | log, image, browser storage에 secret/source/Chat 원문이 없다. |
| AC-13 | manual refresh | operation ID를 받고 poll 시작, unchanged/changed와 analysis 진행을 순서대로 확인한다. |
| AC-14 | base branch 전진 | 새 snapshot/run이 생성되고 이전 report가 stale로 표시된다. |
| AC-15 | dependency 장애 | 열린 UI는 유지되고 영향 API가 typed error/degraded 상태를 표시하며 pod가 liveness restart loop에 빠지지 않는다. |
| AC-16 | server replica 두 개 | 어느 replica에 연결해도 operation/analysis event를 수신하고 재연결 시 누락 상태를 복원한다. |
| AC-17 | retry 상한 초과 | job이 terminal failure로 이동하고 operator가 원인을 확인해 재실행할 수 있다. |
| AC-18 | retention 만료 | report/chat/source와 DB reference가 정책 순서에 따라 삭제되고 active resource는 보존된다. |
| AC-19 | web 보안 | CSP와 보안 header가 적용되고 외부 image/script와 unsafe Markdown이 차단된다. |
| AC-20 | artifact 재시도 | 동시/재시도 attempt 중 하나만 canonical artifact를 commit하고 checksum이 같은 결과는 재사용한다. |
| AC-21 | Commit Defender fixture | `AnalysisReport schema_version: 1` fixture의 summary/grade/per-file/finding과 원문 provenance가 compatibility 규칙대로 정규화된다. |
| AC-22 | report 바로가기 | 복사한 report/finding/evidence/object link가 로그인 후 같은 analysis revision과 selection을 연다. |
| AC-23 | GHES 바로가기 | File/line link가 exact SHA의 GHES source를 열며 path/line이 없거나 권한이 없으면 안전한 fallback을 표시한다. |
| AC-24 | 객체 관계 탐색 | 선택 symbol의 parent/children과 uses/used-by, edge evidence와 PR 전후 상태를 탐색하고 transitive omission을 확인한다. |
| AC-25 | Chat account 선택 | 관리자 assignment에 따라 사용자별 account 목록이 분리되고 선택한 account/model/effort가 새 session에 고정된다. |
| AC-26 | Chat 설정 변경 | 대화 중 account/model/effort를 바꾸면 기존 대화는 유지되고 새 session이 생성된다. |
| AC-27 | GHES token 등록 | 관리자가 access token을 등록·검증해 조회 가능한 repository만 tenant에 등록하며 credential 원문이 노출되지 않는다. |
| AC-28 | Polling 관리 | repository별 interval/disabled 설정과 Poll now가 적용되고 401/403/429 상태가 독립적으로 표시된다. |
| AC-29 | 이중 권한 경계 | GHES token 권한과 application repository grant 중 하나라도 없으면 해당 경계에서 접근이 차단된다. |

## 15. 구현 전 확정 항목

| ID | 항목 |
|---|---|
| DEC-001 | 대상 GHES exact version, access-token 종류와 최소 read scope |
| DEC-002 | OIDC integration 방식과 group/role mapping |
| DEC-003 | 우선 지원 언어 두 개 |
| DEC-004 | registered repository/open PR 규모와 허용 poll lag |
| DEC-005 | approved model endpoint와 source retention 정책 |
| DEC-006 | PostgreSQL 운영 주체와 backup SLO |
| DEC-007 | artifact storage class의 RWX 지원 여부 또는 object storage 사용 |
| DEC-008 | workspace `emptyDir` quota와 generic ephemeral RWO 사용 조건 |
| DEC-009 | report/Chat retention 기간 |
| DEC-010 | browser/viewport 지원 범위 |
| DEC-011 | registry, scan/sign, Helm promotion 기준 |
| DEC-012 | GHES rate-limit 활성 여부, 실제 한도와 conditional request 처리 |
| DEC-013 | Fork PR의 MVP 지원 여부와 base repository pull-ref 사용 정책 |
| DEC-014 | Poll 규모가 scheduler sharding을 요구하는 기준 |
| DEC-015 | Analysis/Chat/workspace resource budget 초기값 |
| DEC-016 | Audit 조회를 제품 UI 또는 외부 로그 시스템 중 어디에 제공할지 |
| DEC-017 | ChatGPT account를 server registry에서 보관·갱신하는 방식에 대한 OpenAI/조직 승인 여부 |
| DEC-018 | Chat account별 허용 model/effort capability와 사용자·account quota 정책 |
| DEC-019 | GHES token service identity, 만료/rotation 주기와 repository별 polling interval 범위 |

## 16. 요구사항 추적 기준

세부 task mapping의 정본은 `implementation-plan.md`다. 이 표는 요구사항 group이 누락되지 않도록 milestone ownership만 정의한다.

| 요구사항 group | 주 milestone | 검증 계층 |
|---|---|---|
| `REQ-AUTH-*` | M1, M4 | authorization/security integration |
| `REQ-GH-*` | M0-00, M1 | GHES smoke/contract |
| `REQ-SNAP-*` | M0-00, M2 | Git fixture/resilience |
| `REQ-AN-*` | M3 | analyzer/model/verifier integration |
| `REQ-UI-*` | M0, M4 | Playwright/accessibility/visual |
| `REQ-CHAT-*` | M4 | API/SSE/browser E2E |
| `REQ-DATA-*` | M2 | PostgreSQL/artifact contract |
| `REQ-SEC-*` | M1-M5 | negative/security/redaction |
| `REQ-OPS-*` | M0, M5 | image/Helm/backup/rollout |
| `REQ-NFR-*` | M1-M5 | performance/load/resilience |
