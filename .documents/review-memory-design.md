# Review Memory 설계 및 구현 계획

## 1. 목적

Git Code Reviewer가 한 번 생성한 AI review와 사용자가 확인한 review 판단을 다음 PR 분석과 Chat에서 재사용한다. 이 기능은 model fine-tuning이 아니라 repository별 검토 지식을 검색해 현재 snapshot에서 다시 검증하는 retrieval-augmented memory다.

다음 문제를 해결한다.

- 같은 repository에서 반복되는 결함과 설계 제약을 매번 처음부터 설명한다.
- 과거 false positive가 새 분석에서 반복된다.
- Chat에서 확인한 팀의 결정과 예외 조건이 해당 session이 끝나면 사라진다.
- 과거 판단을 재사용하더라도 어떤 PR, finding, 사용자 검토에서 왔는지 추적하기 어렵다.

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

## 4. Memory 종류

| 종류 | 내용 | 대표 출처 |
| --- | --- | --- |
| `recurring-finding` | 반복 결함의 발생 조건, 영향과 수정 기준 | AI finding, 사용자 review |
| `decision` | 팀이 선택한 설계와 적용 범위, 선택 이유 | Chat, 사용자 review |
| `false-positive` | 과거 지적이 잘못된 이유와 예외 조건 | 기각된 AI finding에 대한 사용자 설명 |
| `open-question` | 후속 PR에서 다시 확인해야 할 미해결 검토 항목 | Chat, 사용자 review |

Memory 본문은 `summary`, `detail`, `recommendation`으로 나눈다. 검색 scope는 category, file path, code symbol과 자유 검색어로 구성한다.

## 5. 상태와 신뢰 경계

```text
AI finding 또는 사용자 review
  -> candidate
  -> active      승인되어 다음 분석과 Chat에서 검색됨
  -> rejected    잘못되었거나 재사용 가치가 없음
  -> superseded  다른 memory가 대체함
  -> retired     더 이상 적용하지 않음
```

- AI finding 저장은 자동으로 수행하지만 상태는 `candidate`다.
- 사용자는 자신이 작성한 Chat message를 memory 후보로 제출할 수 있다.
- repository 공용 memory 활성화, 기각, 수정과 폐기는 administrator만 수행한다.
- PR merge, comment resolve 또는 finding 존재만으로 자동 승인하지 않는다.
- `active` memory의 의미를 수정할 때 기존 row를 덮어쓰지 않고 새 revision을 만든다.
- 사용자 삭제 후에도 공용 memory의 검토 근거는 보존하되 actor는 삭제된 사용자 식별자만 참조한다. 개인 Chat 원문 공개 범위는 확대하지 않는다.

## 6. 데이터 모델

### 6.1 `review_memories`

- `id`, `tenant_id`, `repository_id`
- `kind`: 네 가지 Memory 종류
- `state`: `candidate|active|rejected|superseded|retired`
- `revision`, `supersedes_id`
- `summary`, `detail`, `recommendation`
- `categories text[]`, `file_paths text[]`, `symbols text[]`, `search_text`
- `confidence`, `importance`
- `source_kind`: `finding|chat-message|manual`
- `source_analysis_run_id`, `source_finding_id`, `source_chat_message_id`
- `source_base_sha`, `source_head_sha`, `source_anchor jsonb`
- `content_hash`
- `created_by`, `reviewed_by`, `reviewed_at`, `review_note`
- `created_at`, `updated_at`

동일 repository에서 같은 `content_hash`를 가진 활성 또는 후보 memory는 중복 생성하지 않는다.

### 6.2 `review_memory_events`

상태 변경과 사용자 판단을 append-only audit로 저장한다.

- `memory_id`, `action`, `actor_user_id`
- 변경 전후 상태와 revision
- 사용자 note
- `created_at`

### 6.3 Analysis memory snapshot

`analysis_runs`에 다음 값을 저장한다.

- `memory_hash`: 선택한 active memory ID, revision과 content hash를 정렬해 계산한 SHA-256
- `memory_context`: 분석 prompt에 사용한 bounded projection

