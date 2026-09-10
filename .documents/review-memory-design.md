# Review Memory 설계 및 구현 계획

## 1. 목적

Git Code Reviewer가 한 번 생성한 AI review와 사용자가 확인한 review 판단을 다음 PR 분석과 Chat에서 재사용한다. 사용자별 누적 memory와 repository별 집단 memory를 함께 지원한다. 이 기능은 model fine-tuning이 아니라 검토 지식을 검색해 현재 snapshot에서 다시 검증하는 retrieval-augmented memory다.

다음 문제를 해결한다.

- 같은 repository에서 반복되는 결함과 설계 제약을 매번 처음부터 설명한다.
- 과거 false positive가 새 분석에서 반복된다.
- Chat에서 확인한 팀의 결정과 예외 조건이 해당 session이 끝나면 사라진다.
- GitHub PR에서 사람이 코드와 repository 맥락을 보고 남긴 댓글, review와 답글이 다음 분석에 재사용되지 않는다.
- 과거 판단을 재사용하더라도 어떤 PR, finding, 사용자 검토에서 왔는지 추적하기 어렵다.
- 개인 검토 취향과 팀에서 합의된 지식을 구분하지 않으면 다른 사용자에게 개인 맥락이 노출되거나 공용 분석이 한 사용자의 판단에 치우친다.

## 2. 기준 Blueprint

`작성 blueprint (2)`의 repository review memory 제안을 기능 기준으로 사용한다. 기존 `.documents/blueprint.md`의 snapshot 불변성, evidence locator, tenant 분리와 현재 코드 재검증 원칙을 함께 적용한다.

기존 `review-history` Skill은 과거 검토를 확인하라는 분석 지침만 제공한다. 이 설계에서 추가하는 Review Memory는 실제 저장, 승인, 검색, analysis pinning과 provenance를 담당한다.

## 3. 참고 구현에서 적용할 원칙

### 3.1 Demian

로컬 `demian/nodejs` 구현은 agent session memory를 `summary`, `findings`, `decisions`, `openQuestions`, `relevantFiles`로 구조화하고 context가 커지면 오래된 메시지를 요약하되 최근 원문을 보존한다.

Review Memory에는 다음 원칙을 적용한다.

- 긴 대화 원문 대신 재사용 가능한 판단, 근거와 적용 범위를 구조화한다.
- prompt에 넣는 context는 문자 수와 항목 수를 제한한다.
- 요약만 저장하지 않고 원본 finding 또는 chat message 식별자를 유지한다.

### 3.2 AgentStore

로컬 `skax-successionX-backend/agentstore` 구현은 memory record를 tenant, user, conversation scope로 분리하고 완료된 work memory만 재사용 대상으로 표시한다. recall 결과는 bounded summary와 raw context projection으로 나뉘며, memory가 있어도 현재 데이터 갱신이 필요하면 memory만으로 답하지 않는다.

Review Memory에는 다음 원칙을 적용한다.

- tenant와 repository scope를 조회 조건에 강제한다.
- AI가 생성한 finding은 바로 지식으로 사용하지 않고 `candidate`로 저장한다.
- 사용자가 승인한 `active` memory만 분석 prompt에 포함한다.
- 과거 memory는 검색 후보일 뿐이며 현재 base/head source에서 확인되지 않은 내용을 단정하지 않는다.
- 분석에 사용한 memory 목록과 content hash를 고정해 같은 analysis revision의 의미가 바뀌지 않게 한다.

## 4. Memory scope와 종류

### 4.1 Scope

| Scope | 소유·검색 범위 | 사용 위치 |
| --- | --- | --- |
| `personal` | tenant + repository + user | 해당 사용자가 요청한 personalized analysis와 본인 Chat |
| `collective` | tenant + repository | polling 기반 공용 analysis와 모든 사용자의 analysis·Chat |

