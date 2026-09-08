# 파일 AI review 미완료 원인과 재분석

## 확인된 원인

PR #917의 최근 미완료 두 분석은 checkpoint 도입 전 실행됐다. 배포로 Worker가 바뀔 때 완료된 모델 검토를 재사용하지 않고 앞부분부터 다시 호출했다. 분석별 누적 ledger는 올바르게 유지됐지만 각 attempt의 논리 호출 counter가 초기화돼 누적 128회 한도에 먼저 도달했다.

| 기존 analysis | 파일 완료 | Window 완료 | Ledger 요청 | Checkpoint | Job attempt |
| --- | --- | --- | --- | --- | --- |
| `c3dfc29c-b34e-4214-b3a1-e8375179d30f` | 3/25 | 8/64 | 128 (completed 126, sent 2) | 0 | 4 |
| `3ca8e253-9366-465d-80d7-3744233cd095` | 14/26 | 29/64 | 128 (completed 128) | 0 | 4 |

첫 분석의 파일 21개, 두 번째 분석의 파일 11개가 `이 파일의 AI review를 완료하지 못했습니다.`로 표시됐다. 한도 초과가 일반 `MODEL_CALL_FAILED`로 취급되어 의미 없는 재시도까지 발생했다. Job의 completed는 결과 저장 성공을 뜻하며 파일 검토 완료와 같지 않다. 이 report들은 partial이다.

## 수정 범위

- alpha.23의 checkpoint·lease fencing·drain을 유지한다. 같은 analysis와 동일한 입력의 성공 응답은 재시작 후 모델을 다시 부르지 않고 재사용한다.
- 누적 모델 호출 한도·입력 크기·인증 실패는 재시도하지 않는다. Timeout·계정 capacity 대기·잘못된 JSON 응답은 남은 예산 안에서 한 번 재시도한다.
- 파일별 미완료 요약에 확인된 원인과 후속 조치를 표시한다. Provider 오류 원문·credential·source는 노출하지 않는다. 미검토를 안전 판정으로 바꾸지 않는다.
- 과거 report·artifact·ledger는 그대로 보존한다. 새 revision에만 새 결과를 저장한다.
- 승인된 운영 재분석은 `queueIncompleteAnalysisReanalysis`로 수행한다. HTTP API에 노출하지 않는다. 공동 partial/failed 분석만 대상으로 snapshot·Prompt·Provider·Skill·Memory를 고정해 복제한다. 같은 source/request UUID의 재호출은 같은 결과를 반환한다.
- 재분석 job에 `skipPublication: true`를 저장한다. Worker 복구 뒤에도 유지하며 report를 GitHub에 자동 게시하지 않는다. 다른 정상 분석의 게시 설정은 바꾸지 않는다.
- 같은 snapshot의 revision 목록을 내림차순으로 정렬하고 진행/완료 event에 실제 revision 번호를 사용한다.

기존 요청 ledger를 삭제하거나 한도를 초기화해 복구하지 않는다. 새 revision도 누적 128회 한도를 적용한다. 기존 결과를 보기만 하면 과거 문구는 계속 보인다.

## 검증

UTF-8 로컬 PostgreSQL에서 전체 66개 파일·413개 테스트를 통과했다. 25개 파일·64개 window를 가진 합성 분석을 30회와 60회 시점에 drain하고 새 Worker로 두 번 재개했다. 최종 25/25 파일, 64/64 window, 파일/전체 요약을 포함한 실제 mock 요청 90회로 완료했다. Ledger와 checkpoint를 재사용했으며 128회 한도를 늘리거나 초기화하지 않았다.

통합 테스트에서 새 revision 생성의 동시·반복 호출 중복 방지, 입력 pin 보존, 기존 report 불변, revision event와 자동 GitHub 게시 0건을 확인했다. 합성 테스트는 실제 모델의 PR 전체 검토와 구분한다. 사용자 승인에 따른 PR #917 실제 재분석 결과는 배포 후 이 문서에 기록한다.
