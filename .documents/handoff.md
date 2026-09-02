# Git Code Reviewer — Agent Handoff

## 1. 전달 목적

이 문서는 새 agent가 이전 대화 전체를 읽지 않아도 현재 설계 상태와 다음 작업을 이어갈 수 있도록 만든 작업 인계서다. 상세 내용은 이미 작성된 기준 문서를 참조하며 여기에는 결정 배경, 문서 우선순위, 작업 상태와 주의사항만 기록한다.

- 최종 갱신: 2026-09-02
- branch: `main`
- 현재 단계: 상세 설계 완료, 구현 시작 전
- commit/push: 수행하지 않음
- 기본 응답과 문서 언어: 한글 존댓말. 산출물의 문체는 목적에 맞춘다.

## 2. 대화에서 확정된 내용

대화의 진행 순서는 다음과 같다.

1. `.documents/idea.md`를 바탕으로 private GitHub PR review agent의 blueprint를 작성했다.
2. GitHub가 사내 대표 IP 외에는 접근할 수 없고 inbound 정책 제한이 있다는 조건을 반영했다. 기준 구조를 public webhook이 없는 outbound-only polling으로 변경했다.
3. 실제 application은 reviewer PC에서 동작하는 local app이 아니라 사내 VM 또는 Kubernetes에 중앙 배포하는 Web application으로 정했다. 사용자는 local browser에서 사내망/VPN으로 접속한다.
4. 화면과 architecture를 확인할 수 있도록 static HTML concept, PNG preview와 draw.io를 작성했다.
5. UI feedback을 반영해 Evidence trail을 compact FNB로 줄이고 LNB·Chat·FNB resize, persistent right Chat dock, LNB Findings, 실제 Git graph·History·Ownership·Impact·Related tests 범위를 설계에 추가했다.
6. draw.io에 public endpoint, local client/browser, CI/CD worker/build container, private server/node, application container와 data/platform service의 실행 공간을 구분했다.
7. Analysis Worker는 CI job이 아니라 private runtime에서 queue를 소비하는 별도 OCI image로 정했다. CI/CD는 build/test/scan/SBOM/sign/push/deploy만 담당한다.
8. 문서와 UI 설명은 한글을 기본으로 하고 `PR`, `diff`, `snapshot`, `finding`, `commit`, `merge-base`, `HEAD`, `Git graph`, `Worker`, `runtime`, `queue`, `Chat`, `Check`처럼 번역 시 의미가 흐려지는 용어는 English로 유지하기로 했다.
9. 상세 요건정의서, 기능설계서와 Commit Phase 기반 구현계획서를 작성했다.

## 3. 새 agent가 읽을 순서

다음 순서대로 읽으면 제품 의도에서 구현 단위까지 이어진다.

1. [원래 아이디어](./idea.md): 초기 제품 문제와 참고 기능
2. [요건정의서](./requirements-specification.md): 사용자, 사용 사례, 기능·Data·보안·비기능 요건, 검수 시나리오, `OD-*`
3. [기능설계서](./functional-design.md): 실행 공간, component, state, flow, data model, API/SSE/event/artifact, UI와 보안 control
4. [구현계획서](./implementation-plan.md): M0–M4, `CP-00`–`CP-33`, dependency, test, 완료 조건, release gate
5. [제품·시스템 blueprint](./blueprint.md): 전체 architecture와 설계 배경
6. [Review Workspace UI 구현 설계](./ui-implementation-design.md): panel 크기, responsive state, selection 동기화와 frontend 경계
7. [PRODUCT.md](../PRODUCT.md): 짧은 제품 정의

문서가 충돌하면 요건정의서의 고유 ID와 상태를 먼저 확인하고 기능설계서, 구현계획서 순으로 해석한다. Blueprint나 concept와 충돌을 발견하면 code에서 임의로 결정하지 말고 관련 문서를 함께 정정한다.

## 4. 현재 산출물

| 경로 | 역할 | 상태 |
|---|---|---|
| `.documents/requirements-specification.md` | 159개 고유 요건과 12개 검수 시나리오, 미정 결정 `OD-001`–`OD-012` | 작성 완료, 미commit |
| `.documents/functional-design.md` | component·state·flow·Data·REST/SSE·event·artifact·UI 상세 설계 | 작성 완료, 미commit |
| `.documents/implementation-plan.md` | 34개 Commit Phase `CP-00`–`CP-33`, gate·rollback·추적표 | 작성 완료, 미commit |
| `.documents/blueprint.md` | 제품·architecture 기준안 | 최신 결정 반영, 수정 상태 |
| `.documents/ui-implementation-design.md` | production UI contract | 작성 완료, untracked |
| `.documents/visuals/review-workspace.html` | interaction 가능한 UI concept | 작성 완료, untracked |
| `.documents/visuals/review-workspace-preview.png` | concept preview | 작성 완료, untracked |
| `.documents/visuals/git-code-reviewer.drawio` | 실행 공간과 Worker image/config 전달 diagram | 작성 완료, untracked |
| `README.md` | 기준 문서 link | 수정 상태 |
| `PRODUCT.md` | 제품 정의 | 작성 완료, untracked |

