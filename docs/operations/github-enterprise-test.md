# Private GHES test guide

## 1. Access token preflight

회사에서 관리하는 bot 또는 service account에 대상 private repository 권한을 부여한다. 개인 관리자 계정은 사용하지 않는다. GHES와 organization 정책이 허용하면 `Settings → Developer settings → Personal access tokens → Fine-grained tokens`에서 token을 만들고 Resource owner와 대상 repository를 명시한다.

Repository permission은 다음 범위로 제한한다.

- Metadata: Read-only
- Contents: Read-only
- Pull requests: Read and write
- Issues: No access

Metadata는 repository 등록 시 `GET /repos/{owner}/{repo}`, Contents는 Worker의 HTTPS Git fetch, Pull requests는 outbound polling과 PR timeline 댓글 생성·갱신에 사용한다. PR 일반 댓글 API는 Pull requests write permission을 허용하므로 Issues permission은 별도로 부여하지 않는다. Webhook, Administration, Contents write와 Workflows permission은 필요하지 않다. Fine-grained PAT을 사용할 수 없으면 classic PAT의 `repo` scope를 사용할 수 있지만 계정이 접근 가능한 private repository 전체로 범위가 넓으므로 전용 계정과 짧은 만료·회전 주기를 적용한다. 권한별 API 범위는 대상 GHES 버전의 [fine-grained PAT permissions 문서](https://docs.github.com/en/enterprise-server@3.21/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)를 확인한다. 댓글 endpoint와 permission은 [Issue Comments API](https://docs.github.com/en/enterprise-server@3.21/rest/issues/comments#create-an-issue-comment)를 기준으로 확인한다.

GitHub.com을 연결할 때 API base URL은 `https://api.github.com`, Web base URL은 `https://github.com`이다. 두 값에 organization이나 repository 경로를 붙이지 않는다. 사내 GHES는 API `https://github.company.internal/api/v3`, Web `https://github.company.internal`처럼 회사가 운영하는 host를 사용한다. Token 만료일과 원문을 준비하고 organization 승인이 필요한 fine-grained PAT은 승인 완료 상태여야 한다. Cluster의 Server와 Worker Pod에서 API와 Git HTTPS fetch가 모두 가능해야 한다.

## 2. Register a repository

1. 시스템 관리자 계정으로 로그인하고 GNB의 `사용 가이드 → GHES credential`을 확인한다.
2. `/admin?tab=github`에서 연결 이름, API/Web base URL, credential label, access token과 만료일을 입력한다.
3. Credential label은 `ghes-review-publisher`처럼 용도를 나타내는 관리용 이름을 사용한다. Token, GHES username이나 password를 label에 넣지 않는다.
4. Access token에는 GHES 발급 화면에 나온 문자열만 입력한다. `Bearer` 접두어, 따옴표와 URL은 붙이지 않는다.
5. `연결 테스트`를 실행한다. 이 요청은 `GET /user`만 확인하므로 성공해도 다음 repository 검증과 Git fetch를 계속 수행한다.
6. GHES 연결과 tenant를 선택하고 Repository URL에 `https://github.com/org-name/repo-name`를 붙여 넣는다. 자동 추출 결과는 Owner `org-name`, Repository `repo-name`다. Polling interval(예: `120`초)과 사용자 권한을 설정하고 `분석 완료 후 PR timeline에 review 결과 게시`를 켜서 등록한다. Server가 token으로 numeric repository ID와 canonical owner/name을 직접 조회한다.
7. `Poll now`로 open PR을 가져온 뒤 첫 snapshot 분석에서 Worker의 HTTPS Git fetch와 GHES PR 댓글 생성을 확인한다.

같은 GHES instance와 credential label로 새 token을 등록하면 기존 credential이 교체되고 version이 증가한다. Token을 rotate할 때는 label을 유지하고 연결 테스트부터 다시 수행한다. API/Web URL에 credential을 포함하면 등록이 거부되어야 한다.

Repository URL은 `.git`과 trailing slash를 허용하고 PR·branch·file 경로, token 포함 URL, 선택한 연결과 다른 host는 거부한다. 연결 미검증·비활성·만료는 `GITHUB_CONNECTION_UNAVAILABLE`, 잘못된 URL은 `GITHUB_REPOSITORY_URL_INVALID`, API 401은 `GITHUB_TOKEN_UNAUTHORIZED`, 403은 `GITHUB_REPOSITORY_FORBIDDEN`, 404는 `GITHUB_REPOSITORY_NOT_FOUND`와 한국어 확인 방법을 반환한다. 404만으로 오타와 private repository 권한 부족을 구별할 수 없다. PAT의 Resource owner `org-name`, Repository access의 `repo-name`, organization 승인·SSO 상태를 확인한다.

## 3. End-to-end acceptance

1. 대상 repository에 작은 test PR을 만들고 worklist polling 주기 안에 표시되는지 확인한다.
2. PR row에서 refresh를 실행한다. 동시에 여러 번 실행해도 active operation ID가 하나로 deduplicate되어야 한다.
3. Worker log에서 snapshot job과 analysis job 완료를 확인한다. Git credential은 URL에 포함되지 않고 ephemeral askpass로만 사용되어야 한다.
4. report에서 grade, summary, per-file summary, P0 positive finding, P1-P3 actionable finding을 확인한다.
5. GHES PR timeline에 `Git Code Reviewer 결과` 댓글이 하나 생성되고 head SHA, grade, P3-P0 count, 상위 finding과 전체 review link가 일치하는지 확인한다.
6. PR에 새 commit을 push해 후속 분석을 실행한다. 기존 댓글의 comment ID는 유지되고 내용과 head SHA만 갱신되어야 한다.
7. Worker를 댓글 API 성공 직후 중단하는 failure test에서 재시도 후에도 관리 marker를 찾아 같은 댓글을 갱신하고 중복 댓글을 만들지 않는지 확인한다.
8. finding을 선택해 diff anchor, Evidence, Chat scope가 같은 revision/head SHA를 가리키는지 확인한다.
9. 내부 `/reviews/{analysisId}?finding=...` URL을 새 tab에서 열고 reload해 같은 revision과 selection이 복원되는지 확인한다.
10. GHES link가 branch가 아닌 40자리 exact commit SHA와 encoded path/line fragment를 사용하는지 확인한다.
11. Outline에서 object를 선택하고 Structure parent/children, Dependencies uses/used-by를 전환한다. object URL을 reload해 선택이 복원되는지 확인한다.
12. Chat 질문을 보내고 답변, persisted message, citation 이동을 확인한다. 다른 user는 session ID를 알아도 404를 받아야 한다.
13. Markdown과 JSON report export가 동일한 canonical finding/link를 포함하는지 확인한다.
14. Tenant A reviewer가 Tenant B repository와 analysis URL에서 404를 받는지 확인한다.
15. `/admin?tab=provider`에서 승인된 endpoint/model을 연결 테스트하고 Provider version을 활성화한다. API key 원문은 UI, API response, browser storage에 다시 나타나지 않아야 한다.
16. `/admin?tab=prompt`에서 tenant prompt를 활성화하고 새 analysis report의 provider/prompt version/hash가 일치하는지 확인한다. 이전에 queue된 run의 hash는 바뀌지 않아야 한다.

현재 MVP code object extractor는 bounded lexical adapter로 TypeScript/Python의 변경 범위를 분석한다. 외부 repository dependent는 추정하지 않으며 coverage limitation으로 표시한다. Pilot에서 language precision 요구를 측정한 뒤 tree-sitter adapter 확장을 결정한다.

## 4. Model acceptance

Batch 분석과 interactive Chat은 서로 다른 Secret과 model name을 사용할 수 있다. 각 endpoint에서 사용 가능한 model을 조회하고 최소 호출을 성공시킨 뒤 Helm values에 넣는다. `404 model not found`가 나오면 image를 다시 만들지 말고 해당 component의 `endpoint`와 `name`을 수정한다.

검증 항목:

- 설정에서 model name이 비어 있으면 startup/template validation 실패
- Provider 관리자 설정에서 allowlist 밖 endpoint를 저장하거나 테스트하면 안전하게 거부
- Provider 연결 테스트는 최소 `Reply with OK.` 요청만 보내고 repository source/diff/prompt를 전송하지 않음
- provider timeout 시 analysis는 가능한 deterministic 결과를 partial로 보존
- Chat provider 실패 시 report 상태는 바뀌지 않고 retryable `CHAT_MODEL_FAILED`
- ChatGPT account mode에서 account header가 browser에 노출되지 않고 만료 token refresh 후 질문이 1회 재시도됨
- account Secret의 `bootstrapRevision`이 같으면 Pod restart 후 PVC의 회전된 refresh token이 유지됨
- rate/session/concurrency 초과 시 typed `429 CHAT_LIMIT_EXCEEDED`
- source와 질문을 untrusted input으로 취급하며 답변 citation은 현재 immutable report 범위만 사용
- tenant prompt가 source-as-untrusted guard와 structured output contract를 제거하지 않으며 report에는 prompt 원문 대신 version/hash만 표시

## 5. Failure and replica tests

```bash
# Worker lease recovery
kubectl -n git-code-reviewer delete pod -l app.kubernetes.io/component=worker
kubectl -n git-code-reviewer rollout status deploy/git-code-reviewer-worker

# Server failover while preserving REST final state
kubectl -n git-code-reviewer delete pod -l app.kubernetes.io/component=server
kubectl -n git-code-reviewer rollout status deploy/git-code-reviewer-server

# Manual retention/reconcile Job derived from the CronJob
kubectl -n git-code-reviewer create job --from=cronjob/git-code-reviewer-retention retention-manual
kubectl -n git-code-reviewer logs -f job/retention-manual
```

추가로 GHES 401/403, 429/5xx, PostgreSQL 일시 중단, model timeout, artifact 파일 누락을 각각 주입한다. Pull requests를 Read-only로 낮춘 403 test에서는 publication만 `GITHUB_REVIEW_PERMISSION_DENIED`로 실패하고 completed/partial report는 유지되어야 한다. 429/5xx는 publication job만 재시도한다. 복구 후 operation/report/chat 최종 상태는 REST로 다시 조회 가능해야 하며 secret/source/Chat 원문이 log나 browser storage에 남지 않아야 한다.

Cerbos mode에서는 PDP 일시 중단도 주입한다. 보호 API는 cache된 허용으로 우회하지 않고 `503 AUTHORIZATION_UNAVAILABLE`로 실패해야 하며 `/health/dependencies`가 `degraded`를 보고해야 한다.

## 6. Browser matrix

- Desktop 1440x900: LNB, split diff, persistent Chat, compact FNB 동시 표시
- Compact desktop 1024px: Main과 Chat 최소 폭, incoherent overlap 없음
- Mobile 390x844: unified diff, horizontal page overflow 없음, Chat draft 유지
- Keyboard: tabs, finding, citation, composer 접근 가능
- Browser storage: source, diff, report, finding, Chat content, credential 없음
