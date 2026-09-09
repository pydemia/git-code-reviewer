# Review Chat 진행 상태 표시

## 변경

현재 질문의 ‘조회 과정’은 기본으로 펼친다. Native details로 사용자의 접기 조작을 유지하며 같은 run의 event 갱신으로 다시 펼치지 않는다. 새 run ID에서는 펼침을 초기화한다. 저장된 이전 질문의 조회 과정은 기존처럼 접어서 표시한다.

`running` 상태에는 Thinking 글자 안에서 빛이 흐르는 CSS 효과를 적용한다. Queue·계정 호출 한도 대기·사용자 응답 대기·중단 중·완료·실패에는 각각 기존 상태 문구를 표시한다. 요청 접수 전에는 전송 중임을 즉시 알린다. 조회 과정을 접어도 Thinking과 중단 버튼은 남는다. 이 표시는 서버가 알려주는 실행 상태이며 모델의 내부 추론 내용을 나타내지는 않는다.

별도 animation dependency나 timer를 추가하지 않았다. 효과는 7글자 영역에 한정하며 `prefers-reduced-motion`·forced colors에서는 일반 글자로 표시한다. Screen reader에는 ‘답변 생성 중’이라는 status 이름을 제공한다. Impeccable의 gradient-text 검출 두 곳은 사용자가 요청한 진행 상태 shimmer에만 적용한 의도적인 예외이며 제목·본문에는 사용하지 않는다.

## 검증

- Frontend 22개 파일·94개 테스트, web typecheck, 전체 lint·production build 통과. 기존 Zod annotation·bundle size 경고는 유지된다.
- Desktop 1440×1000·Mobile 390×844 합성 Browser: 기본 펼침, 수동 접기 유지, 새 질문의 펼침 복원, running 중 background position 변화, 대기·완료·실패·중단 시 Thinking 제거를 확인했다.
- Reduced motion에서는 animation이 none이고 Thinking 글자와 상태 이름은 유지된다. 두 viewport에 가로 overflow와 alert·console 오류가 없다.
- `/tests/registry-chat.html?activity=1`은 실제 ChatPanel·ChatRunActivity를 사용하는 Vite 전용 합성 검증이다. 외부 모델·운영 대화는 호출하지 않으며 production bundle에는 포함하지 않는다.

## PRISM-DEV 배포

2026-09-09 15:24:31 KST에 application `0.8.0-alpha.29`, chart `0.10.28`을 Helm revision **40**으로 배포했다. Source `f49c82e38ca566d39f940e221ccdd6c5c5ff3778`, release 설정 `3bcb983`를 push한 뒤 적용했다. Source commit의 clean git archive로 linux/amd64 이미지를 만들고 검증된 alpha.28 runtime base를 재사용했다.

- Image index: `sha256:c59126b3603386cd6db4802f2b122c88e7eb4a4a00ad1f61deaac288836e7cac`
- Linux/amd64 manifest: `sha256:78d495c3c732f1d448b5df9dd7f1a518965f854bc0b6acfbb8b1009ffe040aa6`
- SBOM·provenance attestation: `sha256:7a8bc09d568fbbb0d07b214e0c5d96466829b170a1adedb7028e53efc6ebbfdc`
- OCI chart `registry-1.docker.io/pydemia/git-code-reviewer:0.10.28`: `sha256:51cecff020a63923188c9d7162f53e7776f10b224073ee40a98d170be03d4b13`

Image를 UID 1000·read-only·network-none으로 실행해 version과 새 UI asset을 확인했다. Build CA secret·Browser 합성 harness는 실행 image에 포함되지 않는다. Helm은 PRISM-DEV context·git-code-reviewer namespace에서 기존 values를 재사용하고 image만 교체했다. Image 외 values hash는 배포 전·server dry-run·배포 후 모두 `5f3eb1ed55f94d7ce9048eb9ef17e4b92400f3533ed9c8a5da1823ef66bb05c9`다.

새 Server `git-code-reviewer-server-6bbc5f4ff4-pgcd6` 1/1·Worker `git-code-reviewer-worker-7b9c968cc9-l5kmq` 2/2 Ready, restart 0이며 두 rollout이 완료됐다. Health startup/live/ready/dependencies는 모두 ok, system version은 alpha.29다. Helm 연결 test는 15:25:35 KST에 Succeeded로 끝났다. Migration 31개가 모두 적용됐고 checksum 불일치는 없다.

실제 `http://pr-review.prism.ai` gateway 응답의 asset이 image와 일치한다.

- `/assets/index-p4ne6MG0.js`: SHA-256 `5c3ef5966f7cb4bcd621dc4f3d9ab0f34a1f0356b27442c491cc41a01f9833b6`
- `/assets/index-BCAc3R7X.css`: SHA-256 `c6d2a203b4e6cd04c9210492af44cab0075f8e5b75383005c1a3f1ed804978d5`

기존 사용자 7명·account 7개·분석 78건·report 69건의 ID가 모두 남아 있다. 기존 운영 분석 한 건이 완료되어 report는 70개가 됐고 대기·실행 job은 0개다. Provider v8 Terra/medium/concurrency 4와 configuration hash를 유지했다. Auth·credential registry·PostgreSQL Secret과 CA ConfigMap, HTTPRoute는 UID/resourceVersion이 그대로다. nfs-csi의 두 PVC는 기존 UID·PV·storage 정책을 유지하며 artifact PVC의 release label에 따른 resourceVersion만 바뀌었다.

Alpha.28 Worker `git-code-reviewer-worker-59d6c59f9-q4hd5`는 source-sandbox의 3600초 종료 유예로 Terminating 상태다. 강제 삭제하지 않았다. 실제 운영 모델 질문·재분석·PR 게시를 이번 검증 목적으로 시작하지 않았다. 사용자에게 표시되는 동작은 합성 Browser로, 배포 후 전달되는 구현체는 asset hash·health로 각각 확인했다.