- Personal memory는 작성자와 administrator만 원문과 provenance를 볼 수 있다.
- Collective memory는 여러 사용자가 활성화한 personal memory를 aggregation한 결과다. 개인 Chat 원문은 collective 본문에 복사하지 않는다.
- 한 사용자의 personal memory를 바로 collective로 승격하지 않는다. 최소 두 명의 독립적인 기여 또는 administrator의 명시적 예외 승인이 필요하다.
- Personalized analysis에서도 collective memory가 personal memory보다 우선한다. Personal memory는 collective와 충돌하지 않는 범위에서 누락된 관점과 사용자별 검토 관심사를 보완한다.

### 4.2 종류

| 종류 | 내용 | 대표 출처 |
| --- | --- | --- |
| `recurring-finding` | 반복 결함의 발생 조건, 영향과 수정 기준 | AI finding, 사용자 review |
| `decision` | 팀이 선택한 설계와 적용 범위, 선택 이유 | Chat, 사용자 review |
| `false-positive` | 과거 지적이 잘못된 이유와 예외 조건 | 기각된 AI finding에 대한 사용자 설명 |
| `open-question` | 후속 PR에서 다시 확인해야 할 미해결 검토 항목 | Chat, 사용자 review |

Memory 본문은 `summary`, `detail`, `recommendation`으로 나눈다. 검색 scope는 category, file path, code symbol과 자유 검색어로 구성한다.

## 5. 상태와 신뢰 경계

```text
AI finding, Chat 또는 GitHub PR 대화
  -> personal candidate
  -> personal active     본인의 다음 분석과 Chat에서 검색됨
  -> collective candidate 서로 다른 사용자 memory를 repository 단위로 집계
  -> collective active   공용 분석과 repository 사용자의 분석·Chat에서 검색됨
  -> rejected    잘못되었거나 재사용 가치가 없음
  -> superseded  다른 memory가 대체함
  -> retired     더 이상 적용하지 않음
```

- 사용자가 요청한 analysis의 AI finding은 해당 사용자의 `personal candidate`로 자동 저장한다.
- 사용자는 자신의 finding, Chat message 또는 접근 가능한 GitHub PR message를 personal memory 후보로 제출할 수 있다.
- 사용자는 자신의 personal candidate를 수정해 활성화하거나 기각·폐기할 수 있다.
- repository collective memory 활성화, 기각, 수정과 폐기는 administrator만 수행한다.
- Collective candidate는 같은 repository의 active personal memory를 `aggregation_key`로 묶고 contributor 수와 충돌 상태를 계산해 만든다.
- PR merge, comment resolve 또는 finding 존재만으로 자동 승인하지 않는다.
- `active` memory의 의미를 수정할 때 기존 row를 덮어쓰지 않고 새 revision을 만든다.
- 사용자 삭제 후에도 공용 memory의 검토 근거는 보존하되 actor는 삭제된 사용자 식별자만 참조한다. 개인 Chat 원문 공개 범위는 확대하지 않는다.

## 6. 데이터 모델

### 6.1 `review_memories`

- `id`, `tenant_id`, `repository_id`
- `scope`: `personal|collective`
- `owner_user_id`: personal이면 필수, collective이면 null
- `kind`: 네 가지 Memory 종류
- `state`: `candidate|active|rejected|superseded|retired`
- `revision`, `supersedes_id`
- `summary`, `detail`, `recommendation`
- `categories text[]`, `file_paths text[]`, `symbols text[]`, `search_text`
- `aggregation_key`, `contributor_count`, `conflict_count`
- `confidence`, `importance`
- `source_kind`: `finding|chat-message|github-pr-message|manual`
- `source_analysis_run_id`, `source_finding_id`, `source_chat_message_id`
- `source_github_pr_message_id`, `source_github_pr_message_content_hash`
- `source_base_sha`, `source_head_sha`, `source_anchor jsonb`
- `content_hash`
- `created_by`, `reviewed_by`, `reviewed_at`, `review_note`
- `created_at`, `updated_at`

