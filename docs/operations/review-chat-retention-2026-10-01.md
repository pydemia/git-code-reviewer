# Review Chat 소스 준비 개선과 merged review 보존 정책 — PRISM-DEV

2026-10-01 KST에 Git Code Reviewer `0.8.0-alpha.86`을 PRISM-DEV에 적용했다. Helm chart는 `0.10.82`, revision은 95다. 배포 source는 `5000992caa3d48438b232358ff20f4e085a117ec`이며, image index digest는 `sha256:a7fafbcba83722d7d9eb65ce0e676e7f34b45f477202a4e44eb5465176b624f3`이다. OCI chart digest는 `sha256:aeab15a16931245003f65917512113e33997cebc0813f158c5c3bb88ed56e09d`이다. 게시 chart를 다시 받아 원본 패키지와 SHA-256 `4c767e98d171b49c43507f6d846f68afec6519277e1819b99f839b394347a0d4`로 일치함을 확인했다.

Chat의 기존 exact-SHA workspace를 재사용할 때 Git credential 조회와 전체 크기 재탐색을 건너뛴다. 새 workspace는 세 revision의 파일을 각각 쓰지 않고 Git 객체를 보관한다. `search_code`와 `find_related_code`는 blob을 최대 128개·4 MiB씩 묶어 읽는다. 기존 materialized workspace는 TTL 동안 계속 읽는다. 배포 전 Worker 캐시의 workspace 세 개에는 각각 11,632·11,632·3,024개의 파일 기록이 있었다. 실제 Chat 응답 시간은 이번 배포에서 모델 호출로 측정하지 않았다.

Merge 완료 PR의 review·Chat·snapshot은 merge 후 7일 또는 저장소별 최신 30개 초과 시 정리한다. 진행 중인 작업과 참조 중인 분석은 보호하고, PR이 다시 열리면 삭제 유예 중인 artifact claim을 복구한다. PR 메타데이터는 보존한다. 기존 report 90일·Chat 30일 정책과 artifact 삭제 유예 1시간은 유지한다. 적용 전 읽기 전용 조회에서는 merged PR 1,238건에 연결된 분석 319건, snapshot 317건, Chat 62건, artifact 논리 크기 156,298,536바이트가 새 정책 대상이었다.

08:00 UTC 첫 retention CronJob은 Chat 62건과 artifact가 없는 분석 8건을 삭제했다. 분석 311건의 artifact는 삭제 유예로 claim했고, snapshot 8건의 artifact도 claim했다. 직후 조회에서 남은 대상은 분석 311건·snapshot 317건·Chat 0건이며, 삭제 예정 artifact는 7,254개다. 가장 이른 `delete_after`는 09:00:45 UTC다. 분석·snapshot과 실제 파일 삭제는 유예 및 이후 CronJob 실행에 따라 이어지므로 이 시점에 완료로 기록하지 않는다.

검증: 로컬 생산 빌드·타입 검사·ESLint·Helm lint, 격리 PostgreSQL retention/lease 테스트, HTTPS Git 준비 및 batch 경계 테스트를 통과했다. 게시 전 amd64 image의 읽기 전용·network-none runtime smoke를 통과했다. 배포 후 Server/Worker 각 1/1 Ready, migration `0061_merged_review_retention.sql` 적용, Server live·ready·dependencies 내부 HTTP 200, Helm connection test 성공을 확인했다. 새 Worker의 native Linux sandbox에서 합성 Git 저장소의 `read_file`·`search_code`가 모두 200이며 실제 합성 내용과 일치했다. 테스트 workspace와 jail은 삭제했다. Mac에서 공개 HTTPS health는 신뢰할 수 있는 issuer chain을 구성하지 못해 확인하지 않았으며 TLS 검증을 우회하지 않았다.

전체 Vitest는 147개 파일 통과·40개 건너뜀·2개 실패였다. 브라우저 종료 hook 시간 초과는 단독 재실행에서 통과했고, 운영 artifact 안의 별도 테스트는 `./helpers/counted-codex.mjs` 누락으로 실패했다. 두 항목을 전체 통과로 기록하지 않는다.

Git `origin`에 포함됐던 토큰을 URL에서 제거하고 기존 macOS Keychain helper로 원격 읽기가 되는 것을 확인했다. 토큰 원문은 이 기록에 넣지 않았다. 노출됐던 토큰은 별도 교체가 필요하다. 소스 커밋 `5000992`와 배포 설정 커밋은 로컬에 남아 있으며, 현재 Git 인증 계정에 저장소 쓰기 권한이 없어 원격 브랜치 푸시는 HTTP 403으로 거절됐다. 이미 적용된 클러스터 배포와 게시된 image·chart는 이 푸시 실패와 별개다.
