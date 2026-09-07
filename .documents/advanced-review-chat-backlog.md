# 고급 Review Chat context backlog

## 현재 상태

자동 분석은 immutable snapshot의 canonical diff를 `unit-comment-block`, 파일별 `overall-summary`, 전체 `total-summary`로 처리한다. Review Chat은 이 report를 설명하는 용도로 구현되어 있으며 모델 입력은 전체 요약, grade, finding 한 건과 impact 요약으로 제한된다. 선택한 file이나 symbol이 scope에 있어도 해당 코드, base 구현, 관계, test 본문을 조회하지 않는다.

Snapshot Worker는 materialization 중 repository를 임시 작업공간에 초기화하고 exact `baseSha`와 `headSha`를 fetch한다. merge-base와 head 사이의 diff와 commit 목록을 artifact로 저장한 뒤 작업공간을 삭제한다. 따라서 자동 분석 시점에는 base commit을 읽을 수 있지만 Chat 시점에는 diff 밖의 기존 구현을 다시 조회할 수 없다.

## 목표

Review Chat을 기존 report 설명과 코드 기반 추가 분석의 두 단계로 운영한다.

- 단순 질문은 기존 report와 선택한 unit만 사용해 빠르게 답한다.
- 동작 변화, regression, 호출 관계, 기존 test coverage처럼 코드 확인이 필요한 질문은 exact revision의 관련 context를 확장한다.
- 답변에 사용한 base/head 코드, diff, symbol, relation, test와 review unit을 turn 단위로 기록한다.
- 답변 citation은 실제 모델 입력에 포함된 context unit만 가리킨다.
- 관련 범위를 확보하지 못했으면 추측하지 않고 누락된 file, revision, analyzer와 제한 사유를 표시한다.

## Context 데이터 모델

Context는 전체 repository 복사본이 아니라 immutable snapshot에 연결된 작은 단위로 저장한다.

### `context-manifest.v1`

한 번의 추가 분석에서 사용한 context pack의 provenance와 budget을 기록한다.

```ts
type ContextManifest = {
  schemaVersion: 1;
  id: string;
  analysisId: string;
  snapshotId: string;
  questionMessageId: string;
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  scope: {
    findingId?: string;
    fileId?: string;
    symbolId?: string;
    side?: "mergeBase" | "head";
    startLine?: number;
    endLine?: number;
  };
  units: ContextUnitRef[];
  omitted: ContextOmission[];
  budget: {
    maxBytes: number;
    maxTokens: number;
    usedBytes: number;
    estimatedTokens: number;
  };
  plannerVersion: string;
  createdAt: string;
};
```

### `context-unit.v1`

모델에 전달할 수 있는 최소 근거 단위다.

```ts
type ContextUnit = {
  schemaVersion: 1;
  id: string;
  kind:
    | "review-unit"
    | "diff-hunk"
    | "source-range"
    | "symbol"
    | "relation"
    | "test"
    | "commit";
  snapshotId: string;
  fileId?: string;
  path?: string;
  side?: "mergeBase" | "head";
  commitSha?: string;
  startLine?: number;
  endLine?: number;
  symbolId?: string;
  relationIds?: string[];
  content: string;
  checksum: string;
  byteSize: number;
  source: "snapshot" | "git-show" | "analyzer" | "report";
  truncated: boolean;
};
```

동일 snapshot, commit, path, line range, planner version으로 만든 unit은 checksum으로 재사용한다. Chat message에는 context manifest ID와 실제 citation unit ID를 연결한다. 원문 전체를 `chat_messages` JSON에 중복 저장하지 않는다.

## Base branch 조회

### 원칙

- 사용자가 말하는 base branch의 실제 분석 기준은 변경 가능한 branch 이름이 아니라 snapshot에 고정된 `baseSha`와 `mergeBaseSha`다.
- Worker만 Git credential과 임시 clone을 사용한다. Server의 Chat HTTP request가 직접 clone하거나 credential을 읽지 않는다.
- `git show <sha>:<path>`, `git grep`과 symbol index 생성처럼 read-only command만 허용한다.
- Git hook, submodule recursion, LFS smudge와 repository 내 executable은 실행하지 않는다.
- 질문에서 받은 path, ref나 command를 Git argument로 직접 사용하지 않는다. DB에 저장된 full SHA와 snapshot file identity를 기준으로 argument를 구성한다.
- 임시 clone은 job 종료 시 삭제하고 필요한 source range만 artifact에 저장한다.

