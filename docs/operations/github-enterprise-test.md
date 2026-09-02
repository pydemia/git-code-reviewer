# Private GHES test guide

## 1. GitHub App preflight

private GHES에 GitHub App을 만들고 대상 repository에 설치한다. Repository permission은 최소 다음 read-only 범위로 제한한다.

- Metadata: Read-only
- Contents: Read-only
- Pull requests: Read-only

Webhook과 write permission은 필요하지 않다. 설치할 repository를 명시적으로 선택한다. 권한별 API 범위는 대상 GHES 버전의 [GitHub App permissions 문서](https://docs.github.com/en/enterprise-server@3.21/rest/authentication/permissions-required-for-github-apps)를 확인한다.

확인할 값은 App ID, installation ID, API base URL(`https://GHES/api/v3/`), web base URL(`https://GHES/`), private key다. Cluster의 Server와 Worker Pod에서 GHES DNS/TLS/API와 Git HTTPS clone이 모두 가능해야 한다.

## 2. Register a repository

OIDC로 관리자 그룹 사용자가 로그인한 후 browser DevTools Network에서 `/api/v1/me` 요청을 `Copy as cURL` 한다. 같은 origin과 HttpOnly session cookie를 유지한 로컬 terminal에서 URL과 method/body만 아래처럼 바꾼다. 복사한 command에는 세션 cookie가 있으므로 shell history나 문서에 남기지 않는다.

```bash
curl 'https://git-code-reviewer.example.internal/api/v1/admin/repositories' \
  -X POST \
  -H 'content-type: application/json' \
  -H 'origin: https://git-code-reviewer.example.internal' \
  -H 'cookie: gcr_session=REDACTED' \
  --data '{
    "instanceName":"Enterprise GHES",
    "apiBaseUrl":"https://github.example.internal/api/v3/",
    "webBaseUrl":"https://github.example.internal/",
    "githubId":123456,
    "installationId":"98765",
    "owner":"platform",
    "name":"reviewer-api",
    "pollIntervalSeconds":120
  }'
```

Repository ID는 GHES `GET /repos/{owner}/{repo}` 응답의 numeric `id`를 사용한다. API/Web URL에 credential이나 임의 origin을 포함하면 등록이 거부되어야 한다.

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

현재 MVP code object extractor는 bounded lexical adapter로 TypeScript/Python의 변경 범위를 분석한다. 외부 repository dependent는 추정하지 않으며 coverage limitation으로 표시한다. Pilot에서 language precision 요구를 측정한 뒤 tree-sitter adapter 확장을 결정한다.

## 4. Model acceptance

Batch 분석과 interactive Chat은 서로 다른 Secret과 model name을 사용할 수 있다. 각 endpoint에서 사용 가능한 model을 조회하고 최소 호출을 성공시킨 뒤 Helm values에 넣는다. `404 model not found`가 나오면 image를 다시 만들지 말고 해당 component의 `endpoint`와 `name`을 수정한다.

검증 항목:

- 설정에서 model name이 비어 있으면 startup/template validation 실패
- provider timeout 시 analysis는 가능한 deterministic 결과를 partial로 보존
- Chat provider 실패 시 report 상태는 바뀌지 않고 retryable `CHAT_MODEL_FAILED`
- rate/session/concurrency 초과 시 typed `429 CHAT_LIMIT_EXCEEDED`
- source와 질문을 untrusted input으로 취급하며 답변 citation은 현재 immutable report 범위만 사용

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

## 6. Browser matrix

- Desktop 1440x900: LNB, split diff, persistent Chat, compact FNB 동시 표시
- Compact desktop 1024px: Main과 Chat 최소 폭, incoherent overlap 없음
- Mobile 390x844: unified diff, horizontal page overflow 없음, Chat draft 유지
- Keyboard: tabs, finding, citation, composer 접근 가능
- Browser storage: source, diff, report, finding, Chat content, credential 없음
