# 제품 정의

## 제품

Git Code Reviewer는 사내 GitHub Enterprise Server의 PR을 중앙에서 분석하고, reviewer가 browser workspace에서 finding, diff, code history와 Chat evidence를 함께 조사하는 내부 웹서비스다.

## 사용자

- merge 전에 private PR을 검토하는 reviewer
- finding을 확인하고 새 commit 분석을 요청하는 PR author
- GitHub App, repository, model과 retention을 관리하는 service administrator
- Kubernetes release, storage, backup과 장애를 관리하는 operator

## 사용자 접점

사용자는 사내 HTTPS URL을 일반 browser로 연다. VS Code extension, browser extension과 native client는 제공하지 않는다. 첫 화면은 등록 repository의 PR worklist이며 각 PR에서 dense review workspace로 이동한다. GNB의 `사용 가이드`는 role별 시작 절차, GHES credential 최소 권한과 입력값, repository polling, Review Chat과 오류 진단을 설명한다.

Review workspace는 제공된 visual artifact의 구조를 따른다.

- LNB: Files, Commit Defender 호환 Findings/Report, Outline, Impact
- Main: split/unified diff와 maximized analysis tool
- Right dock: analysis revision/materialization-bound Chat
- FNB: Evidence, Git graph, History, Ownership, object relationships, Impact, Tests

## 동작

Server가 등록 repository를 outbound polling하고 authoritative base/head SHA 변화를 감지한다. Worker는 run별 isolated clone에서 append-only snapshot materialization과 canonical diff를 만든 뒤 Git/AST evidence, model review와 verifier를 거쳐 immutable report를 저장한다. Report는 Commit Defender의 summary, grade, per-file summary, P0-P3/category와 finding normalization을 계승하고 PR coverage, verified evidence와 impact graph를 확장한다. Browser는 clone하거나 source를 local storage에 보관하지 않는다.

MVP는 read-only다. 대상 repository에 GitHub Actions workflow를 설치하지 않고 webhook, Check, status와 review comment write-back을 요구하지 않는다. 일부 분석이 실패하면 성공 결과, coverage와 omission을 포함한 partial report를 제공한다.

## 운영 환경

서비스는 사내 Kubernetes에 배포한다.

- 하나의 immutable OCI image가 `serve`, `worker`, `migrate`, `retention` command를 제공한다.
- Helm chart가 Server/Worker Deployment, Service/Ingress, migration Job, retention CronJob과 security resource를 관리한다.
- PostgreSQL이 metadata와 durable job lease를 저장한다.
- report/diff artifact는 RWX PVC 또는 S3-compatible storage에 저장한다.
- clone workspace는 기본 `emptyDir`이며 필요할 때 pod별 generic ephemeral RWO PVC를 사용한다.
- image는 non-root/read-only rootfs를 지원하고 SBOM, scan/sign과 digest pinning을 적용한다.

대상 repository CI와 제품 release pipeline은 분리한다. 제품 자체의 delivery만 test, image build/scan/sign/push, chart lint/package, Helm upgrade 순서로 수행한다.

## 제품 원칙

- 모든 기술적 주장은 현재 snapshot의 evidence로 돌아갈 수 있어야 한다.
- Report/finding/evidence/object는 revision 고정 deep link와 exact-SHA GHES permalink를 제공한다.
- Code object의 structure parent/children과 dependency uses/used-by를 구분하고 relation evidence를 보여준다.
- Finding, diff, FNB와 Chat이 항상 같은 analysis revision을 가리킨다.
- 새 head가 생겨도 사용자가 읽는 이전 revision과 Chat을 조용히 바꾸지 않는다.
- Deterministic artifact와 model inference를 분리한다.
- 불완전한 분석, stale 상태와 omission을 명시한다.
- Private source와 credential은 승인된 server/storage/model 경계 안에 둔다.
- 최종 merge 판단은 사람이 담당한다.

## 기준 문서

- `.documents/blueprint.md`
- `.documents/requirements-specification.md`
- `.documents/functional-design.md`
- `.documents/ui-implementation-design.md`
- `.documents/implementation-plan.md`
- `.documents/design-review-resolution-2026-09-02.md`
- `.documents/handoff.md`
- `.documents/visuals/review-workspace.html`
- `.documents/visuals/review-workspace-preview.png`
- `.documents/visuals/git-code-reviewer.drawio`
