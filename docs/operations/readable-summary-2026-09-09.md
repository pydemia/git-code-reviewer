# Summary Skill과 PR 댓글 가독성

## 적용 범위

- Built-in `overall-summary`·`total-summary` form을 version 2로 올렸다. 짧은 결론 뒤에 독립적인 논점을 bullet list로 정리하고 실제 조치 순서가 있을 때만 numbered list를 사용한다. 파일별 comment·coverage를 근거로 하며 새로운 finding이나 priority를 만들지 않는다.
- Total Summary는 PR 전체 요약만 작성한다. 전체 report·AI Comments·파일 목록을 다시 생성하지 않는다. 검토가 완료됐고 지적할 내용이 없는 파일에는 짧은 완료 문장만 사용한다.
- PR publication은 `formatReviewMarkdown`의 `audience: pull-request`를 사용한다. PR 전체 요약, 검토 수·판정·분석 제한, comment가 있는 파일의 요약·comment-block, provenance와 전체 report 링크를 남긴다. 전체 파일 목록과 comment가 없는 파일별 요약은 생략한다.
- 긴 AI Comments는 기존처럼 하나의 details 안에 접는다. 파일 요약은 해당 comment 묶음 안에서 한 번만 표시한다. 앱·Markdown export의 전체 파일 목록과 Raw JSON은 유지한다.
- 문단·목록·강조·inline code는 제한적으로 복원한다. 소제목은 굵은 글자로 정리하며 HTML·임의 링크·mention은 escape한다. 길이 제한은 기존 block 단위 처리와 닫는 details 보존 규칙을 유지한다.

기존 report 원문과 이미 queue에 고정된 Skill bundle은 바꾸지 않는다. 관리자 custom Skill version을 자동으로 덮어쓰지 않는다. PRISM-DEV 사전 점검에서는 active custom version이 없어 Built-in을 사용 중이었다. 변경된 Skill은 배포 후 생성하는 새 분석부터, PR 댓글 구성은 다음 정상 게시·갱신부터 적용된다. 기존 PR 댓글을 검증 목적으로 일괄 수정하지 않는다.

Built-in bundle SHA-256은 `1f82188dfc8f859b220087784ce08a90e4e01c8ab15bcf303c52ddb87a6a6a6c`다. 다른 perspective와 unit-comment-block의 내용·version은 유지했다.

## 검증

- 격리된 PostgreSQL 17 UTF-8 환경에서 76개 파일·469개 테스트 통과. Skill version·hash, pinned bundle, Worker의 canonical report 게시, comment가 없는 파일 생략, export의 전체 파일 보존과 immutable report를 확인했다.
- 전체 lint·typecheck·production build 통과. 기존 Zod annotation·bundle size 경고는 유지된다.
- 합성 PR Markdown을 실제 CommonMark parser로 읽어 목록 3개·강조 10개·comment blockquote 1개를 확인했다. 생성한 report/finding 링크 두 개만 남았고 comment가 없는 파일과 Analyzed File List는 없었다. GitHub 서비스의 실제 렌더링 화면을 검증한 것은 아니다.
- HTML·link·mention·details injection, inline code escaping, 기본 접힘과 60,000자 게시 제한을 테스트했다. 실제 모델 호출·재분석·PR 댓글 게시를 검증 목적으로 실행하지 않았다.

## PRISM-DEV 배포

2026-09-09 19:19:07 KST에 application `0.8.0-alpha.30`, chart `0.10.29`를 Helm revision **41**로 배포했다. Source `43c7d331daa2f6e31d1bc374817f7d875cc789a1`과 release pin `2302a31`을 push한 뒤 적용했다. Source commit의 clean git archive로 linux/amd64 이미지를 만들고 alpha.29 runtime base를 재사용했다.

- Image index: `sha256:edc36b4434db8ebc1aa75eec9639f42514b2cf6631a7eada39ee57fba4f2e072`
- Linux/amd64 manifest: `sha256:e88879bbe4309f82bcedff7ebca02521c44f36a610e02ef4711b3a93544ff026`
- SBOM·provenance attestation: `sha256:fb7e93884821e0eb58dbee891e4130443e9b13dca56734c8a108d4aaf3c60778`
- OCI chart `registry-1.docker.io/pydemia/git-code-reviewer:0.10.29`: `sha256:35fdcbb4708d7248efda5ff29f53982bc6a3aed2cf1c1fe041bb5e1aebd5411e`

게시 image를 UID 1000·read-only·network-none으로 실행해 두 Summary form v2, PR의 comment 보유 파일만 표시하는 구성, 목록 서식과 전체 Markdown export 보존을 확인했다. Build CA secret은 실행 image에 없다. 배포된 Server·Worker에서도 같은 검증을 통과했고 effective Skill source가 `builtin`이며 위 bundle hash와 일치했다. Worker 검증 스크립트는 처음에 Server용 config 검증을 호출해 종료됐으며, 실제 Worker와 같은 `loadConfig(process.env, 'worker')`로 수정한 뒤 재검증했다. 앱 설정이나 Secret은 변경하지 않았다.

새 Server `git-code-reviewer-server-7f548896-cjm6j`는 1/1, Worker `git-code-reviewer-worker-84b7598f5c-f5jfw`는 2/2 Ready이며 restart 0이다. Health startup/live/ready/dependencies는 모두 ok, system version은 alpha.30이다. Helm 연결 test는 19:20:17 KST에 Succeeded로 끝났다. Migration 31개의 checksum이 모두 일치하고 새 migration은 없다. 확인한 새 Server·Worker log의 warning/error는 0건이다.

실제 `http://pr-review.prism.ai` gateway의 asset이 image와 일치한다.

- `/assets/index-XzBxQycQ.js`: SHA-256 `32fc23e24b8e723e0f7378bb26996cde56c683192e24e384349dcba0b4af52b7`
- `/assets/index-BCAc3R7X.css`: SHA-256 `c6d2a203b4e6cd04c9210492af44cab0075f8e5b75383005c1a3f1ed804978d5`

Image 외 Helm values hash는 배포 전·server dry-run·배포 후 모두 `5f3eb1ed55f94d7ce9048eb9ef17e4b92400f3533ed9c8a5da1823ef66bb05c9`다. Provider v8 `gpt-5.6-terra:medium`·concurrency 4·timeout 300000과 configuration hash를 보존했다. Auth·credential registry·PostgreSQL Secret, CA ConfigMap과 HTTPRoute의 UID/resourceVersion은 그대로다. nfs-csi의 PostgreSQL RWO 10Gi·artifacts RWX 10Gi PVC는 UID·PV·capacity를 유지하며 artifacts PVC의 release label에 따른 resourceVersion만 바뀌었다.

배포 전 사용자 7명·account 7개·분석 89건·report 81건의 ID가 모두 남아 있다. 작업 중 별도 운영 분석 한 건이 생성·완료되어 분석 90건·report 82건이 됐으며 확인 시 대기·실행 job은 0개다. 이 작업의 검증으로 모델 호출·재분석·PR 게시를 시작하지 않았다. 기존 report 원문을 수정하는 migration이나 API도 호출하지 않았다.

Alpha.29 Worker `git-code-reviewer-worker-7b9c968cc9-l5kmq`는 source-sandbox 종료 유예로 Terminating 상태이며 강제 삭제하지 않았다. 실제 모델이 새 지침에 따라 작성한 결과나 GitHub 화면은 이번 검증 범위에 포함하지 않는다. 변경된 Skill의 적용 시점과 기존 report 보존은 위 적용 범위를 따른다.
