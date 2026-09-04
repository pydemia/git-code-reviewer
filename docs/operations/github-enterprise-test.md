# Private GHES test guide

## 1. Access token preflight

회사에서 관리하는 bot 또는 service account에 대상 private repository의 Read 권한을 부여한다. 개인 관리자 계정은 사용하지 않는다. GHES와 organization 정책이 허용하면 `Settings → Developer settings → Personal access tokens → Fine-grained tokens`에서 token을 만들고 Resource owner와 대상 repository를 명시한다.

Repository permission은 다음 read-only 범위로 제한한다.

- Metadata: Read-only
- Contents: Read-only
- Pull requests: Read-only

Metadata는 repository 등록 시 `GET /repos/{owner}/{repo}`, Pull requests는 outbound polling, Contents는 Worker의 HTTPS Git fetch에 사용한다. Webhook, Admin, write와 workflow permission은 필요하지 않다. Fine-grained PAT을 사용할 수 없으면 classic PAT의 `repo` scope를 사용할 수 있지만 계정이 접근 가능한 private repository 전체로 범위가 넓으므로 전용 계정과 짧은 만료·회전 주기를 적용한다. 권한별 API 범위는 대상 GHES 버전의 [fine-grained PAT permissions 문서](https://docs.github.com/en/enterprise-server@3.21/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)를 확인한다.

확인할 값은 API base URL(`https://GHES/api/v3/`), web base URL(`https://GHES/`), token 만료일과 access token 원문이다. Organization 승인이 필요한 fine-grained PAT은 승인 완료 상태여야 한다. Cluster의 Server와 Worker Pod에서 GHES DNS/TLS/API와 Git HTTPS fetch가 모두 가능해야 한다.

## 2. Register a repository

1. 시스템 관리자 계정으로 로그인하고 GNB의 `사용 가이드 → GHES credential`을 확인한다.
2. `/admin?tab=github`에서 연결 이름, API/Web base URL, credential label, access token과 만료일을 입력한다.
3. Credential label은 `ghes-reviewer-readonly`처럼 용도와 권한을 나타내는 관리용 이름을 사용한다. Token, GHES username이나 password를 label에 넣지 않는다.
4. Access token에는 GHES 발급 화면에 나온 문자열만 입력한다. `Bearer` 접두어, 따옴표와 URL은 붙이지 않는다.
5. `연결 테스트`를 실행한다. 이 요청은 `GET /user`만 확인하므로 성공해도 다음 repository 검증과 Git fetch를 계속 수행한다.
6. GHES 연결, tenant, owner/repository, polling interval과 사용자 권한을 선택해 repository를 등록한다. Server가 numeric repository ID를 직접 조회한다.
7. `Poll now`로 open PR을 가져온 뒤 첫 snapshot 분석에서 Worker의 HTTPS Git fetch를 확인한다.

같은 GHES instance와 credential label로 새 token을 등록하면 기존 credential이 교체되고 version이 증가한다. Token을 rotate할 때는 label을 유지하고 연결 테스트부터 다시 수행한다. API/Web URL에 credential을 포함하면 등록이 거부되어야 한다.

## 3. End-to-end acceptance

1. 대상 repository에 작은 test PR을 만들고 worklist polling 주기 안에 표시되는지 확인한다.
2. PR row에서 refresh를 실행한다. 동시에 여러 번 실행해도 active operation ID가 하나로 deduplicate되어야 한다.
3. Worker log에서 snapshot job과 analysis job 완료를 확인한다. Git credential은 URL에 포함되지 않고 ephemeral askpass로만 사용되어야 한다.
4. report에서 grade, summary, per-file summary, P0 positive finding, P1-P3 actionable finding을 확인한다.
5. finding을 선택해 diff anchor, Evidence, Chat scope가 같은 revision/head SHA를 가리키는지 확인한다.
6. 내부 `/reviews/{analysisId}?finding=...` URL을 새 tab에서 열고 reload해 같은 revision과 selection이 복원되는지 확인한다.
7. GHES link가 branch가 아닌 40자리 exact commit SHA와 encoded path/line fragment를 사용하는지 확인한다.
8. Outline에서 object를 선택하고 Structure parent/children, Dependencies uses/used-by를 전환한다. object URL을 reload해 선택이 복원되는지 확인한다.
9. Chat 질문을 보내고 답변, persisted message, citation 이동을 확인한다. 다른 user는 session ID를 알아도 404를 받아야 한다.
10. Markdown과 JSON report export가 동일한 canonical finding/link를 포함하는지 확인한다.
11. Tenant A reviewer가 Tenant B repository와 analysis URL에서 404를 받는지 확인한다.
12. `/admin?tab=provider`에서 승인된 endpoint/model을 연결 테스트하고 Provider version을 활성화한다. API key 원문은 UI, API response, browser storage에 다시 나타나지 않아야 한다.
13. `/admin?tab=prompt`에서 tenant prompt를 활성화하고 새 analysis report의 provider/prompt version/hash가 일치하는지 확인한다. 이전에 queue된 run의 hash는 바뀌지 않아야 한다.

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

추가로 GHES 401/403, 429/5xx, PostgreSQL 일시 중단, model timeout, artifact 파일 누락을 각각 주입한다. 복구 후 operation/report/chat 최종 상태는 REST로 다시 조회 가능해야 하며 secret/source/Chat 원문이 log나 browser storage에 남지 않아야 한다.

Cerbos mode에서는 PDP 일시 중단도 주입한다. 보호 API는 cache된 허용으로 우회하지 않고 `503 AUTHORIZATION_UNAVAILABLE`로 실패해야 하며 `/health/dependencies`가 `degraded`를 보고해야 한다.

## 6. Browser matrix

- Desktop 1440x900: LNB, split diff, persistent Chat, compact FNB 동시 표시
- Compact desktop 1024px: Main과 Chat 최소 폭, incoherent overlap 없음
- Mobile 390x844: unified diff, horizontal page overflow 없음, Chat draft 유지
- Keyboard: tabs, finding, citation, composer 접근 가능
- Browser storage: source, diff, report, finding, Chat content, credential 없음
