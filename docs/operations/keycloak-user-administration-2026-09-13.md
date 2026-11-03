# Keycloak 사용자 관리 코드 배포 — 2026-09-13

2026-09-13 11:06:32 KST에 PRISM-DEV `git-code-reviewer` namespace/release를 Helm revision 46으로 갱신했다. P03-C04의 계정 생성·연결·초대/재설정 API·화면·Worker와 migration 0034를 포함한다. 운영 인증은 local이고 조직 계정 관리는 Server·Worker 모두 비활성이다.

| 항목                  | 값                                                                        |
| --------------------- | ------------------------------------------------------------------------- |
| Source                | `82aa12e19b331ed4120fbe293bbd6a96a4c3855e`                                |
| Release pin           | `d84fb3494efab6b400301f234f262a16842daebd`                                |
| Application / chart   | `0.8.0-alpha.36` / `0.10.34`                                              |
| Image index           | `sha256:dcc6f96997acbb9fb34dc80f90a5e2c3829b1825d46918a2e01bb440f4d5601a` |
| amd64 manifest        | `sha256:bbf92c4b58b0aeb41ad2d277a533127770cb56697e9357907af94f7f67ef897d` |
| Chart OCI digest      | `sha256:cb6a6328584f33988181a96a00cd8a4919c4d655cff45e94630004112e6b151c` |
| Chart archive SHA-256 | `2b14cbf5385e388e65a1939f6ca1d60fcd68e75e96191b5ee9399402fa2e177c`        |

전체 914개 테스트, build·typecheck·source lint·변경 파일 format과 advisory 0개 audit을 통과했다. 실제 Keycloak 26.7.3·PostgreSQL 17.11·Chrome 152에서 compiled 관리자 화면의 생성·초대·재설정, 앱 세션 선폐기·명시적 연결·권한 제한·응답 유실·격리 SMTP 수락을 검증했다. 시험 계정과 환경만 사용했으며 native GUI나 실제 외부 메일 수신 증거로 확대하지 않는다.

Clean Git archive에서 이미지와 provenance/SBOM을 게시했다. 실제 이미지의 signed SAML 검증, 새 identity 기본값·NameID·reset confirmation, compiled module hash와 dependency 구성을 확인했다. UID 1000·read-only filesystem·network none에서 검사했으며 build secret은 남지 않았다. Helm server dry run은 image tag/digest만 달라짐을 확인했고 게시 chart를 다시 받아 bytes를 대조했다.

배포 후 Server 1/1·Worker 2/2 Ready·restart 0, 초기 warning/error/fatal/unstructured 0, health 4종·system version·gateway asset hash·Helm test를 통과했다. 실제 Server/Worker module hash가 검사한 이미지와 같으며 새 Chrome context에서 local LoginPage와 익명 관리 API 404를 확인했다. 실제 사용자 credential은 사용하지 않았다.

사용자 7명·account 7개·분석 142건·report 134건, 사용자 ID·subject·역할·groups·repository grant·tenant membership·개인 memory owner·local session 1개를 보존했다. Migration 33개 checksum을 유지하고 0034를 추가했다. Identity 테이블 6개는 0행이며 SAML-bound session도 없다. 활성 Provider v8 Terra·concurrency 4·timeout 300000과 설정 hash도 같다.

Image 외 user/computed values, Secret·CA·HTTPRoute UID/resourceVersion과 PVC/PV·capacity를 유지했다. App ConfigMap의 UID와 data hash는 이전 검증값과 같으며 release metadata로 resourceVersion만 바뀌었다. 이전 Worker의 source sandbox는 3600초 graceful termination을 따르며 강제로 지우지 않았다.

설정과 장애 처리 계약은 [사용자 관리 운영 문서](keycloak-user-administration.md), 원본 증거는 [최종 배포 기록](../../.documents/execution/preventive-review/evidence/P03-C04-deployment.json)에 있다. 운영 계정 provisioning·메일 발송·SAML 활성화는 실행하지 않았다. Freshness/event 수집·확인된 재활성화·공유 DB·companion chart·운영 전환은 P03-C05–C08에서 진행한다.