`analysis_key`에 `memory_hash`를 포함한다. 새 memory가 활성화되어도 완료된 analysis와 기존 Chat 답변의 context는 변하지 않는다. 새 memory를 반영하려면 새 analysis를 실행한다.

## 7. 후보 생성

### 7.1 AI finding

Report transaction에서 finding을 저장한 뒤 다음 조건을 만족하는 finding을 후보로 upsert한다.

- model 또는 analyzer가 만든 P2/P3 finding
- anchor가 실제 snapshot file을 가리킴
- verification이 현재 코드 위치를 확인했거나 limitation이 명시됨

초기 구현에서는 finding 하나를 memory 후보 하나로 만든다. 동일 fingerprint와 content hash는 합친다. P0/P1은 반복 규칙이나 결정으로 보기 어려우므로 자동 후보로 만들지 않는다.

### 7.2 사용자 review와 Chat

사용자는 자신의 completed Chat message를 선택해 후보를 제출한다. 요청에는 memory 종류, 요약, 적용 file/symbol과 설명을 포함한다. 서버는 message 소유권과 analysis의 repository 접근 권한을 검사하고 source ID를 고정한다.

Chat의 assistant 응답만 단독으로 후보화하지 않는다. 사용자가 내용을 확인해 직접 제출한 경우에만 `candidate`가 된다.

## 8. 검색과 ranking

별도 vector database를 MVP dependency로 추가하지 않는다. PostgreSQL의 scope filter와 deterministic score로 시작한다.

### 8.1 Hard filter

- 현재 analysis와 같은 `tenant_id`, `repository_id`
- `state = active`
- 현재 analysis 생성 시점 이전에 승인됨
- superseded 또는 retired가 아님

### 8.2 Score

```text
score = path_match * 40
      + symbol_match * 30
      + category_match * 15
      + text_rank * 10
      + importance * 3
      + confidence * 2
```

- exact file path와 symbol 일치를 우선한다.
- 현재 변경 파일과 겹치지 않는 memory는 자유 검색어가 강하게 일치할 때만 포함한다.
- `false-positive`도 같은 path/category에서 검색해 반복 지적 방지 지침으로 제공한다.
- 최대 12개, item당 1,200자, 전체 8,000자로 제한한다.
- 같은 source finding, content hash와 supersession chain은 하나만 남긴다.

초기 deterministic ranking의 효과를 측정한 뒤에만 embedding column이나 외부 vector store를 추가한다.

## 9. Analysis 연동

Snapshot materialization이 끝난 뒤 analysis row를 만들기 전에 active memory를 조회한다.

1. 변경 file path와 활성 Skill category로 후보를 검색한다.
2. bounded projection과 `memory_hash`를 만든다.
3. `analysis_key`, `analysis_runs.memory_hash`, `memory_context`에 저장한다.
4. Worker가 pinned context를 `analyzeSnapshot`에 전달한다.
5. review prompt는 memory를 과거 검토 가설로 취급하고 현재 supplied source에서 재검증한다.

Prompt에는 source PR/SHA, 종류, scope와 사용자 검토 상태를 포함한다. Memory 때문에 현재 diff에 없는 finding을 만들거나 priority를 올리지 않는다. 현재 코드와 충돌하면 현재 evidence를 우선하고 conflict를 report limitation에 기록한다.

## 10. Chat 연동

Chat은 `analysis_runs.memory_context`만 사용한다. 새 memory가 승인돼도 기존 analysis session의 답변 근거가 조용히 바뀌지 않는다.

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
  - 현재 analysis의 후보와 pinned active memory를 조회한다.
- `POST /api/v1/analyses/:analysisId/review-memory-candidates`
  - finding 또는 본인 Chat message를 memory 후보로 제출한다.

### 11.2 Administrator API

- `GET /api/v1/admin/review-memories?tenantId=&repositoryId=&state=`
- `POST /api/v1/admin/review-memories/:memoryId/review`
  - `activate|reject|retire|supersede`와 수정 본문, note를 받는다.

