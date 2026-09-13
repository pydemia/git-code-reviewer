# PRISM-DEV 중앙 클라이언트 연결 배포 — 2026-09-14

[내 프로필](https://pr-review.prism.ai/profile)에 API key 발급·목록·폐기와 저장소별 연결 설정 다운로드를 배포했다. 중앙 지식 배포 계약은 v2다. 설치된 GCR CLI로 실제 HTTPS 서버에 연결해 동기화와 권한 철회를 확인했다.

| 항목                  | 배포 값                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| Context / namespace   | `PRISM-DEV` / `git-code-reviewer`                                                 |
| Helm revision / chart | `54` / `0.10.40`                                                                  |
| Runtime image         | `0.8.0-alpha.42`                                                                  |
| Image digest          | `sha256:34c132345ab0707c98ef3c799c7672e6d6114a0882ca086338a43d642b77cc07`         |
| OCI chart digest      | `sha256:4655460ddd894daf3d2b35bea88b62e6fc618834014811bd76f33616435dd076`         |
| 빌드 source           | `87652e68da1d14c11f20f672d630863887dc5718`                                        |
| Migration             | 기존 40개 보존, `0041_client_api_keys`, `0042_knowledge_precedence_contract` 추가 |
| DB TLS                | Server·worker `verify-full`, 실제 TLS 1.3                                         |

기존 값을 재사용하면서 [클라이언트 연결 overlay](../../deploy/environments/prism-dev/client-connections-values.yaml)를 적용했다. 공개 주소를 HTTPS로 맞추고 API key 기능을 켰다. 클라이언트의 HTTPS 검증에는 명시한 `git-code-reviewer-identity-ca` 공개 인증서를 전달한다. DB CA와 서명 private key mount는 유지했다. Server·worker와 Keycloak 2개 replica가 Ready다.

이미지는 커밋의 깨끗한 Git archive로 빌드했다. 레지스트리에서 digest·revision label·SBOM·provenance를 확인하고, 게시한 Helm chart를 다시 내려받아 원본과 바이트 단위로 비교했다. 동일 이미지와 격리 PostgreSQL로 기존 사용자 보존, 40→42 마이그레이션, API key·연결 설정·서명 manifest·bundle 검증을 수행했다. 배포 후 서버·워커 코드와 HTTPS 정적 자산의 hash가 검증 이미지와 일치했다.

기존 user 7, model account 7, grant 2, membership 7, memory 4, local credential 6개의 행 fingerprint를 배포 전후 및 실제 연결 시험 정리 후 비교해 보존을 확인했다. 기존 Secret·HTTPRoute·PVC도 유지했다. 배포 직전 DB를 암호화 백업하고 복호화 readback을 확인했다. 이 배포에서 백업 복원은 실행하지 않았다.

## 실제 클라이언트 검증

로컬 설치본 CLI `0.1.0-alpha.8`의 실행 파일 SHA-256은 `b09a22ed237a026e1a39f04bc5adfe51c1fdc4f64ddc81165ff5af0893213296`이다. 별도 사용자·저장소·로컬 Git·profile을 만들어 다음 흐름을 확인했다.

- 개발 CA를 명시적으로 검증하는 HTTPS 로그인과 API key 발급.
- 내려받은 연결 설정의 CA·서명 공개키가 별도로 보관한 pin과 일치.
- macOS Keychain에 key를 저장하는 설치 CLI 연결 및 실제 worker가 발행한 v2 세 component 동기화.
- 정확한 사용자·저장소 audience의 중앙 context와 명시적 offline context 구성.
- 웹에서 key 폐기 후 CLI 동기화 거부, 연결 해제 후 offline cache 사용 거부.
- 시험용 서버 행, 로컬 파일, OS 자격 증명 항목 제거.

신규 저장소의 첫 연결은 worker의 초기 지식 발행 전 `unavailable`, exit 2로 종료됐다. 실제 HTTPS manifest가 503에서 200으로 바뀌는 것을 1초 간격으로 확인한 후 명시적으로 다시 연결해 위 흐름을 통과했다. 첫 연결의 발행 대기·재시도는 아직 구현하지 않았으며 이 배포를 자동 연결 완료로 판정하지 않는다.

이번 실서버 검증은 모델 호출 없이 context·동기화·권한 철회를 확인했다. 실제 계정으로 모델 리뷰를 완료한 기존 CLI·CD 증거는 합성 HTTPS 서버를 사용한다. PRISM-DEV에 연결한 CD VSIX의 실제 리뷰, 초기 발행 대기, 주기 동기화·backoff, remote 자동 매핑, 후속 P07~P13은 남아 있다.

v2는 memory의 grouping identity도 승인 fingerprint에 포함한다. 기존 v1 승인과 fingerprint가 다르면 다시 승인해야 배포된다. 배포 후 이 환경의 memory projection은 0개여서 이번 전환으로 재승인할 기존 projection은 없다.

[실행 증거](../../.documents/execution/preventive-review/evidence/P06-PRISM-client-deployment.json)에 이미지·chart·테스트·실서버 실행 및 남은 범위를 기록했다. [사용 방법](client-connections.md)을 함께 참고한다.