현재 repository에는 application 구현 code가 없다. 문서와 visual prototype만 준비된 상태다.

## 5. Architecture에서 바꾸면 안 되는 기준

```text
GitHub Cloud / GHES
        ▲
        │ outbound HTTPS only
        │ API · GraphQL · Git · Check/comment publish
        │ fixed corporate egress IP
        │
PR Poller / Snapshot Collector / Report Publisher
        │
        ▼
Queue → Analysis Worker → PostgreSQL / Object Storage / Model Gateway
        ▲
        │ private network or VPN
Reviewer Browser → Web/API
```

- 기준 배포에는 GitHub에서 workload로 향하는 inbound webhook endpoint, public load balancer 또는 firewall opening이 없다.
- Webhook은 정책상 허용될 때만 `internal-webhook` 또는 `dmz-relay` 선택 mode로 추가한다. MVP와 `CP-00`–`CP-28`은 webhook에 의존하지 않는다.
- snapshot은 `repository + PR number + base OID + merge-base OID + head OID`에 고정한다.
- `updated_at`은 조회 후보를 줄이는 hint일 뿐이다. snapshot/run 여부는 OID와 PR state transition으로 결정한다.
- 같은 snapshot/run과 Check/comment side effect를 중복 생성하지 않는다.
- 게시 직전에 current head와 diff anchor를 outbound GitHub API로 다시 검증한다.
- GitHub App 권한 축소나 제거는 짧은 authorization TTL, 민감 동작 재확인과 reconciliation으로 처리한다.
- private source, diff, prompt와 Chat 원문은 application log, trace, queue payload, Worker image layer에 넣지 않는다.
- model은 server가 고정한 tenant/repository/snapshot에서 typed read tool만 사용한다.

## 6. Worker image와 CI/CD 기억사항

Worker 관련 용어를 혼동하지 않는다.

- CI/CD worker 또는 runner: source를 checkout해 Worker image를 build/test/scan/SBOM/sign/push하고 immutable digest로 배포한다.
- Analysis Worker: private runtime에서 queue job을 소비하며 Git, parser, analyzer와 model pipeline을 실행한다.
- Worker image: compiled Worker와 pinned Git/parser/analyzer, CA bundle만 포함한다. secret, repository clone, runtime artifact는 포함하지 않는다.
- CI non-secret variable: registry path, image name, target platform, base digest, scan/sign policy, deployment environment, manifest path.
- CI identity: source read, registry push, keyless signing, 허용 environment의 digest update. runtime secret read 권한은 주지 않는다.
- Runtime ConfigMap: endpoint 이름, GitHub host allowlist, concurrency, timeout, CA path, feature flag.
- Runtime secret: GitHub App private key와 DB/queue/storage/model credential reference. Secret Manager 또는 workload identity로 주입한다.
- Git checkout과 worktree는 ephemeral Git volume에 둔다.
- Worker와 repository command sandbox는 default-deny egress를 적용하고 분리한다.

구체적인 file과 gate는 구현계획서 `CP-12`를 따른다. Diagram의 두 번째 page `Worker 이미지와 설정`에 정보의 저장·전달 위치가 표시되어 있다.

## 7. UI에서 유지할 contract

- Desktop topology는 `LNB / Main / Chat / FNB`다.
- LNB 기본 280px, 범위 220–420px.
- Chat 기본 380px, 범위 320–560px. 오른쪽 전용 dock에 항상 mount한다.
- FNB 기본 132px, 접힘 48px, 최대 45vh.
- Main 최소 폭은 560px이다.
- Panel separator는 pointer와 keyboard를 모두 지원하고 사용자·repository별 크기를 복원한다.
- 1280px 아래 compact, 960px 아래 stacked, 720px 아래 mobile fallback을 사용한다.
- LNB는 Files, Findings, Outline, Impact를 제공한다.
- FNB는 Evidence, Git graph, History, Ownership, Impact, Related tests를 제공한다.
- Findings를 보면서 Chat을 사용할 수 있어야 한다. route/tab 전환 때문에 Chat draft나 stream을 버리면 안 된다.
- LNB, Main, FNB와 Chat은 하나의 snapshot-scoped selection을 가리킨다.
- Evidence trail은 큰 독립 pane으로 다시 늘리지 않는다. compact summary와 필요 시 Main maximize를 사용한다.
- Static HTML은 concept이며 production 범위를 결정하지 않는다. 실제 기능 범위는 기능설계서와 UI 구현 설계를 따른다.

## 8. 요건과 구현계획 상태

