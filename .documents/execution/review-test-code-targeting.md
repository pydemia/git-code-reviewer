# Test code review targeting

## 동작

- Repository의 `테스트 코드도 검토 대상에 포함` 기본값은 꺼짐이다.
- 꺼진 상태에서도 변경된 테스트 코드는 관련 일반 코드 검토의 comparison source로 사용할 수 있다. 테스트 코드에는 finding을 만들지 않는다.
- 켜면 일반 분석에서 일반 코드를 먼저 검토하고 테스트 코드를 뒤에 검토한다.
- 파일 수 또는 diff 크기가 기존 대규모 분석 기준을 넘으면 설정이 켜져 있어도 테스트 코드는 source-only로 전환한다. 현재 기본 파일 수 기준은 50개다.
- 분석 생성 시 설정값을 `analysis_runs`에 고정한다. 이후 repository 설정을 바꿔도 queued·resume·re-analysis 입력은 바뀌지 않는다.

## UI reference

기존 GHES repository 카드의 `PR 댓글 알림 등급` form을 기준으로 같은 설정 흐름과 label/help 구조를 재사용했다. 별도 배너나 카드 계층은 추가하지 않았다. 등록 form에서는 초기값을 선택하고, 등록 후에는 repository 카드의 checkbox에서 다음 분석부터 적용할 값을 바꾼다.

## 검증 범위

- 경로 분류가 `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`, Python·Go·Java 관례를 인식하고 `contest.ts`, `latest.py`를 오인하지 않는지 검사한다.
- 기본 source-only, 설정 포함 시 일반 코드 우선, 대규모 분석의 자동 source-only 전환을 합성 model adapter로 검사한다.
- PostgreSQL migration과 repository PATCH/list 왕복을 격리 DB에서 검사한다.
- Web 설정의 label, 현재 값, 대규모 분석 설명을 server-rendered markup으로 검사한다.