동일 repository와 사용자에서 같은 `content_hash`를 가진 personal memory는 중복 생성하지 않는다. Collective memory는 repository와 `aggregation_key` 단위로 한 candidate 또는 active revision만 유지한다.

### 6.2 `review_memory_contributions`

Collective memory와 집계에 사용한 personal memory를 연결한다.

- `collective_memory_id`, `personal_memory_id`
- contributor user ID와 personal revision
- `agreement`: `support|conflict`
- `created_at`

Collective projection에는 contributor 수와 conflict 수만 노출하고 개인 memory 본문과 Chat source는 노출하지 않는다.

### 6.3 `review_memory_events`

상태 변경과 사용자 판단을 append-only audit로 저장한다.

- `memory_id`, `action`, `actor_user_id`
- 변경 전후 상태와 revision
- 사용자 note
- `created_at`

### 6.4 Analysis memory snapshot

`analysis_runs`에 다음 값을 저장한다.

- `memory_hash`: 선택한 active memory ID, revision과 content hash를 정렬해 계산한 SHA-256
- `memory_context`: 분석 prompt에 사용한 bounded projection
- `memory_owner_user_id`: personalized analysis를 요청한 사용자, polling 분석이면 null

`analysis_key`에 `memory_hash`와 `memory_owner_user_id`를 포함한다. 새 memory가 활성화되어도 완료된 analysis와 기존 Chat 답변의 context는 변하지 않는다. 새 memory를 반영하려면 새 analysis를 실행한다.

### 6.5 GitHub PR message source

`github_pr_messages`에는 PR 일반 댓글, review 본문과 inline review comment를 repository·PR 단위로 수집한다. 작성자 login과 유형, 본문, file/line/side, commit SHA, 답글 관계, 영구 URL과 GitHub 작성·수정 시각을 저장한다.

GitHub에서 본문이 수정되면 현재 row를 갱신하되 `github_pr_message_versions`에 content hash별 원문 버전을 append-only로 보존한다. Personal memory는 제출 시점의 message ID와 content hash를 함께 고정한다. 따라서 이후 댓글이 수정되어도 어떤 원문을 근거로 판단했는지 확인할 수 있다.

`github_pr_message_user_states`는 같은 원천에 대한 사용자별 `available|saved|ignored` 상태를 저장한다. 한 사용자의 숨김 상태가 다른 사용자에게 영향을 주지 않는다. GitHub login과 애플리케이션 사용자는 자동으로 같은 사람이라고 간주하지 않으며, 집단 memory contributor는 원문 작성자가 아니라 내용을 선별·승인한 애플리케이션 사용자로 계산한다.

## 7. 후보 생성

### 7.1 AI finding

사용자가 직접 refresh한 analysis의 Report transaction에서 finding을 저장한 뒤 다음 조건을 만족하는 finding을 해당 사용자의 personal 후보로 upsert한다. Polling으로 실행한 collective analysis는 특정 사용자의 memory 후보를 만들지 않는다.

- model 또는 analyzer가 만든 P2/P3 finding
- anchor가 실제 snapshot file을 가리킴
- verification이 현재 코드 위치를 확인했거나 limitation이 명시됨

초기 구현에서는 finding 하나를 memory 후보 하나로 만든다. Finding fingerprint를 포함한 `aggregation_key`가 같으면 같은 반복 검토 주제로 취급한다. 동일 사용자, fingerprint와 content hash는 합친다. P0/P1은 반복 규칙이나 결정으로 보기 어려우므로 자동 후보로 만들지 않는다.

### 7.2 사용자 review와 Chat

사용자는 자신의 completed Chat message를 선택해 후보를 제출한다. 요청에는 memory 종류, 요약, 적용 file/symbol과 설명을 포함한다. 서버는 message 소유권과 analysis의 repository 접근 권한을 검사하고 source ID를 고정한다.

