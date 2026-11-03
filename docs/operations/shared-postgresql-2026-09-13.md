# C06 runtime 배포 기록 — 2026-09-13

PRISM-DEV의 `git-code-reviewer` release를 20:18:43 KST에 Helm revision 48로 업그레이드했다. App은 `0.8.0-alpha.38`, chart는 `0.10.36`다. Source는 `797aab719717d911db42fb337ce6a38a7fc8d7de`, release pin은 `234be254a348dcc42bfff3b8d2ddbebbdb5854de`이다. C06의 DB role·TLS·migration credential 분리 코드를 배포했으며 운영 설정은 기존 local 인증·legacy DB 연결을 유지한다.

| 산출물            | Digest                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| Image index       | `sha256:890cbc324d5f2cc828ceea5c0abc8b70d79c36f3f38357777643696171072198` |
| linux/amd64 image | `sha256:5e6359d7cbeea71353155944f04b51e1f2b3562b9ee9359cf1d735bde70504ff` |
| OCI chart         | `sha256:0f265886fe992c7a311af5bd2767ca70f50a9b923fc1921ae9ea4c2068d293c4` |
| Chart archive     | `f5a24350936b7ba78896520f714ce177775206e8f37121ff49387bc388b1e9dc`        |

깨끗한 Git archive에서 linux/amd64 image를 빌드했다. 게시한 image의 compiled SAML·C06 검사 20개, 정적 파일·runtime package 검사 5개와 source/module hash 대조가 통과했다. SPDX SBOM·SLSA provenance는 registry에서 읽어 blob digest를 검증했다. Default/SAML example Helm lint와 서버 dry-run도 통과했으며 OCI에서 다시 받은 chart archive가 로컬 package와 byte 단위로 같았다.

이번 chart에 새 `identity`와 `auth.saml` 기본값이 추가돼 기존 `--reuse-values`는 schema 검증에서 거부됐다. `--reset-then-reuse-values`를 사용한 서버 dry-run은 리소스 13개에서 image·release label·ConfigMap checksum 외 변경이 없고 앱 ConfigMap data가 같음을 확인했다. 같은 옵션에 image tag/digest, `--rollback-on-failure --wait --timeout 20m`을 지정해 배포했다. 기존 image 외 user values와 computed 값의 모든 기존 leaf는 배포 후에도 같았다. 새 computed 기본값 41개는 비활성 identity/SAML/DB role·TLS 설정, migration 대기 시간과 worker pool에 한정된다.

새 Server `git-code-reviewer-server-857657ff55-4wl5z`는 1/1, Worker `git-code-reviewer-worker-7f8f9fcdbf-t8ptq`는 2/2 Ready이며 restart 0회였다. 20:24 KST 검사에서 health 4종은 200·ok, system version은 alpha.38, 익명 `/api/v1/me`는 401이었다. 양쪽 Pod의 C06/SAML/identity compiled module·DB provisioning module과 Gateway의 JS/CSS hash가 게시 image에 일치했다. 초기 10분 범위의 warning/error/fatal/unstructured log는 0건이었다.

Migration hook은 20:18:44–20:19:09 KST에 성공했고 새 Helm test는 20:24:50–20:24:54 KST에 성공했다. 새 Chrome 152 headless context에서 실제 local 로그인 입력란과 익명 identity 관리자 API의 404, page error 0건을 확인했다. 사용자 credential과 API mock을 사용하지 않았다. 이 검사는 native Safari·VS Code 또는 운영 SAML 로그인의 증거가 아니다.

20:15:55와 20:24:43 KST의 read-only snapshot을 비교했다. 사용자 7명의 identity/access 필드, account ID 7개, 분석 ID 153개, report ID 145개, repository grant 2개, membership 7개, memory owner 4개가 같았다. Local credential 6개의 사용자 ID·이름·password hash·시각 필드와 웹 세션 1개도 보존됐다. Migration 36개의 version/checksum은 배포 전후와 image에서 일치했다. Secret·CA·HTTPRoute·PVC, 연결된 PV 2개의 UID/spec을 보존했고 app ConfigMap의 resourceVersion만 바뀌었다.

Server와 Worker에서 실제 `loadConfig`를 실행해 local 인증, identity administration/security false, isolated DB roles false, DB TLS mode `legacy`, pool 10을 확인했다. 활성 Provider는 v8·`gpt-5.6-terra`·병렬 4개·timeout 300000ms로 같다. DB role/TLS 운영 전환과 Keycloak 배포·SAML 활성화는 아직 수행하지 않았다. 이전 Worker의 source sandbox에는 3600초 종료 유예를 유지한다.

[게시 산출물](../../.documents/execution/preventive-review/evidence/P03-C06-artifact.json)은 배포 전 시점의 기록이며 [최종 배포 증거](../../.documents/execution/preventive-review/evidence/P03-C06-deployment.json)가 배포와 후속 검증 결과를 담는다. C06 운영 전환, C07 companion·앱 SAML 통합과 C08 백업/복구, Commit Defender native GUI·배포와 P04–P13은 남아 있다.
