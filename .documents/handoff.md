# Git Code Reviewer - Agent Handoff

## 1. 현재 상태

- 최종 갱신: 2026-09-02
- branch: `main`
- 단계: 신규 기획/설계와 외부 검토 반영 완료, 구현 시작 전
- commit/push: 수행하지 않음
- 사용자 소유 `.vscode/` 변경: 건드리지 않음

기존 `git-code-reviewer`의 CI/CD 중심 상세 설계를 기준으로 삼지 않고 browser 기반 중앙 웹서비스로 다시 설계했다. Claude Code 검토 의견은 원문을 보존한 채 disposition 문서를 추가했고, 수용한 항목을 요구사항, 기능/UI 설계와 구현 계획에 반영했다.

## 2. 확정된 제품 방향

1. GUI는 VS Code/browser extension이 아니라 사내 HTTPS web application이다.
2. PR 변경 감지는 outbound polling과 manual refresh가 기본이며 대상 repository workflow나 webhook을 요구하지 않는다.
3. MVP는 GitHub Check/status/review comment를 게시하지 않는 read-only service다.
4. Poller는 repository/PR/base/head의 snapshot request를 deduplicate하고 Worker가 merge-base 정책을 포함한 append-only materialization을 만든다.
5. `unresolved` 뒤 `exact`는 새 materialization이며, base 또는 head 이동은 새 snapshot과 전체 재분석을 만든다.
6. Manual refresh는 operation resource를 반환하고 PR 범위 durable event stream으로 진행 상태를 제공한다.
7. PostgreSQL event log와 `LISTEN/NOTIFY`로 Server replica 간 fan-out하며 REST와 `Last-Event-ID`로 복원한다.
8. Worker는 batch review model을, Server는 interactive Chat model을 호출한다.
9. Application OIDC가 기본이며 proxy identity는 assertion/header/network 조건을 모두 만족할 때만 허용한다.
10. PostgreSQL이 metadata, operation/event와 durable job lease를 담당하며 별도 message broker는 두지 않는다.
11. Artifact backend는 RWX PVC 또는 object storage 중 `DEC-007`로 선택하고 같은 immutable/checksum contract를 구현한다.
12. Clone workspace는 `emptyDir`이 기본이며 persistent scratch는 pod별 generic ephemeral RWO PVC를 사용한다.
13. Retention CronJob이 persistent orphan과 만료 데이터를 정리하고 backup은 `Tdb <= Tartifact` pair와 restore reconcile을 사용한다.
14. Report core는 Commit Defender commit `47dabfea718729b0ccc685ae173857476040d6ea`의 `AnalysisReport v1`, grade, per-file summary, P0-P3/category와 normalizer fixture를 계승한다.
15. Report/finding/evidence/object는 revision 고정 내부 deep link와 registered GHES exact-SHA permalink를 제공한다.
16. Code object graph는 structure parent/children과 dependency uses/used-by를 분리하고 relation evidence와 PR 전후 변화를 표시한다.

## 3. 배포와 운영 결정

- 운영 대상은 사내 Kubernetes다.
- 하나의 immutable OCI image가 `serve`, `worker`, `migrate`, `retention` command를 제공한다.
- Server와 Worker는 같은 image를 쓰는 별도 Deployment다.
- Helm chart가 Deployment, Service, Ingress, pre-install/pre-upgrade migration Job, retention CronJob, artifact PVC와 security resource를 관리한다.
- Migration은 idempotent expand/contract 방식과 DB advisory lock을 사용한다.
- Startup은 config/schema, liveness는 process, readiness는 HTTP/core DB, dependency health는 artifact/GHES/model 상태를 확인한다.
- Worker는 SIGTERM 후 새 claim을 중단하고 job을 완료하거나 lease를 반환한다.
- 제품 release만 image build/scan/sign/push와 chart lint/package/upgrade를 수행하며 대상 repository CI와 분리한다.

## 4. UI 결정

다음 visual artifact는 수정하지 않은 시각 기준이다.

- `.documents/visuals/review-workspace.html`
- `.documents/visuals/review-workspace-preview.png`

Desktop topology는 two-row Header, LNB, Main, persistent right Chat과 compact FNB다. Finding 선택은 Main diff, FNB evidence와 Chat scope를 같은 revision으로 맞춘다. Findings 상단은 Commit Defender식 grade/summary/per-file summary를 제공한다. Main 폭이 880px 미만이면 split을 unified로 자동 전환하며 pinned split은 horizontal scroll을 사용한다. Canonical left side는 `mergeBase`, right side는 `head`다.

Impact maximize view는 Structure의 parent/children과 Dependencies의 uses/used-by를 구분한다. Node/edge 선택은 definition/reference와 relation evidence를 같은 revision에서 연다. Report, finding, evidence와 object에는 Copy Link가 있고 file/line은 exact SHA의 GHES 원본을 열 수 있다.

