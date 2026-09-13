# PRISM-DEV 리뷰 지식 배포 — 2026-09-14

GCR의 불변 지식 bundle·서명된 manifest·다운로드·메모리 배포 승인 API와 발행 상태 화면을 `PRISM-DEV/git-code-reviewer`에 배포했다. [검증 증거](../../.documents/execution/preventive-review/evidence/P05-knowledge-PRISM-deployment.json)를 기준으로 한다.

| 항목 | 적용 값 |
| --- | --- |
| Helm release | `git-code-reviewer`, revision 53, deployed |
| Chart / app | `0.10.39` / `0.8.0-alpha.41` |
| 실행 source | `8ce10a9123c49a9bbc37ca8ecc7a4de402130fe6` |
| Release pin | `c2f14bb` |
| Image digest | `sha256:aba6f16edf97d06f30bc5b2cbbde32974f83deecd31fcc18d60462760e6cf262` |
| Migration | 38→40, 기존 38개 checksum 보존 |
| Helm test | 2026-09-14 03:05:36 KST 통과 |
| DB 연결 | `verify-full`, 실제 session TLS 1.3 |

[지식 배포 overlay](../../deploy/environments/prism-dev/knowledge-publication-values.yaml)로 publication과 distribution을 켰다. Server ID는 `06cba99b-d58c-438c-a9c1-9a7c6c340477`, key ID는 `prism-dev-20260914-01`이다. Private key는 `git-code-reviewer-knowledge-signing-v1` Secret에만 보관하고 [공개키](../../deploy/environments/prism-dev/certs/knowledge-signing-public.pem)를 별도로 고정했다. Worker와 init container에는 서명 키를 mount하지 않는다. Offline lease는 24시간이며 실제 client cache의 만료 적용은 P06의 범위다.

Helm server dry-run으로 기존 리소스 종류·이름을 비교하고 image·release label과 지식 발행/서명 설정 이외의 변경이 없음을 확인했다. 실제 게시 OCI chart를 다시 내려받아 byte 일치를 확인했다. 게시 이미지의 source label·digest·amd64 manifest·SBOM·provenance도 검증했다. 같은 이미지의 격리 PostgreSQL에서 기존 사용자 보존, 실제 서버 부팅·local session·서명 키 로딩·세 component 발행·다운로드·304와 기존 기준/후보 생성 경로를 확인했다.

운영에서는 기존 local 계정을 변경하지 않고 임시 reviewer와 polling/review publishing을 끈 합성 저장소를 만들었다. 실제 worker가 세 component를 발행했고 별도로 고정한 공개키로 manifest 서명을 검증했다. 최초 personal은 소유자가 있는 빈 bundle이었다. HTTP API로 합성 개인 메모리의 배포 내용을 승인한 뒤 personal sequence만 1→2로 바뀌었고 policy/collective는 1을 유지했다. 다운로드 bytes의 hash·크기, raw 원문 제외와 이전 snapshot의 409를 확인했다. 임시 repository·user·session을 정리했으며 외부 모델은 호출하지 않았다.

배포 후 기존 user 7·모델 account 7·grant 2·membership 7·memory 4·local credential 6개와 기존 행의 식별 hash가 보존됐다. 서비스의 기존 분석 작업은 계속 진행돼 analysis/report 수는 160/152에서 161/153으로 증가했다. 기존 Secret·HTTPRoute·PVC를 보존했고 DB TLS와 local 인증·provider 설정은 유지됐다. Server·worker·Keycloak Ready, 운영 code와 정적 asset의 이미지 일치 및 CA를 검증한 HTTPS health/system 응답을 확인했다. 이전 worker는 설정된 종료 유예를 따르며 강제 종료하지 않았다.

[리뷰 기준 화면](https://pr-review.prism.ai/review-criteria)에서 세 component의 발행 상태와 승인 가능한 메모리를 확인할 수 있다. 클라이언트 동기화는 아직 관측되지 않아 unknown으로 표시한다. 명시적 높은 sequence rollback, remote resolve·출처 상세 API, P04 client 인증, P06의 Commit Defender/CLI 원자적 cache·sync·상태 보고는 남아 있다. 운영 SAML 로그인 전환 완료나 전체 P00–P13 완료로 계산하지 않는다.