### 처리 흐름

1. Server가 질문과 선택 scope를 저장하고 `chat.context.prepare` job을 생성한다.
2. Worker가 analysis에서 repository, credential, `baseSha`, `mergeBaseSha`, `headSha`를 확인한다.
3. repository를 임시 작업공간에 초기화하고 세 SHA를 exact ref로 fetch한다.
4. 선택 finding 또는 file의 diff hunk를 시작점으로 base/head source range를 조회한다.
5. import, 직접 caller/callee, 관련 test 후보를 bounded graph로 확장한다.
6. context unit과 manifest를 artifact store에 commit한다.
7. Chat generation job이 manifest에 포함된 unit만 읽어 모델을 호출한다.
8. 답변과 citation을 저장하고 SSE로 완료 상태를 전달한다.

Repository별 bare mirror cache는 후속 최적화로 둔다. 먼저 turn마다 격리된 partial clone으로 정확성과 credential 경계를 검증한다. Cache를 도입할 때도 tenant·credential·origin이 같은 경우에만 공유하고 TTL, 최대 크기와 동시 fetch lock을 둔다.

## Context planner

Planner는 질문 유형과 현재 selection으로 context를 단계적으로 확장한다.

| 우선순위 | 입력 | 용도 |
| --- | --- | --- |
| 1 | 선택한 `unit-comment-block`, Overall Summary | 기존 지적 설명 |
| 2 | anchor의 base/head diff hunk와 주변 line | 변경 전후 동작 비교 |
| 3 | 선택 symbol의 base/head 정의 | 구현 변화 확인 |
| 4 | 직접 incoming/outgoing relation | 호출자와 영향 범위 확인 |
| 5 | 관련 test symbol과 변경 hunk | 검증 여부와 gap 확인 |
| 6 | nearby commit metadata | 변경 의도 보조 정보 |

질문에 finding이 없어도 file, symbol 또는 현재 diff selection에서 계획을 시작할 수 있어야 한다. 아무 scope도 없으면 report와 changed file 목록으로 후보를 좁히고, 여러 file을 무제한으로 읽지 않는다.

기본 budget은 운영 설정으로 관리한다. 첫 구현 기준은 context 128 KiB, 최대 12개 source range, relation 2 hop, test file 6개다. Token budget에 도달하면 낮은 우선순위 unit을 제외하고 manifest의 `omitted`에 사유를 남긴다.

## 답변 계약

- 답변은 `report interpretation`과 `additional code analysis`를 구분한다.
- base 동작을 설명할 때는 `mergeBase` 또는 `baseSha`, 변경 후 동작은 `head`를 citation에 명시한다.
- finding이 없는 영역을 새로 분석했다면 기존 finding인 것처럼 표시하지 않는다. Chat에서 발견한 후보는 `follow-up observation`으로 표시한다.
- merge 차단이 필요한 새 finding은 Chat 답변만으로 report를 수정하지 않는다. 별도의 재분석 또는 review unit 승격 절차를 거친다.
- citation은 `fileId`, side, commit SHA, line range, artifact checksum을 포함하고 클릭 시 같은 analysis의 Code와 Evidence를 이동시킨다.
- 사용한 코드가 없으면 “코드 확인 완료” 같은 표현을 금지한다.

## Backlog

### A. Context provenance 기반

- [ ] `context-manifest.v1`, `context-unit.v1` contract와 validation 추가
- [ ] `chat_turn_contexts`에 question/answer message와 manifest artifact 연결
- [ ] context artifact lifecycle을 snapshot retention과 함께 처리
- [ ] context manifest 조회 API와 authorization 추가
- [ ] context byte/token/omission telemetry 추가

완료 조건: Chat 답변 한 건에서 어떤 revision의 어떤 unit을 모델에 전달했는지 manifest만으로 재현할 수 있다.

