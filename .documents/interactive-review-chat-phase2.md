# Interactive Review Chat 2차 구현

2026-09-09. 대상은 P6–P10이다. 코드 수정·테스트 실행 agent와 자동 PR 작성은 포함하지 않는다.

코드는 alpha.23·Helm revision 34에 배포했다. 실제 AI의 과거 대화/근거 재조회·질문 응답·workspace 재사용과 완료 답변을 확인했다. 실제 desktop/mobile 브라우저 조작은 Mac 잠금으로 미완료다. 단계별 검증과 조정 범위는 [검증 기록](verification-interactive-chat-phase2-2026-09-09.md)을 따른다.

| 단계 | 구현 범위 | 검증 기준 |
| --- | --- | --- |
| P6 | unit·파일 요약·전체 요약의 모델 결과 checkpoint, job fencing, 만료 lease 회수, 배포 시 단계 경계 drain | 재시작 후 완료된 동일 입력은 모델에 재전송하지 않으며 stale attempt는 report를 확정하지 못한다. 복구는 최대 3회이며 기존 모델 ledger를 유지한다. |
| P7 | 권한·origin·credential version·exact SHA 기준 workspace 재사용, DB lease와 정리 잠금 | 질문·capacity 재개 시 같은 workspace를 재사용하고 사용 중 workspace는 삭제하지 않는다. 다른 credential/user는 공유하지 않는다. |
| P8 | 출처가 있는 대화 압축, 이전 사용자 결정·질문 보존, 원문 재조회 | 오래된 대화를 말없이 버리지 않고 생략 범위와 원문 조회 경로를 남긴다. 개인 메모리는 공유하지 않으며 집단 우선 규칙을 유지한다. |
| P9 | symbol 정의·호출 후보·관련 테스트 구분 | exact revision/path/line 근거를 반환하고 lexical 후보를 검증된 호출 graph나 실행 결과로 표현하지 않는다. |
| P10 | 이전 run 목록·질문·근거 복원, 진행 run과 과거 선택 분리 | 과거 답변에서 당시 SHA·소스를 열고 최신 실행을 계속 구독한다. 새로고침 복원과 권한 철회를 검증한다. |

운영의 과거 수동 복구 job 두 건은 이번 작업 시작 시 모두 completed로 확인했다. Mac 잠금으로 실제 브라우저 검증은 잠금 해제 후 수행해야 한다. 합성 테스트와 실제 AI·화면 검증은 별도로 기록한다.
