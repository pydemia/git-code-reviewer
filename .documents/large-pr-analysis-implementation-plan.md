# 대형 PR 분석 계획

작성: 2026-09-19. PR #1024의 PRISM-DEV 저장 결과와 alpha.67 코드를 대조했다. 이 문서는 분석 엔진의 후속 구현 계획이며 아래 LP01~LP05는 아직 구현하지 않았다. 새 PR 생성, 모델 재호출, 외부 PR 댓글 게시는 수행하지 않았다.

## 확인한 현상

PR #1024의 고정 snapshot은 `d71a259f-b82f-42f4-b5fe-20259e41ccc5`, analysis는 `a0b82489-d0df-462b-97fe-a64f6315b80f`다. base는 `a04ec3e38bebc183b4e584e71da15bd06e406c29`, head는 `b558c56c1f3f20d141563f2dd5a33bffb656c7af`다.

| 항목 | 저장 결과 |
| --- | --- |
| 변경 파일 | 1,045개: 추가 1,005, 수정 40 |
| 검토 완료 / 일부 / 미검토 | 26 / 4 / 1,015 |
| 분석 상태 | partial, published, progress 100 |
| 파일 선택 한도 / 모델 호출 한도 | 500 / 128 |
| HTTP 요청 완료 기록 | 127회; 실패·중단·예약 잔류 0 |
| 저장 checkpoint | unit-comment-block 100, overall-summary 27 |
| 모델 | 등록된 ChatGPT 계정, gpt-5.6-terra, medium, 동시성 4 |
| 전체 patch | 2,894,826 bytes; 10 MiB 제한보다 작음 |
| 주요 파일 | Python 610, SQL 314, yml 80 |

`filesProcessed=1045`는 루프에서 파일을 처리했다는 뜻이다. 미검토 파일까지 검토 완료했다는 뜻이 아니다. HTTP 완료 기록도 출력의 의미적 검증을 보장하지 않는다. 이번 실행에는 429 실패가 기록되지 않았으며 직접 원인은 파일·호출·문맥 한도다.

저장 snapshot에 현재 planner만 적용하고 모델은 호출하지 않았다. 가장 큰 500-line window를 사용해도 첫 500파일에는 unit 578개와 파일 요약 465개, PR 요약 1개로 최소 1,044회가 필요하다. 전체에는 unit 1,079개, 파일 요약 950개, PR 요약 1개로 최소 2,030회다. 재시도는 제외한 현재 방식의 산술 추정이며 새 묶음 방식의 실제 호출량 예측은 아니다. 분석 window가 없는 파일도 95개다.

현재 제약의 위치:

- `packages/analysis-engine/src/index.ts`: 파일 500개 선택 및 byte 한도. 관계 그래프는 선택된 diff 중심이며 모델 작업 분할에 사용하지 않는다.
- `packages/analysis-engine/src/skill-review.ts`: 파일별 window → 파일별 별도 요약 → 전체 요약. 모든 파일의 안내문까지 최종 요약에 들어가 문맥 한도를 소비한다.
- `apps/runtime/src/services/analysis-source-context.ts`: 첫 요청 파일의 주변 코드 중심이며 전체 분석에서 source context 한도를 공유한다.
- `apps/runtime/src/services/model-admission.ts`: 계정별 DB admission, RPM·input bytes와 cooldown이 있지만 작업을 내구성 있게 대기시키는 단위가 분석 그룹이 아니다.
- `apps/runtime/src/services/analysis-checkpoint.ts`: 성공 요청 재사용은 가능하지만 미완료 그룹을 직접 재개하는 작업 목록이 없다.
- `apps/runtime/src/worker.ts`: 저장 보고서가 있으면 분석을 반환한다. partial 보고서를 발행한 뒤 남은 작업만 재개하기 어렵다.
- `packages/git-engine/src/index.ts`: 변경 목록의 2,000파일 절단도 제거하거나 명시적인 미완료 상태로 바꿔야 한다.

## 처리와 완료의 정의

변경 목록 전체를 base/head에 고정한 manifest로 먼저 저장한다. 각 파일에는 필요한 검토 의무와 상태를 둔다. 모든 의무가 검증된 결과를 가져야 `reviewed`가 된다. 그룹 응답에서 파일이 빠졌다는 이유로 정상 판정하지 않는다.

binary·생성물·lock·민감 파일은 기존 제외 정책과 그 이유를 보존한다. 제외된 파일을 AI 검토 완료로 집계하지 않는다. 빈 파일, rename, mode 변경에는 메타데이터·경로·패키지 경계 확인이 필요할 수 있으므로 빈 patch만으로 자동 정상 판정하지 않는다. 검토 불필요 판정과 검토 완료는 별도 상태다.