Browser storage에는 user 단위 layout preference와 최근 repository override 최대 10개만 둔다. Source, report, finding과 Chat content는 저장하지 않는다. Report state, stale 파생 상태와 merge simulation state는 서로 분리한다.

## 5. 문서 정본

다음 순서로 읽는다.

1. `PRODUCT.md`: 짧은 제품 정의
2. `.documents/blueprint.md`: 제품 경계와 기준 architecture
3. `.documents/requirements-specification.md`: `REQ-*`, `AC-*`, `DEC-*` 정본
4. `.documents/functional-design.md`: API/SSE/data/artifact/Helm contract 정본
5. `.documents/ui-implementation-design.md`: browser route/layout/selection 정본
6. `.documents/implementation-plan.md`: `M0-00`, M0-M5 task와 gate 정본
7. `.documents/design-review-resolution-2026-09-02.md`: 검토 finding disposition
8. `.documents/visuals/git-code-reviewer.drawio`: 논리/배포 diagram

검토 입력인 `.documents/design-review-2026-09-02.md`와 `.documents/design-review-remediation-2026-09-02.md`는 원문을 수정하지 않는다. `.documents/idea.md`와 Commit Defender 원본 draft는 배경 자료이며 충돌 시 위 정본이 우선한다.

## 6. 이번 반영의 핵심

| 영역 | 결과 |
|---|---|
| Review 처리 | finding별 accept/defer/correction과 contract 정본 규칙 추가 |
| Snapshot | mutable snapshot 대신 request와 append-only materialization으로 분리 |
| Refresh/SSE | operation resource, durable PR event와 replica fan-out 추가 |
| API/artifact | UI가 요구하는 resource와 snapshot/analysis artifact scope 보강 |
| Health/security | probe/dependency 분리, application OIDC, CSP/header, audit/egress 명시 |
| Kubernetes | generic ephemeral workspace, migration hook/lock, retention CronJob 추가 |
| Backup | DB restore point 뒤 artifact snapshot, restore reconcile 순서로 정정 |
| UI | two-row Header, breakpoint, mergeBase side와 run/merge state 고정 |
| 구현 계획 | 실제 환경 spike `M0-00`, M0-M5 task/완료 조건/추적표로 확장 |
| Report core | Commit Defender v1 compatibility adapter와 fixture parity, rich finding/impact schema 추가 |
| Navigation | Revision 고정 deep link, Markdown/JSON export와 exact-SHA GHES permalink 추가 |
| Object graph | Structure parent/children, dependency uses/used-by와 edge evidence 추가 |

Review Workspace HTML/PNG는 사용자 요청에 따라 수정하지 않았다.

## 7. 미확정 결정

결정 질문과 상태의 정본은 요구사항 명세의 `DEC-001`부터 `DEC-016`이다. 특히 GHES rate-limit, fork PR, scheduler sharding 기준, resource budget과 audit 조회 위치는 `DEC-012`부터 `DEC-016`에 남아 있다. 값이 확인되지 않으면 구현에서 임의 default를 정책처럼 확정하지 말고 typed config와 validation error로 남긴다.

## 8. 다음 작업

구현 시작점은 `M0`이 아니라 구현 계획의 `M0-00`이다.

1. 실제 GHES에서 App token의 REST/GraphQL/Git fetch와 pull-ref를 검증한다.
2. 대표 repository로 partial clone, exact fetch, merge-base/deepen/unresolved 경로를 측정한다.
3. GHES rate-limit과 repository/PR 규모로 poll tier budget을 계산한다.
4. Model data policy, application OIDC, PostgreSQL과 artifact/workspace storage를 검증한다.
5. Commit Defender baseline의 type/schema/normalizer/prompt fixture를 `packages/review-contract`로 옮길 경계를 확정한다.
6. 결과를 DEC에 기록한 뒤 M0 application/image/chart skeleton을 시작한다.

## 9. 주의사항

- 기존 문서의 Redis, SaaS tenant, Check publisher, CI worker, VM deployment 전제를 다시 도입하지 않는다.
- Snapshot request와 materialization을 하나의 mutable row로 합치지 않는다.
- GitHub installation token, model key와 DB credential을 browser/ConfigMap/plain values에 넣지 않는다.
- Browser local storage를 clone/report cache로 확장하지 않는다.
- Report revision과 Chat evidence를 최신 base/head로 자동 재해석하지 않는다.
- Commit Defender의 `blocking`을 GitHub merge gate로 해석하거나 VS Code/pre-commit 기능을 서버에 그대로 결합하지 않는다.
- External source link는 browser 입력 URL이 아니라 registered GHES origin과 exact SHA로만 만든다.
- 사용자 소유 `.vscode/`와 unrelated worktree 변경을 되돌리지 않는다.