Chat의 assistant 응답만 단독으로 후보화하지 않는다. 사용자가 내용을 확인해 직접 제출한 경우에만 `candidate`가 된다.

### 7.3 GitHub PR 대화

Repository polling이 open PR을 갱신할 때 다음 세 종류를 함께 수집한다.

- issue timeline comment
- review summary body
- inline review comment와 reply 관계

빈 본문은 제외한다. Bot message도 원문에는 보존하되 자동으로 memory를 활성화하지 않는다. 사용자는 PR별 source 목록에서 항목을 무시하거나 다시 표시할 수 있고, 주요 내용을 요약·범위 지정해 personal candidate로 저장한다. 서버는 해당 source와 analysis가 같은 PR인지 확인한다. 후보가 저장되면 사용자별 source 상태를 `saved`로 바꾼다.

### 7.4 Collective aggregation

Personal memory가 활성화될 때 같은 repository와 `aggregation_key`의 active personal memory를 다시 집계한다.

- 서로 다른 owner가 같은 판단을 지지하면 `support` contribution으로 계산한다.
- `false-positive`와 `recurring-finding`처럼 의미가 반대인 memory가 같은 finding fingerprint를 가리키면 conflict로 계산한다.
- 기본 quorum은 서로 다른 사용자 2명이다.
- quorum을 충족하면 collective candidate를 만들거나 새 revision으로 갱신한다.
- administrator는 contributor 수, conflict와 source PR 범위를 확인한 뒤 collective candidate를 활성화한다.
- active collective memory의 기여 구성이 바뀌면 기존 revision을 수정하지 않고 새 candidate revision을 만든다.

## 8. 검색과 ranking

별도 vector database를 MVP dependency로 추가하지 않는다. PostgreSQL의 scope filter와 deterministic score로 시작한다.

### 8.1 Hard filter

- 현재 analysis와 같은 `tenant_id`, `repository_id`
- `state = active`
- collective memory 또는 현재 `memory_owner_user_id`와 같은 personal memory
- 현재 analysis 생성 시점 이전에 승인됨
- superseded 또는 retired가 아님

### 8.2 Score

```text
score = collective_scope * 100
      + path_match * 40
      + symbol_match * 30
      + category_match * 15
      + text_rank * 10
      + importance * 3
      + confidence * 2
```

- exact file path와 symbol 일치를 우선한다.
- 현재 변경 파일과 겹치지 않는 memory는 자유 검색어가 강하게 일치할 때만 포함한다.
- `false-positive`도 같은 path/category에서 검색해 반복 지적 방지 지침으로 제공한다.
- Collective memory에는 scope priority를 부여해 personal memory보다 먼저 배치한다. 같은 주제에서 둘이 충돌하면 collective만 prompt의 적용 기준으로 남기고 personal 항목은 conflict provenance로 표시한다.
- 최대 12개, item당 1,200자, 전체 8,000자로 제한한다.
- 같은 source finding, content hash와 supersession chain은 하나만 남긴다.

초기 deterministic ranking의 효과를 측정한 뒤에만 embedding column이나 외부 vector store를 추가한다.

## 9. Analysis 연동

Snapshot materialization이 끝난 뒤 analysis row를 만들기 전에 active memory를 조회한다. Manual refresh의 `operations.requested_by`를 analysis의 `memory_owner_user_id`로 전달한다.

1. Polling 분석은 collective만, manual refresh 분석은 collective와 요청 사용자의 personal memory를 검색한다.
2. bounded projection과 `memory_hash`를 만든다.
3. `analysis_key`, `analysis_runs.memory_hash`, `memory_context`에 저장한다.
4. Worker가 pinned context를 `analyzeSnapshot`에 전달한다.
5. review prompt는 memory를 과거 검토 가설로 취급하고 현재 supplied source에서 재검증한다. 우선순위는 현재 코드 evidence, collective memory, personal memory 순서다.

