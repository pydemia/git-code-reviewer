# SAML 앱 인증 코드 배포 기록

2026-09-13 09:30:10 KST에 PRISM-DEV에 application `0.8.0-alpha.35`, chart `0.10.33`, Helm revision **45**를 배포했다. Source `d1f62bf`와 release pin `30d63f1`을 push한 뒤 적용했다. 운영 `AUTH_MODE=local`은 유지한다.

이 release에는 SAML login/ACS/metadata/SLO, DB에 결합된 web session·Logout SessionIndex 폐기, LoginPage의 인증 방식 표시가 들어 있다. Migration 0033은 로그아웃 전에 시작된 로그인 응답이 폐기한 SessionIndex의 세션을 재생성하지 못하도록 revocation 기록을 추가한다. [설정 계약](saml-web-authentication.md)과 [P03 실행 기록](../../.documents/execution/preventive-review/P03.md)을 함께 따른다.

| Artifact                 | 확인한 값                                                                 |
| ------------------------ | ------------------------------------------------------------------------- |
| Source                   | `d1f62bfdb6a1212f093fff6c3c00f0a933a739cc` clean Git archive              |
| Image index              | `sha256:f434a80b6f6aaf2b653057a26b9f19d03964a9f49e9c79a259c1cb8921950403` |
| Linux/amd64 manifest     | `sha256:b6937ca1d3069ab567efac4a35d02c95569842ece27a21a3232ffc4d866bd687` |
| SBOM/provenance manifest | `sha256:328aa2e5cc154038076d20ba9dbdae2281e0ac0d0ff02a20d62e225e6505182e` |
| OCI chart digest         | `sha256:a496dcd4a6059ef905a191b6ef431acef29edf8e9a9986656d6715e85d2be794` |
| Chart archive SHA-256    | `5095ecbb4e32255a70773f9cd8ba5a8f393c4973c4479be565294272ac025da4`        |
| Migration 0033 SHA-256   | `c7d2ebe6b3bdc0684ec0f51229a5077b40fdc18eaaaeac58880777124807e33d`        |

Node 22.23.2에서 103개 test file의 861개 test가 실패·skip 없이 통과했다. 전체 build·typecheck·lint와 변경 source의 format도 통과했다. 전체 format에는 기존의 무관한 Markdown 5개 경고가 남는다. Dependency audit은 취약점 0건이었다.

격리된 실제 Keycloak 26.7.3·PostgreSQL 17.11·Chrome 152 headless에서 compiled LoginPage부터 HTTPS cross-site ACS·사용자 조회·compiled logout button·IdP SLO·DB 소비·API 401·다음 로그인 재인증까지 검증했다. 두 앱 instance가 같은 DB의 session을 사용한다. 별도의 실제 서명/DB 시험에서는 nonce·CSRF·여러 탭·replay·SessionIndex별 폐기·지연 응답·DB 장애 rollback·log 비노출을 확인했다.

게시한 image를 UID 1000·read-only·network-none으로 실행해 compiled SAML 로그인·로그아웃 서명, 변조 거부, 실제 dependency version을 확인했다. Compiled module 7개의 hash는 로컬 build 및 배포된 Server/Worker와 같다. Web asset은 실제 Keycloak browser 시험·image·gateway에서 같은 hash다. 구버전 package·web bundle과 `.env`·build secret 부재, 정적 파일 cache/hash와 경로 우회 거부도 확인했다.

- `index-jmmTaJuT.js`: `007d8a62da6d5bf0d841b4c7d0680e4a81fba94e6b77daa911f493a41e7366ae`
- `index-T_jmTDvd.css`: `e3dfa4e3389c0f71155cf8ba8cdf23de78c65ae0cc63f6c3006119a04d18e44e`

배포 전후 사용자 7명·account 7개·분석 142건·report 134건, repository grant 2개·tenant membership 7개·memory 4개의 ID/owner와 기존 local session 1개의 hash·user·생성/만료 시각을 보존했다. 기존 migration 32개 checksum은 같고 새 0033 checksum도 source와 일치한다. 새 revocation 테이블과 기존 SAML identity 관련 테이블은 모두 0행, 운영 session의 SAML binding은 null이다. 기존 credential 전체 row 보존은 격리된 migration fixture에서 검증했다.

Provider v8 Terra·concurrency 4·timeout 300000과 configuration hash를 유지했다. Image 외 Helm user values hash는 `9abc48b9861c0223aec5693151e5fa8b868ea84ab958909a3f5b127384f1ee14`로 배포 전·dry-run·배포 후 같으며 computed values hash도 같다. Secret·corporate CA·HTTPRoute의 UID/resourceVersion, DB·artifact PVC의 UID/PV/capacity를 보존했다. App ConfigMap은 release metadata에 따른 resourceVersion 변경만 있으며 UID와 data 값은 모두 같다.

Server `git-code-reviewer-server-6ff466b89f-nmgr4` 1/1, Worker `git-code-reviewer-worker-8f4c48b88-rzkjr` 2/2 Ready·restart 0이었다. 초기 warning/error/fatal 0건, health 4종 정상, `/api/v1/system` alpha.35·local, 비로그인 `/api/v1/me` 401, Helm test 09:31:24 KST 성공을 확인했다. 배포된 LoginPage의 local form과 오류 안내를 새 Chrome context에서 검증했으며 실제 사용자 credential이나 session은 사용하지 않았다.

이전 worker의 source-sandbox 종료 유예를 존중하며 강제 삭제하지 않았다. 시험용 DB·Keycloak·network·browser context와 임시 signing key·build/registry credential 파일은 정리했다. 운영 credential과 원래 Docker/Helm 설정은 바꾸지 않았다.

Native Safari callback은 Mac 잠금으로 대기 중이다. 실제 계정 provisioning·IdP security-state 수집·공유 PostgreSQL ACL·companion identity chart·복구 rehearsal·운영 인증 전환은 P03-C04–C08의 남은 작업이다. 이번 배포는 P03 전체의 완료나 운영 SAML 활성화를 의미하지 않는다. [최종 배포 증거](../../.documents/execution/preventive-review/evidence/P03-C03-deployment.json)에 검사 결과를 보관했다.
