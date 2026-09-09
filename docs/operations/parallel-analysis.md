# 분석 모델 선택과 병렬 처리

관리자는 `/admin?tab=provider`의 **분석 모델**에서 등록된 ChatGPT Account, Model, Reasoning effort와 파일 병렬 처리 수를 선택한다. Model·Effort는 활성 account의 허용 목록만 표시한다. 선택지를 추가하려면 ChatGPT accounts에서 실제 지원 목록을 조회하고 등록한다. 임의의 model ID를 유효한 값으로 취급하거나 effort를 자동으로 낮추지 않는다.

새 설정의 기본 병렬 수는 4개이며 1~4개로 변경할 수 있다. `low`는 속도, `high`·`xhigh`는 깊은 추론을 우선하고 `medium`은 균형 설정이다. 낮은 effort는 복잡한 결함을 놓칠 수 있으므로 같은 PR의 결과로 비교한다. Review Chat 설정과 Prompt의 Severity Level은 별도다. [OpenAI reasoning effort](https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort)

## 실행과 설정 고정

파일 단위의 bounded pool을 사용한다. 한 파일의 window → 파일 Summary 순서를 유지하면서 다른 파일은 동시에 검토한다. 모든 파일 처리가 끝나면 PR 전체 Summary를 생성한다. 결과와 제한 사유는 입력 파일 순서로 합치며 progress DB write도 순서대로 반영한다. 단일 파일만 큰 PR은 파일 내부를 병렬 처리하지 않으므로 효과가 제한된다. 이 변경은 검토 범위·요약 단계·호출 예산을 축소하지 않는다.

Account·Model·Effort·병렬 수·Timeout은 Provider version/hash에 포함한다. Snapshot materialization 후 analysis run을 생성할 때 활성 version을 고정한다. 이후 활성 설정 변경은 이미 생성된 분석을 바꾸지 않는다. Migration `0030`은 기존 version에 순차 처리 값 1을 부여하고 새로운 version의 병렬 수 변경을 금지한다. 기존 report와 analysis provider hash는 보존한다. Deployment fallback은 기존처럼 순차 처리다.

## Account 요청 제한

동일 upstream identity의 quota key는 모델을 바꾸거나 중복 account를 등록해도 공유한다. PostgreSQL row lock과 요청별 lease로 여러 Worker를 포함해 admission을 직렬화한다. Batch 요청은 호출자의 고정 병렬 수 이내로 들어가며 account 전체 최대는 4개다. 다른 version의 분석이 함께 실행되면 각 요청의 진입 기준이 다를 수 있지만 최대 4개는 넘지 않는다. Interactive Chat 요청 1개는 별도 slot이다. 이 수치는 애플리케이션 보호 한도이며 upstream의 실제 허용량을 뜻하지 않는다.

기존 account당 분당 60회·입력 1 MiB와 run별 호출 예산을 유지한다. Retry도 예산에 포함한다. 429는 Retry-After(최소 3초, 최대 30분)를 반영해 account 전체 cooldown을 저장하고 가장 늦은 cooldown을 유지한다. Slot은 response body를 모두 읽거나 취소한 뒤 반환한다. 180초 lease를 15초마다 갱신하며 만료된 요청의 뒤늦은 종료가 새 요청의 slot을 해제하지 않는다.

Rolling upgrade 동안 구 Worker의 단일 reservation을 존중하며 새 Worker는 구 Worker가 읽는 capacity row에 sentinel lease를 남긴다. 기존 Worker가 작업을 끝내기 전에 강제 삭제하지 않는다. Worker drain/lease 상실 때 새 파일 dispatch를 중지하고 실행 중 파일 task를 회수한 뒤 job을 반환한다. 기존 checkpoint와 immutable report 정책은 유지한다.

## 운영 확인

- 설정을 저장한 뒤 활성 version의 Model·Effort·병렬 수를 확인한다. 기존 PR 재분석은 새 revision과 추가 모델 사용량을 만든다.
- `model_request_ledger`의 `lane`, `created_at`, `finished_at`으로 실제 요청 중첩과 429를 확인한다. 처리 시간에는 모델·네트워크·대기가 함께 포함된다.
- 429나 계정 부하가 늘면 새 Provider version의 병렬 수를 1~2로 줄인다. 기존 실행의 고정 값은 변경하지 않는다.
- 이 작업의 배포·검증 결과는 별도 운영 기록에 남긴다. 합성 transport의 속도 비교를 실제 모델의 개선 배수로 제시하지 않는다.

## 구현 검증

2026-09-09 PostgreSQL 17을 사용한 전체 446개 테스트(73개 파일), TypeScript·ESLint·production build를 통과했다. 최종 테스트 명령은 `pnpm exec vitest run --maxWorkers=2 --hookTimeout=60000 --testTimeout=15000`이며 `GCR_TEST_DATABASE_URL`은 전용 localhost DB를 가리킨다. 최초 DB 병렬 부하에서는 migration hook과 기존 checkpoint 테스트가 timeout됐다. 짧은 15ms 지연에 의존하던 transport 테스트는 네 요청 진입을 기다리는 barrier로 수정했다. 최종 실행에서 실패·skip은 없다.

동시 admission 20개 중 batch 4개만 허용, Chat 전용 slot, run별 호출 예산 경쟁, RPM/byte 제한, 가장 긴 cooldown 보존, 만료·stale lease와 rolling 호환을 검증했다. Engine은 파일 동시 수·입력 순서·실패 후 drain·호출 예산·source workspace 단일 획득을 검증했다. Browser는 합성 account에서 저장·재로딩·모델별 Effort·이전 version 활성화를 확인했으며 Desktop 1440×1000과 Mobile 390×844 캡처를 남겼다. 운영 모델의 속도 측정이나 실제 PR 재분석 결과는 아니다.