같은 base/head에서도 사용자별 memory hash가 다르면 별도 personalized analysis run을 만든다. Personalized run은 owner와 administrator만 조회할 수 있다. PR 목록의 공용 최신 결과는 `memory_owner_user_id is null`인 collective analysis를 사용하고, 로그인 사용자의 workspace에서는 본인 personalized run을 우선 표시한다.

Prompt에는 source PR/SHA, 종류, scope와 사용자 검토 상태를 포함한다. Memory 때문에 현재 diff에 없는 finding을 만들거나 priority를 올리지 않는다. 현재 코드와 충돌하면 현재 evidence를 우선하고 conflict를 report limitation에 기록한다.

## 10. Chat 연동

Chat은 `analysis_runs.memory_context`와 session owner의 현재 personal memory를 구분한다. 분석 해석과 finding 근거에는 pinned context만 사용한다. 후속 질문의 개인화에는 같은 repository의 최신 active personal memory를 추가할 수 있지만 답변 metadata에 별도 hash를 기록한다. Collective와 personal이 충돌하면 collective를 우선한다. 새 memory가 승인돼도 이미 완료된 답변의 context는 바뀌지 않는다.

Prompt 순서는 다음과 같다.

1. 안전·출력 contract
2. 현재 report와 selected scope
3. pinned Review Memory
4. 최근 session 대화
5. 사용자 질문

Chat 답변은 memory의 source를 citation으로 가장하지 않는다. 현재 report evidence와 snapshot file locator를 citation으로 사용하고, 과거 판단을 언급할 때는 memory ID와 source PR/SHA를 설명에 표시한다.

## 11. API와 UI

### 11.1 Repository reviewer API

- `GET /api/v1/analyses/:analysisId/review-memories`
  - 현재 analysis의 pinned memory와 본인의 personal 후보를 조회한다.
- `POST /api/v1/analyses/:analysisId/review-memory-candidates`
  - finding, 본인 Chat message 또는 같은 PR의 GitHub message를 personal memory 후보로 제출한다.
- `POST /api/v1/review-memories/:memoryId/review`
  - 본인의 personal candidate를 활성화·기각하거나 active memory를 폐기한다.
- `GET /api/v1/repositories/:repoId/pulls/:number/review-memory-sources`
  - 수집한 GitHub PR 대화와 본인의 관리 상태를 시간순으로 조회한다.
- `PATCH /api/v1/repositories/:repoId/pulls/:number/review-memory-sources/:sourceId`
  - GitHub PR 원천을 사용자별로 표시하거나 무시한다.

### 11.2 Administrator API

- `GET /api/v1/admin/review-memories?tenantId=&repositoryId=&state=`
- `POST /api/v1/admin/review-memories/:memoryId/review`
  - collective candidate에 대해 `activate|reject|retire|supersede`와 수정 본문, note를 받는다.

### 11.3 UI

- Review workspace의 `Memory` tab에서 `내 Memory`와 `Repository Memory`를 구분하고 현재 analysis에 pinned된 항목을 표시한다.
- Finding 또는 Chat message에서 `Memory 후보로 제출`을 제공한다.
- Memory tab의 `PR 대화` 영역에서 GitHub 원문, 작성자, code anchor와 thread 관계를 보여주고 저장·무시 상태를 관리한다.
- Admin의 repository memory 화면에서 candidate 비교, 수정, 승인, 기각과 폐기를 수행한다.
- Finding과 Chat에서 memory가 영향을 준 경우 source PR/SHA와 상태를 접을 수 있는 provenance로 표시한다.

## 12. 보존, 보안과 운영