### 11.3 UI

- Review workspace의 `Memory` tab에서 현재 analysis에 pinned된 memory와 후보를 표시한다.
- Finding 또는 Chat message에서 `Memory 후보로 제출`을 제공한다.
- Admin의 repository memory 화면에서 candidate 비교, 수정, 승인, 기각과 폐기를 수행한다.
- Finding과 Chat에서 memory가 영향을 준 경우 source PR/SHA와 상태를 접을 수 있는 provenance로 표시한다.

## 12. 보존, 보안과 운영

- tenant/repository 조건은 API 이후 필터가 아니라 SQL 조회에 포함한다.
- source Chat message는 작성자와 관리 권한을 확인하며 다른 사용자의 개인 Chat 원문을 memory 본문으로 복사하지 않는다.
- memory prompt projection은 source code 원문, credential, tool output 전체를 포함하지 않는다.
- repository 삭제는 기존 review history 보존 정책에 따라 memory도 비활성 repository에 남기며 재등록 전에는 검색하지 않는다.
- memory 후보와 event는 report retention과 같은 기간을 기본으로 하되 active decision/false-positive는 관리자가 retire할 때까지 보존한다.
- `memory.candidate.created`, `memory.activated`, `memory.rejected`, `memory.retired`, `memory.retrieved` event를 남긴다.
- 분석별 retrieved count, path/symbol match count, prompt chars와 memory conflict 수를 측정한다.

## 13. 효과 검증

같은 snapshot과 provider 설정에서 memory on/off 결과를 비교한다.

- 과거 확인된 recurring finding 재탐지율
- 이미 기각된 false positive 재발률
- finding당 현재 code evidence 비율
- reviewer 승인·기각 비율
- 추가 prompt 문자 수, model latency와 호출 비용

Memory 사용 결과가 좋아졌다는 평가는 memory 수가 아니라 위 비교 결과로 판단한다.

## 14. Phase별 commit 계획

### Phase 1 — 저장 모델과 retrieval service

예정 commit: `feat(memory): add repository review memory model`

- migration과 contract 추가
- candidate 생성, content hash, bounded ranking service
- tenant/repository scope와 상태 transition 단위 테스트

### Phase 2 — 후보와 승인 workflow

예정 commit: `feat(memory): add review memory candidate workflow`

- report finding 자동 후보 생성
- finding/Chat 기반 사용자 후보 API
- administrator 조회·승인·기각·폐기 API
- 권한, source ownership, audit integration test

### Phase 3 — Analysis와 Chat context 연동

예정 commit: `feat(memory): apply pinned review context to analysis and chat`

- snapshot path 기반 retrieval
- analysis key와 memory context pinning
- analysis model prompt와 Chat prompt에 bounded memory 적용
- 새 memory가 기존 analysis 의미를 바꾸지 않는 회귀 테스트

### Phase 4 — UI, 운영 문서와 종합 검증

예정 commit: `feat(memory): expose review memory provenance and controls`

- Review workspace Memory tab과 후보 제출
- Admin 승인·기각·폐기 화면
- 사용자 가이드, 운영·보존 문서
- 전체 test, typecheck, lint, build와 browser 검증

## 15. 완료 조건

- AI P2/P3 finding이 repository-scoped candidate로 생성된다.
- 사용자가 finding 또는 자신의 Chat message를 후보로 제출할 수 있다.
- administrator가 candidate를 수정해 활성화하거나 기각·폐기할 수 있다.
- 활성 memory만 다음 analysis에 포함되고 해당 목록과 hash가 analysis에 고정된다.
- analysis와 Chat은 과거 판단을 현재 snapshot에서 재검증하도록 명시된다.
- Memory provenance를 UI와 API에서 확인할 수 있다.
- tenant/repository/user 권한과 삭제·보존 정책을 integration test로 검증한다.
- 전체 검증이 통과하고 네 phase가 각각 독립 커밋으로 남는다.