화면은 전체 파일 수, 검토 완료, 검토 불필요, 대기, 실행 중, 재시도 대기, 예산 대기, 실패를 구분한다. 처리율과 검토 커버리지를 분리하며 미완료 의무가 있는 상태를 검토 100%로 표시하지 않는다. 파일 목록·댓글 본문에는 실제 의견이 있는 파일을 기본 표시하고 내부 manifest에는 전체 기록을 남긴다.

## 영향 관계에 따른 작업 분할

1. 전체 manifest에서 import·호출부·계약·SQL table 사용·설정 참조·테스트 연결을 수집한다. Python/SQL/config가 이번 PR의 우선 대상이다. 정적 분석과 저장소 읽기만 사용하며 대상 코드를 실행하지 않는다. 경로·동일 디렉터리는 약한 보조 신호로 다룬다.
2. 변경된 생산자와 소비자, 인터페이스와 구현, SQL schema와 query, 설정과 사용처, 대응 테스트를 묶는다. 변경되지 않은 호출부와 계약도 허용된 source 범위에서 문맥으로 가져온다. 참고로 읽은 파일을 변경 파일 검토 완료 수에 넣지 않는다.
3. 각 변경 파일/변경 영역에는 하나의 주 검토 작업을 배정한다. 참고 문맥은 중복 사용해도 된다. 그룹 사이에 잘린 영향 관계는 명시적인 경계 검토 작업으로 남긴다.
4. 큰 순환 관계나 파일은 symbol·계약 단위로 나누고 경계 검토를 연결한다. context가 크다는 이유로 뒷부분을 버리지 않는다. 관계 추정의 확실성과 미해결 참조를 기록한다.
5. 각 요청에 작업 ID, 대상 영역, 제공 문맥 hash, 기대 coverage 목록을 넣는다. 응답의 파일·line·coverage·중복 finding을 서버에서 검증한다. 누락은 남은 작업으로 유지한다.

문맥 예산은 코드 bytes만 세지 않는다. system/Skill/프롬프트, 변경과 참고 코드, 이력, 출력 schema, 예상 출력·reasoning 여유까지 모델별 tokenizer 또는 보수적인 추정으로 계산한다. provider의 context 한도와 별도 안전 여유를 적용한다. 허용되지 않는 파일의 내용은 모델에 전달하지 않는다.

## 저장·재개·요약

기존 PostgreSQL job·lease·checkpoint를 확장한다. 별도 broker나 provider framework를 만들지 않는다. analysis 아래에 manifest, 계획 revision, 그룹/경계/요약 task, task dependency, attempt, nextAttemptAt, inputHash, 결과를 저장한다.

- 상태: pending → ready → running → validated-complete. retry-wait, budget-wait, failed, cancelled는 완료가 아니다.
- lease 소유자와 입력 hash를 확인하고 결과·coverage를 원자적으로 확정한다. worker 재시작은 미완료 작업만 재개한다. 이미 검증된 작업은 재호출하지 않는다.
- 네트워크의 exactly-once는 보장하지 않는다. 요청 결과를 받기 전 연결이 끊긴 경우 비용과 실행 여부가 불확실할 수 있다. 가능한 provider idempotency와 로컬 결과 중복 방지를 구분한다.
- base/head, 모델·reasoning, prompt/Skill/지침 revision, 문맥 hash를 고정한다. 입력이 바뀌면 새 계획 revision을 만들고 영향을 받는 작업만 무효화한다.
- 기존 5분 manifest 유효기간과 권한 철회를 유지한다. 재개 시 권한과 유효성을 확인하고 동일 content revision의 권한 확인만 갱신할 수 있다. 철회·만료 자료를 무조건 재사용하거나 서로 다른 revision의 결과를 섞지 않는다.
- 그룹 결과에서 파일별 의견과 요약을 추출한다. 파일마다 별도 요약 호출을 기본으로 추가하지 않는다. 그룹 → subsystem → PR의 계층 요약으로 제한된 문맥을 유지한다.
- 요약 실패로 검증된 코드 의견을 버리지 않는다. 코드 검토와 요약 상태를 나누고 partial 결과를 저장·열람한 뒤 남은 작업을 계속할 수 있게 한다. 재개와 댓글 갱신은 기존 head·권한·중복 방지 검사를 재사용한다.

## 호출 한도와 실패 처리

계정/endpoint의 실제 quota 범위를 키로 기존 DB admission을 공유한다. 분석·chat이 같은 계정을 사용하면 공통 제한을 적용한다. RPM과 input/output token 예산, 동시 실행 수, 실제 usage를 함께 기록한다. usage가 제공되지 않으면 추정치임을 표시한다. 동일 계정을 사용하는 외부 클라이언트의 사용량을 완전히 알 수 없다는 제한도 남긴다.

동시성은 1에서 시작해 관측된 성공과 지연을 바탕으로 기존 상한 4 안에서 증가시킨다. 429에서는 동시성을 낮추고 계정 공통 cooldown과 jitter를 적용한다. 이 값은 첫 구현의 보수적인 운영 정책이며 실제 모델 한도를 뜻하지 않는다.