- 요건 ID 체계: `BR-*`, `FR-GH-*`, `FR-SN-*`, `FR-AN-*`, `FR-RV-*`, `FR-RP-*`, `FR-UI-*`, `FR-CH-*`, `FR-CF-*`, `DR-*`, `SEC-*`, `NFR-*`, `AT-*`, `OD-*`.
- 총 고유 요건 정의: 159개. 중복 ID와 다른 문서의 미정 참조가 없는 것을 검사했다.
- Priority는 `P0 Praise`, `P1 Info`, `P2 Warning`, `P3 Critical`이며 confidence는 별도 값이다.
- 기본 GitHub 게시 대상은 high/medium P2와 high P3다. inline comment와 P3 Check failure는 기본 off이며 `OD-007`에서 확정한다.
- 구현은 M0 Contract & Foundation, M1 Walking Skeleton, M2 Reviewable MVP, M3 Pilot Hardening, M4 Change Impact & Enterprise 순이다.
- `CP-00`–`CP-33`은 누락 없이 연속이며 각 CP에 선행 작업, 변경 범위, test, 완료 조건과 권장 commit message가 있다.
- 현재 문서 작업은 내용상 `CP-00`에 해당하지만 아직 commit하지 않았다.

## 9. 아직 결정하지 않은 사항

상세 영향과 결정 기한은 요건정의서 `OD-001`–`OD-012`를 따른다.

- 첫 대상: GitHub Enterprise Cloud 또는 특정 GHES version
- 허용 outbound endpoint, 대표 egress IP, DNS/TLS inspection과 CA bundle
- organization/repository/active PR 규모와 허용 detection lag
- GitHub App token 직접 발급 또는 사내 credential broker
- approved model endpoint, region, prompt/source retention
- 우선 지원 언어 두 개와 build system
- inline comment와 P3 Check failure 정책
- source/report/Chat/audit retention 기간과 purge SLA
- CI runner, private registry, signing/admission 제품
- 지원 Chrome/Edge version
- Kubernetes 또는 VM runtime 선택
- SSO와 GitHub identity mapping 방식

이 값이 없다는 이유로 임의의 vendor나 기간을 code에 고정하지 않는다. 기능설계서 18장의 vendor-neutral interface를 먼저 구현할 수 있다.

## 10. 다음 agent의 권장 작업

사용자가 구현을 요청하면 다음 순서로 진행한다.

1. 작업 시작 전에 `git status`로 기존 변경을 확인하고 사용자의 미commit 파일을 보존한다.
2. 구현계획서의 Commit Phase를 작업 단위로 사용한다. 관련 없는 CP를 한 commit에 섞지 않는다.
3. `CP-00` 문서 commit은 사용자가 commit을 요청한 경우에만 수행한다.
4. 첫 code 작업은 `CP-01` monorepo와 공통 개발 도구다.
5. `CP-02` contract, `CP-03` local platform, `CP-04` DB/RLS까지 foundation을 만든다.
6. `CP-05` 전에는 `OD-001`, `OD-004`를 확인한다. 외부 GitHub 연결이 없어도 adapter와 test double까지 진행할 수 있다.
7. `CP-05`–`CP-13`으로 polling→snapshot→queue→Worker→빈 report→최소 Check의 Walking Skeleton을 먼저 닫는다.
8. 그 뒤 `CP-14`–`CP-24`에서 production UI와 analyzer/agent/Chat/Git graph를 연결한다.

구현 요청이 아니라 문서 review 요청이면 code를 만들지 말고 관련 요건·설계·CP의 충돌과 누락을 보고한다.

## 11. Working tree 주의사항

현재 확인한 상태:

```text
 M .documents/blueprint.md
 M .documents/handoff.md
 M README.md
?? .demian/
?? .documents/functional-design.md
?? .documents/implementation-plan.md
?? .documents/requirements-specification.md
?? .documents/ui-implementation-design.md
?? .documents/visuals/
?? PRODUCT.md
```

- 위 변경은 commit하지 않았다.
- `.demian/`은 이번 작업에서 만들거나 확인한 항목이 아니다. 사용자 또는 다른 작업의 파일로 간주하고 건드리지 않는다.
- 기존 수정과 untracked 파일을 reset, checkout, clean, 삭제하지 않는다.
- 사용자의 명시적 요청 없이는 commit, push, PR 생성과 외부 게시를 하지 않는다.

## 12. 마지막 검증 결과

- `git diff --check`: 통과
- 요건 정의 159개, 중복 0개
- 기능설계·구현계획의 알 수 없는 요건 ID 참조: 0개
- Commit Phase: 34개, `CP-00`–`CP-33` 연속성 확인
- README와 기준 문서의 local Markdown link: 누락 0개
- 구현 code test는 아직 대상이 없다.

## 13. Suggested skills

- `impeccable`: production Review Workspace를 구현하거나 UI 품질·responsive·접근성을 검토할 때 사용한다.
- `browser:control-in-app-browser`: local HTML concept 또는 이후 Web app의 interaction과 responsive 상태를 실제 browser에서 검증할 때 사용한다.
- `imagegen`: 새로운 raster mockup이나 preview image가 명시적으로 필요할 때만 사용한다.
- `handoff`: 다음 session 종료 시 이 문서를 다시 압축·갱신할 때 사용한다. 상세 문서 내용을 복사하지 말고 경로와 변경된 결정만 남긴다.

## 14. 참고 자료

- [commit-defender](https://github.com/pydemia/commit-defender): priority, inline skip, output richness 개념 참고
- [GitHub App 권한 선택](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub App 자체 인증](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app)
- [GitHub REST API rate limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub REST API conditional request](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate)
- [GitHub GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