### B. Exact revision source provider

- [ ] 기존 Git runner를 read-only source provider로 분리
- [ ] `baseSha`, `mergeBaseSha`, `headSha` exact fetch와 identity 검증
- [ ] `git show` 기반 text file/range 조회와 binary·large file 제한
- [ ] rename의 previous path와 deleted file의 merge-base 조회
- [ ] credential/origin/tenant 격리와 임시 workspace 정리 test
- [ ] fetch 실패, shallow history 부족, file 부재를 typed omission으로 반환

완료 조건: 수정·추가·삭제·rename file에 대해 snapshot과 일치하는 base/head source range를 반환하고 repository 코드는 실행하지 않는다.

### C. Bounded context planner

- [ ] finding/file/symbol/diff selection을 planner seed로 지원
- [ ] review unit, diff hunk와 source range 결합
- [ ] direct relation과 관련 test 후보 확장
- [ ] 질문 의도에 따른 단계별 retrieval과 고정 budget 적용
- [ ] 중복 range 병합, checksum 재사용과 omission 기록
- [ ] prompt-injection guard를 모든 repository context 앞에 고정

완료 조건: 같은 snapshot·질문·scope·planner version에서 동일한 manifest를 만들며 budget을 초과하지 않는다.

### D. Advanced Chat execution

- [ ] `chat.context.prepare`와 `chat.generate` job 분리
- [ ] queued/retrieving/analyzing/streaming/completed/failed 상태 제공
- [ ] SSE streaming, stop, reconnect와 retry 구현
- [ ] Account/Model/Effort 변경 시 명시적인 새 session 시작
- [ ] context 준비 실패 시 기존 report-only 답변으로 낮춘 이유 표시
- [ ] 새 observation의 재분석 요청 또는 review unit 승격 command 설계

완료 조건: 긴 질문이 HTTP request timeout에 종속되지 않고, 새로고침 후에도 진행 상태와 완성 답변을 복구한다.

### E. Workspace 통합

- [ ] Code 옆 compact Findings panel에서 `unit-comment-block`과 diff를 동시에 표시
- [ ] Chat scope chip에 finding, file:line, symbol, side와 SHA 표시
- [ ] 질문 전 예상 context 범위와 제한 표시
- [ ] citation 선택 시 exact Code line과 Evidence context unit으로 이동
- [ ] base/head 비교 citation을 시각적으로 구분
- [ ] 사용된 context와 제외된 범위를 답변별로 펼쳐 확인

완료 조건: 초기 workspace 시안처럼 finding, 변경 코드와 Chat 추가 분석을 한 화면에서 연결해 사용할 수 있다.

## 검증 시나리오

1. 기존 동작 regression 질문: merge-base 구현과 head 변경을 함께 인용해 동작 차이를 설명한다.
2. finding이 없는 변경 질문: 선택한 diff에서 source context를 수집하고 기존 report에 없는 관찰임을 표시한다.
3. test coverage 질문: 관련 test가 있으면 근거 line을, 없으면 검색 범위와 omission을 표시한다.
4. 삭제 file 질문: head가 아니라 merge-base path와 line을 사용한다.
5. rename 질문: previous path의 base와 새 path의 head를 연결한다.
6. large/binary file 질문: 내용을 모델에 보내지 않고 제한 사유를 반환한다.
7. stale branch 질문: 현재 branch tip이 바뀌어도 snapshot의 exact SHA만 사용한다.
8. 권한 회수: 기존 session과 context manifest를 포함해 repository data를 더 이상 조회하지 못한다.
9. prompt injection: repository text가 system instruction이나 retrieval policy를 변경하지 못한다.
10. 재현성: 답변에 연결된 manifest의 checksum과 citation이 보존된 artifact와 일치한다.

## 범위 밖

- repository code, test, build script 실행
- 사용자 질문을 shell 또는 Git command로 직접 변환
- 전체 clone을 장기 artifact로 보관
- Chat 답변만으로 canonical report나 PR 게시 결과 변경
- 다른 analysis revision이나 권한이 다른 repository context 혼합
