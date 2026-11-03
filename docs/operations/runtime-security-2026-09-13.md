# Runtime 의존성 보안 수정과 이미지 정리

2026-09-13 08:03:12 KST에 PRISM-DEV를 application `0.8.0-alpha.33`, chart `0.10.31`, Helm revision **43**으로 갱신했다. Source `aa33032`와 release pin `c22c422`를 push한 뒤 적용했다.

`@fastify/static`은 `10.1.3`, Vitest/mocker는 `4.1.11`이다. Node 22.23.2에서 실제 임시 PostgreSQL을 포함한 전체 테스트 734개와 build·runtime typecheck, 새 파일 lint를 통과했고 `pnpm audit` advisory는 0개였다. 이는 npm 의존성 검사 결과이며 OS package 전체 취약점 검사 결과를 뜻하지 않는다.

이전 runtime image를 base로 재사용하면서 `/app`의 삭제된 package와 web bundle까지 남는 문제도 수정했다. Runtime build에서 `/app`을 비우고 현재 build output만 복사한다. 처음 게시한 alpha.32는 이 artifact 검사에서 실패해 배포하지 않았다. Tag를 덮어쓰지 않고 수정 image에 alpha.33을 사용했다.

## 배포 artifact

- Source `aa330327ec2483e9c355628aec1f645bb0f16e4c`의 clean Git archive, Linux/amd64, SBOM·provenance 포함.
- Image index: `sha256:c1885ba5ac3ec11558865ea143f867ca3af4dc0c41a5ada262ccc292072d3f77`
- Linux/amd64 manifest: `sha256:4ef59d1f285818490205ae35507176564bb9dbdc27bd84733058675a6f0bc45b`
- Attestation manifest: `sha256:28fe83b7a53561337092a70afe193d2f7cdfc424e1e408c0c5dfda67c32b0231`
- OCI chart `registry-1.docker.io/pydemia/git-code-reviewer:0.10.31`: `sha256:5b7eeb13ad9c70e6db67997ecc9776ba5b983d46d817d965c17566101a48f0a0`
- Chart archive SHA-256: `980f292ea0cc2b49acb898ba4ad1889ba960b4587ae53c8ed4c8f9579f31ce6c`. 게시한 chart를 다시 내려받아 바이트 일치를 확인했다.

실제 image를 UID 1000·read-only·network-none으로 실행해 구버전 static/Vitest/mocker와 이전 JS/CSS bundle의 부재를 확인했다. 현재 정적 파일의 내용·cache와 traversal 거부, build CA secret·`.env`·설계 문서 부재도 검사했다.

## 적용 확인과 데이터 보존

새 Server `git-code-reviewer-server-9485f7f6-tjfjn` 1/1, Worker `git-code-reviewer-worker-fc4c5c796-j2th2` 2/2 Ready이며 restart는 0이다. 실제 process의 Node·static version과 package folder도 image 검사 결과와 일치한다. 조회한 초기 log에서 warning/error/fatal은 0건이다.

Health startup/live/ready/dependencies 모두 ok, system version alpha.33, 비로그인 `/api/v1/me`는 401이다. Helm 연결 test는 08:06:19 KST에 성공했다. 실제 gateway에서 받은 파일의 SHA-256은 다음과 같다.

- `/assets/index-DrHUqW4X.js`: `d7b05ac7591912fa18d1819a393b7c3e2e815b92a3977e6c5ff3b600efd91cd8`
- `/assets/index-T_jmTDvd.css`: `e3dfa4e3389c0f71155cf8ba8cdf23de78c65ae0cc63f6c3006119a04d18e44e`

사용자 7명·account 7개·분석 142건·report 134건의 ID, 사용자 subject·role·group·상태, repository grant 2개, tenant membership 7개, 개인 memory를 포함한 memory 4개의 ID·owner가 배포 전후 동일하다. 기존 migration 31개 checksum도 일치한다. 새 SAML migration 초안은 이 image에 포함되지 않았다.

활성 Provider v8의 model `gpt-5.6-terra`, concurrency 4, timeout 300000과 configuration hash를 유지했다. Image 외 user-supplied Helm values hash는 배포 전·dry-run·배포 후 `9abc48b9861c0223aec5693151e5fa8b868ea84ab958909a3f5b127384f1ee14`로 같고, computed values hash도 전후 동일하다. 두 hash는 Python의 key 정렬·compact JSON 직렬화 기준이며 이전 기록의 직렬화 방식과 직접 비교하지 않는다.

Auth·credential registry·PostgreSQL Secret, corporate CA와 HTTPRoute는 UID/resourceVersion을 유지했다. DB RWO 10Gi·artifacts RWX 10Gi PVC의 UID·PV·capacity도 그대로다. 앱 ConfigMap의 version label과 artifacts PVC의 release metadata는 새 버전을 따른다. 이전 Worker는 종료 유예를 존중하며 강제 삭제하지 않았다.

Docker Desktop credential helper 응답 지연 때문에 같은 registry의 기존 Keychain credential을 이번 배포에만 사용할 임시 0700 디렉터리·0600 파일에 담았다. 원래 Docker/Helm 설정을 바꾸지 않았고 배포 후 임시 파일을 제거했다. Credential 원문은 기록하지 않았다.

인증은 기존 local mode다. SAML 활성화는 P03-C03–C08 검증 후 진행한다. 이번 배포 검증을 위한 모델 요청·재분석·PR 게시·사용자 credential 변경은 없다. 상세 증거는 [배포 검증 JSON](../../.documents/execution/preventive-review/evidence/P03-S01-deployment.json)에 있다.
