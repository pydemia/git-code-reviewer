# 중앙 → 로컬 단방향 전파 수정 — 2026-09-15

사용자 확정: 중앙 리뷰와 프롬프트를 로컬이 가져온다. 로컬 리뷰와 대화는 로컬에 설정한 모델로 실행한다. 로컬 코드·결과·피드백·대화·개인 Memory의 중앙 전송과 중앙 모델 대행 실행을 제외한다.

P10 중앙 모델 실행과 P08-C03/C05의 상향 제출은 사용자 지시로 철회했다. 완료 항목으로 집계하지 않는다. 중앙 서버 자체 PR 리뷰와 지식·프롬프트 발행은 유지한다.

## 적용

GCR 소스 6a5eb89: 중앙 실행 경로를 제거하고 클라이언트 키를 knowledge:read로 제한했다. 기존 쓰기 권한 키도 클라이언트 인증 경로의 GET/HEAD 외 요청을 거부한다. SDK 제출 호환 메서드는 인증 정보나 네트워크에 접근하기 전에 405로 종료한다. CLI/MCP의 제출·피드백·중앙 실행 명령을 제거했다.

Commit Defender 2.9.1: 중앙 모델 선택과 요청 관리, 피드백 제출 UI를 제거했다. 로컬 리뷰·대화·중앙 지식 다운로드를 유지한다. client 패키지는 0.1.0-alpha.35, 번들 CLI는 0.1.0-alpha.31이다.

## 검증과 설치

- GCR 관련 5개 테스트 묶음: 수정 후 고유 79개 통과, 기존 1개 건너뜀. 레거시 키 쓰기 차단 테스트의 초기 fixture 오류를 수정하고 인증 12개를 재검증했다. PostgreSQL 18.3 임시 DB 정리 완료.
- GCR runtime/web 빌드, lint, 테스트 타입 검사 통과. web 빌드의 기존 청크 크기 경고는 남아 있다.
- client 패키지 Node 18.20.8/25.9 검증, CLI 깨끗한 설치 검증 통과.
- Commit Defender 중앙 지식 리뷰 12개, 로컬 대화 4개, 최종 패키지 계약 21개 통과. 타입 검사와 VSIX 빌드 통과.
- 최종 VSIX를 VS Code 1.90.2와 1.135.0에서 활성화했다. 명령 25개 등록, 제거 대상 명령 3개 부재 확인.
- 기존 2.9.0 설치본 백업 후 2.9.1 설치. 파일 37개와 package.json(VS Code가 추가한 metadata 제외)을 VSIX와 대조했다.
- 유료 모델 호출 없이 합성 fixture로 검증했다. 사용자 VS Code 강제 재시작과 전역 CLI 교체는 하지 않았다. 이미 실행 중인 확장 호스트는 다음 재로드/재시작 때 새 코드가 적용될 수 있다.

VSIX SHA-256: `e75e7bf4f301f320be2df1dedee69811e8c481b10e304c2f60f2c5bab0d56dcf`

검증 원본은 GCR의 `artifacts/operations/one-way-propagation/`에 보관한다. 중앙 서버 배포는 이 기록 작성 시점에 아직 이전 버전이다. 서버 배포 여부는 후속 운영 기록으로 확인한다.

## PRISM-DEV 적용 완료

2026-09-15 01:20:31 KST에 Helm revision 59, chart 0.10.45, app 0.8.0-alpha.49를 배포했다. 소스는 `9e24a003922c1dc1598d93e2c3431acc1f3f4e2a`, 배포 설정은 `65e54e7`이다. 이미지 digest는 `sha256:af8557f2c8eb7c77ec353da1c31095c1476b58c7347dd01a998c2a34490f0d4e`다.

재사용한 runtime base로 만든 alpha.48에서는 이전 JS 파일이 남아 배포를 중단했다. 버전을 덮어쓰지 않고 pinned Node 기본 이미지에서 alpha.49를 새로 빌드했다. 최종 이미지에서는 JS/CSS 각 1개, UID 1000, 빌드 Secret·이전 중앙 실행 모듈 부재를 검사했다. 검사 Pod는 ingress/egress deny-all NetworkPolicy, 읽기 전용 root filesystem, 서비스 계정 token 미장착으로 실행했다. Registry manifest/config의 digest와 소스 label을 검증했다. 이 빌드는 registry에 별도 SBOM/provenance attestation을 게시하지 않았다.

Helm 서버 dry-run에서 이미지·버전 label 외 리소스와 설정이 동일함을 확인했다. OCI chart 게시 후 내려받은 bytes도 일치했다. 배포 후 서버·worker의 compiled 파일과 웹 asset이 검증 이미지와 일치하며, migration 45개 checksum·기존 사용자/계정/권한/리뷰 식별자·Secret·HTTPRoute·PVC·provider 설정과 DB TLS verify-full을 보존했다. Keycloak 2개 replica도 Ready다. Helm connection test는 01:21:50 KST에 통과했다.

실제 HTTPS API가 knowledge:read만 안내하고 결과·피드백 POST에 CLIENT_READ_ONLY를 반환한다. 이 HTTP probe는 의도적으로 잘못된 합성 bearer를 사용해 인증·본문 처리 전 method 차단을 확인했다. 유효한 기존 쓰기 권한 키 차단은 별도 격리 PostgreSQL 통합 테스트에서 검증했다. 운영 계정의 모델 호출은 검증에 사용하지 않았다.

임시 BuildKit deployment·서비스 계정·CA ConfigMap과 검사 Pod·ConfigMap·NetworkPolicy를 정리했다. 로컬 Docker 자체의 저장소 오류는 이 배포로 수리된 것이 아니다. 사용자의 로컬 계정 설정과 전역 CLI는 변경하지 않았다. 전체 개발 목표는 계속 진행 중이며 철회한 항목을 완료로 집계하지 않는다.

[배포 검증 증거](../../.documents/execution/preventive-review/evidence/one-way-propagation-deployment.json)