| 응답/상태 | 처리 |
| --- | --- |
| 429, Retry-After | 서버가 지정한 시각 전에는 재호출하지 않는다. 긴 대기는 task의 nextAttemptAt에 저장하고 worker 슬롯을 반환한다. |
| 일시적 5xx·네트워크·timeout | 제한된 exponential backoff+jitter, attempt/누적 시간/비용 상한 기록 |
| context 초과·413 | 그룹/문맥 재분할; 같은 큰 입력을 반복 전송하지 않음 |
| 401·403·계정 quota/billing 문제 | 운영자 조치 대기. 다른 계정이나 모델로 우회하지 않음 |
| 잘못된 schema·coverage 누락 | 실패 원인 기록, 제한된 repair 또는 누락 영역 분할; 성공으로 기록하지 않음 |
| 전체 작업 예산 소진 | budget-wait에 남겨 예산 승인/수정 후 재개; 나머지 파일을 skipped로 완료하지 않음 |

SDK와 worker의 중첩 재시도로 호출 수가 증폭되지 않게 재시도 책임을 한 곳에서 관리한다. OpenAI 공식 문서도 실패 요청이 제한을 소비할 수 있음과 jitter를 포함한 backoff를 설명한다. 다만 현재 provider는 ChatGPT 등록 계정이므로 공개 API의 quota·headers·Batch API 지원을 그대로 가정하지 않는다. [OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits), [429 guidance](https://help.openai.com/en/articles/5955604).

## 단계와 commit

| 단계 | commit 단위 | 완료 조건 |
| --- | --- | --- |
| LP00 표현 정리 | 의견 없는 파일·빈 line 안내 숨김; 별도 PR 알림 P2/P3 설정 | 원본 coverage/보고서 유지, 실제 의견만 목록·댓글 표시, 분석 강도와 독립 |
| LP01 전체 목록·내구성 | C01 무절단/NUL-safe manifest 및 DB migration; C02 task/lease/coverage와 partial 재개 | 2,000개 초과 synthetic 목록도 누락 없음, worker 중단 후 검증된 결과 재사용, 실패가 완료율에 포함되지 않음 |
| LP02 영향 그룹 | C01 Python/SQL/config 정적 관계; C02 context/token 예산·분할; C03 경계 검토·응답 coverage 검증 | 고정 #1024 snapshot의 모든 의무에 담당 task 존재, 문맥 상한 준수, 호출·계약을 가로지르는 결함 fixture 검출 |
| LP03 admission·재시도 | C01 quota/usage 예산; C02 durable retry/cooldown; C03 적응 동시성·예산 대기 | 429·장시간 Retry-After·timeout·5xx·권한 오류 주입 시 폭주 없이 재개, 계정 간/공유 계정 경계 검사 |
| LP04 집계·화면·게시 | C01 그룹/계층 요약; C02 커버리지·대기 상태 화면; C03 partial 이후 최종 댓글 갱신 | 검토율의 의미가 일치, 요약 실패에도 검토 결과 보존, 의견 없는 파일을 나열하지 않음, P2/P3 알림·권한·중복 방지 유지 |
| LP05 검증·배포 | C01 fault/recovery 회귀와 운영 절차; C02 artifact/Helm release; C03 bounded 실제 PR 검증 기록 | 명시된 범위의 실제 모델 검증, 전체 파일의 종결 상태와 미완료 사유 대조, source/image/chart 연결 |

문서·코드·배포 commit을 구분한다. LP01의 task/lease 계약을 먼저 확정한 뒤 LP02·LP03을 연결한다. LP00은 이번 변경에 포함하며 LP01~LP05 구현은 별도 작업으로 진행한다.

## 검증과 실행 한도

기존 worker recovery, model admission, checkpoint, publication/head/권한 회귀를 우선 재사용한다. 1,045개 실제 snapshot의 순수 계획 검증과 2,000개 초과 synthetic manifest 검증을 구분한다. boundary를 넘는 실제 결함·수정된 변경·무관한 변경을 fixture로 준비하고 모든 대상이 coverage에 남는지 확인한다. 민감 파일 제외, 취소, job 종료 후 lease·예약 반환도 검사한다.

실제 #1024 재분석 전 고정 SHA, 그룹 수, 예상 입력/출력 token, 요청 상한, 시간·비용 상한, rate 정책, partial에서 재개할 범위를 기록한다. 기존 저장 결과를 덮어쓰지 않는다. 이번 조사에는 추가 모델 호출과 외부 게시가 각각 0회이며, 전체 재분석 완료나 rate limit 회피 성능을 검증했다고 표시하지 않는다.

이번 읽기 전용 증거는 `artifacts/operations/large-pr-1024-2026-09-19/read-only-state.json`과 `plan-size.json`에 저장했다. 원문 코드·계정 token을 문서에 복사하지 않았다.
