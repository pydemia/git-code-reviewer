# C05 배포 기록 — 2026-09-13

PRISM-DEV의 `git-code-reviewer` release를 13:47:54 KST에 Helm revision 47로 업그레이드했다. App은 `0.8.0-alpha.37`, chart는 `0.10.35`다. Source commit은 `bdf1aefd3b99b49981f52d0b5c9859cf903c3115`, release pin은 `af31451a6f208028530f61c6bcb20afee5e1f2bf`다.

| 산출물            | Digest                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| Image index       | `sha256:2f17d3f8a2c35e6cc217d8f477dad9cced4770787460c0b66c568cb63d8bf915` |
| linux/amd64 image | `sha256:d6a11e5b2562431a1c49badda0155f89d11b8d415f6883aa2f2815cf9dd186af` |
| OCI chart         | `sha256:bf57d89ee35ad463bb485438cd944283885547dce32bf5bcdd0aded302bec89b` |
| Chart archive     | `772e51761c1304fcebe8b9a386ab862ac962cbdd943fd216e35eb942cb12294a`        |

Image는 source commit의 깨끗한 Git archive로 만들었다. 게시 후 digest로 다시 받아 source/version label, compiled module, migration과 정적 파일을 대조했다. SPDX SBOM과 SLSA provenance도 registry에서 읽어 blob digest를 검증했다. Python의 사내 CA 호환 오류가 있어 이 추가 검사는 Node 22의 기본 TLS 검증과 기존 사내 CA를 사용했다. 인증서 검증은 끄지 않았고 시스템 trust 설정도 바꾸지 않았다.

Helm lint와 server dry-run이 통과했다. Image와 release metadata 외의 manifest 변경이 없고 app ConfigMap data가 같음을 확인한 후 차트를 게시했다. OCI에서 다시 받은 chart archive의 bytes가 로컬 package와 일치했다. 배포는 `--reuse-values`, image tag/digest 변경, `--rollback-on-failure --wait --timeout 20m`으로 실행했다.

새 Server `git-code-reviewer-server-5bf9f6b9d9-pjnj4`는 1/1, Worker `git-code-reviewer-worker-6bc77c644-xr9lh`는 2/2 Ready였다. 재시작과 초기 warning/error/fatal/unstructured log는 0건이었다. Gateway health 4종, compiled C05/SAML module과 asset hash, static cache 설정을 확인했다. 13:50:04–13:50:07 KST의 Helm test도 성공했다. 실제 LoginPage와 익명 관리자 API의 404를 새 Chrome headless context에서 확인했으며 사용자 credential이나 API 응답 mock은 사용하지 않았다.

두 새 pod의 실제 config는 local 인증이며 identity administration/security는 모두 false다. Migration은 34개에서 36개가 됐다. 기존 34개 checksum은 같고 새 0035·0036은 source와 image의 checksum에 일치한다. Identity 관련 테이블은 모두 0행이며 운영 IdP 계정이나 세션을 변경하지 않았다.

배포 전후 비교에서 사용자 7명의 identity/access 필드, account ID 7개, 분석 ID 144개, report ID 136개, repository grant 2개, membership 7개, memory owner 4개를 보존했다. Local credential 6개의 사용자 ID·이름·password hash·시각 필드와 웹 세션 1개도 같았다. Provider, image 외 user/computed values, Secret·CA·HTTPRoute·PVC와 연결된 PV 2개의 UID/spec을 보존했다. App ConfigMap의 resourceVersion만 release metadata에 따라 바뀌었고 data는 같다.

이전 Worker의 source sandbox는 3600초 종료 유예를 유지한다. 강제 삭제하거나 종료 유예 설정을 바꾸지 않았다. Shared DB와 companion 설정, 운영 SAML 전환/복구, native Safari·VS Code 검증, P04 client credential 발급·검증은 후속 작업이다.

근거: [source 검사](../../.documents/execution/preventive-review/evidence/P03-C05-lifecycle-source.json), [게시 산출물](../../.documents/execution/preventive-review/evidence/P03-C05-artifact.json), [최종 배포 증거](../../.documents/execution/preventive-review/evidence/P03-C05-deployment.json).