- tenant/repository/owner 조건은 API 이후 필터가 아니라 SQL 조회에 포함한다.
- source Chat message는 작성자와 관리 권한을 확인하며 다른 사용자의 개인 Chat 원문을 memory 본문으로 복사하지 않는다.
- GitHub PR source는 repository 조회 권한이 있는 사용자에게만 노출한다. 사용자별 saved/ignored 상태는 소유자만 읽고 수정한다.
- memory prompt projection은 source code 원문, credential, tool output 전체를 포함하지 않는다.
- repository 삭제는 기존 review history 보존 정책에 따라 memory도 비활성 repository에 남기며 재등록 전에는 검색하지 않는다.
- personal memory는 계정 삭제 시 비활성화하고 collective contribution에는 익명화된 contributor ID와 revision만 보존한다. Collective active decision/false-positive는 관리자가 retire할 때까지 보존한다.
- `memory.candidate.created`, `memory.activated`, `memory.rejected`, `memory.retired`, `memory.retrieved` event를 남긴다.
- 분석별 retrieved count, path/symbol match count, prompt chars와 memory conflict 수를 측정한다.

## 13. 효과 검증

같은 snapshot과 provider 설정에서 memory on/off 결과를 비교한다.

- 과거 확인된 recurring finding 재탐지율
- 이미 기각된 false positive 재발률
- finding당 현재 code evidence 비율
- reviewer 승인·기각 비율
- 사용자별 personal memory 적중률과 collective quorum·conflict 비율
- 추가 prompt 문자 수, model latency와 호출 비용

Memory 사용 결과가 좋아졌다는 평가는 memory 수가 아니라 위 비교 결과로 판단한다.

## 14. Phase별 commit 계획

### Phase 1 — 저장 모델과 retrieval service

예정 commit: `feat(memory): add repository review memory model`

- personal/collective scope, contribution과 personalized analysis owner migration·contract 추가
- content/aggregation hash와 bounded ranking service
- tenant/repository/user scope와 collective aggregation 단위 테스트

### Phase 2 — 후보와 승인 workflow

예정 commit: `feat(memory): add review memory candidate workflow`

- personalized report finding 자동 personal 후보 생성
- finding/Chat/GitHub PR message 기반 사용자 후보 API
- GitHub PR 대화 수집, immutable source version과 사용자별 관리 상태
- 사용자 personal 승인과 administrator collective 승인 API
- personal activation 기반 collective candidate aggregation
- 권한, source ownership, audit integration test

### Phase 3 — Analysis와 Chat context 연동

예정 commit: `feat(memory): apply pinned review context to analysis and chat`

- polling collective와 manual personal+collective retrieval
- personalized analysis visibility, analysis key와 memory context pinning
- analysis model prompt와 Chat prompt에 bounded memory 적용
- 새 memory가 기존 analysis 의미를 바꾸지 않는 회귀 테스트

### Phase 4 — UI, 운영 문서와 종합 검증

예정 commit: `feat(memory): expose review memory provenance and controls`

- Review workspace Memory tab과 후보 제출
- Admin 승인·기각·폐기 화면
- 사용자 가이드, 운영·보존 문서
- 전체 test, typecheck, lint, build와 browser 검증

## 15. 완료 조건

- 사용자 refresh의 AI P2/P3 finding이 user/repository-scoped personal candidate로 생성된다.
- 사용자가 finding, 자신의 Chat message 또는 같은 PR의 GitHub 대화를 후보로 제출할 수 있다.
- GitHub PR 대화 원문 버전이 보존되고 사용자가 항목별로 저장·무시 상태를 관리할 수 있다.
- 사용자는 personal candidate를 활성화·기각·폐기할 수 있다.
- 여러 사용자의 active personal memory가 repository collective candidate로 집계되고 administrator가 활성화할 수 있다.
- polling에는 collective, 사용자 분석에는 collective+본인 active memory만 포함되고 목록과 hash가 analysis에 고정된다.
- analysis와 Chat은 과거 판단을 현재 snapshot에서 재검증하도록 명시된다.
- Memory provenance를 UI와 API에서 확인할 수 있다.
- tenant/repository/user 권한과 삭제·보존 정책을 integration test로 검증한다.
- 전체 검증이 통과하고 네 phase가 각각 독립 커밋으로 남는다.
