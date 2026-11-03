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

## PRISM-DEV 배포

2026-10-16 KST에 source `e047719c84c76cba56c5028fa40cceae2465ce81`을 application `0.8.0-alpha.87`, chart `0.10.83`으로 배포했다. Image index digest는 `sha256:ff39d1f5a435cb03d1d492cfe77e062af7c257c5956679b74b36b32ef87003a8`, OCI chart digest는 `sha256:616189726f744dacfc47d0dc141232df1018f5b94d92d86d0d36bb9a45635023`이다. 게시 chart를 다시 받아 package SHA-256 `9d4a7bb4a751496ebd58bd56c038e433223e7e5c3e3086628aa4ef90dd6e97d2`가 원본과 같은지 확인했다.

최종 Helm revision은 100이다. Server·Worker가 같은 image digest로 Ready이고 restart는 0회다. Migration `0062_review_test_code.sql`이 적용됐으며 사용자 12명, 활성 저장소 2개, 기존 보고서 104건을 유지했다. 기존 두 저장소의 설정은 기본값인 source-only로 이관됐다. 내부 live·ready·dependencies가 모두 HTTP 200·ok이고, 공개 HTTP와 개발 CA로 검증한 HTTPS에서 `/api/v1/system`이 `0.8.0-alpha.87`을 반환했다. 최종 revision의 Helm connection test도 성공했다.

첫 revision 96은 환경 values 파일에 없는 기존 override를 chart 기본값으로 되돌렸다. revision 97에서 이전 TLS 값을 바로 복구하려 했으나, 이미 TLS가 꺼진 PostgreSQL에 pre-upgrade migration이 TLS로 접속해 실패했고 자동 rollback revision 98이 적용됐다. Revision 99에서 hook 없이 revision 95 values를 복원하고 PostgreSQL·Server·Worker를 순서대로 재기동한 뒤, revision 100의 정상 migration hook upgrade를 통과했다. 최종 revision 100과 revision 95의 image 외 user values·computed values 변경 경로는 0건이고 PostgreSQL `ssl=on`을 확인했다. 같은 문제가 반복되지 않도록 PRISM-DEV runbook은 현재 release values를 먼저 병합하도록 수정했다.

배포 시작 당시 대규모 분석은 881개 durable task 중 204개를 처리하고 있었다. Worker 교체 뒤 211개 `completed`, 1개 `failed`, 4개 `running`, 665개 `pending` checkpoint가 남아 있으며 job은 다른 실행 뒤 재개할 수 있도록 queued 상태다. 이를 분석 완료로 기록하지 않는다.

Source·release commit push는 GitHub 인증 계정 `skax-yj-kim1`에 `pydemia/git-code-reviewer` 쓰기 권한이 없어 HTTP 403으로 거절됐다. Image·chart 게시와 PRISM-DEV 배포는 완료됐지만 commit은 이 checkout에만 있다.
