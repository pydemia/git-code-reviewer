# PR 메시지 펼침과 공통 작성 지침

## 변경 범위

- PR 메시지: 중복 Overall Summary·전체 파일 목록 생략을 유지한다. 전체 분석 요약과 분석 제한을 접기 영역 밖의 Header·본문·List로 표시한다. AI Comments는 기존처럼 접는다.
- Markdown export: 길이 600자 기준으로 전체 요약을 접던 동작을 제거한다. 전체 파일별 검토·파일 목록은 남긴다.
- Browser: Summary의 분석 제한을 기본으로 펼친다. 사용자는 직접 접을 수 있다.
- 공통 Prompt: Skill 3개 stage·legacy 분석·interactive Chat·report 기반 Chat에 동일한 작성 지침을 전달한다. 요약은 개조식 Header·List, 상세 원인·흐름·조건은 문단을 사용한다. 고정 개수의 항목·빈 제목·불필요한 반복은 금지한다.
- Built-in Skill: overall-summary·total-summary v3, unit-comment-block v2. Perspective·분석 수준·모델·effort는 변경하지 않는다.
- Markdown 안전성: model Header는 report section보다 낮은 h4–h6으로 제한한다. HTML·임의 링크·mention escape와 60,000자 게시 제한을 유지한다.

첨부된 PR 메시지의 Overall Summary·Analyzed File List는 alpha.30 이전 게시 형식이다. 작업 시작 시 코드에는 PR 전용 compact audience가 이미 적용되어 있었다. 댓글의 정확한 게시 version은 첨부 이미지로 판별할 수 없다. 기존 댓글을 외부에서 다시 쓰는 검증은 수행하지 않는다.

## 적용과 보존

- 기존 report·대화·개인 Prompt·custom Skill·pinned bundle은 덮어쓰지 않는다.
- 새 Skill은 새 분석부터, PR 구성은 다음 정상 게시·갱신부터 적용한다. 기존 checkpoint 결과는 재생성하지 않는다.
- Chat의 공통 지침은 새 질문에 고정된다. 근거·권한·JSON·citation 규칙과 사용자별 대화 분리를 유지한다.
- 기존 줄글을 문장 분할만으로 자동 요약하지 않는다. 원문의 의미와 근거를 보존하며 새 모델 출력에 작성 규칙을 적용한다.

## 검증

- 격리된 UTF-8 PostgreSQL 17에서 77개 파일·476개 테스트 통과. 긴 전체 요약·제한의 접힘 제거, PR compact 구성, source 불변성, Header 제한, 분석·Chat 공통 Prompt와 JSON·citation 보존을 확인했다.
- 전체 lint·typecheck·production build 통과. 기존 Zod annotation·bundle size 경고는 유지된다.
- Desktop 1440×1000·중간 너비 820×1000·Mobile 390×844 합성 Browser에서 내용·Header·List, 기본 펼침과 키보드 수동 접기·펼치기, 가로 overflow 없음을 확인했다. CSS zoom 200%에서도 넘침이 없으며 브라우저 자체 zoom 검증과는 구분한다.
- 사용 가이드의 작성 지침·PR 구성 설명을 Header·List로 바꿨다. Impeccable clarify/polish는 기존 색상·배치를 유지하며 중복 제거·기본 펼침·정보 계층만 정리하는 데 사용했다. 수동 detector 결과는 빈 배열이다. React 검토에서도 불필요한 state·effect·dependency를 추가하지 않았다.
- `apps/web/tests/structured-messages.html`은 실제 Report·Markdown 컴포넌트를 사용하는 개발 서버 전용 합성 fixture다. 외부 모델·GitHub를 호출하지 않으며 production bundle에는 포함하지 않는다. 실제 모델의 새 출력 품질·GitHub 렌더링 화면은 이번 검증 범위가 아니다.

Built-in bundle SHA-256: `dc25811a1b436f80576aa2a129c7a2431dbb52638ee66820065dfe82ef4a947c`.

## PRISM-DEV 배포

- 적용: **2026-09-10 08:54:35 KST**, application `0.8.0-alpha.31`, chart `0.10.30`, Helm revision **42**
- Source: `729de5bb5616e244d699f1c57ce01b056cf9add4`. Release pin: `38b0a9a`. 두 commit을 push한 뒤 적용했다.
- Build: source commit의 clean git archive, linux/amd64, alpha.30 runtime base 재사용. Dependency 설치와 파일 처리에 평소보다 시간이 걸렸지만 전체 image build·push를 완료했다.
- Image index: `sha256:c190547fe932f7b8d8219986260bb7feb6bc76f32889478a61955511f52c4f3d`
- Linux/amd64 manifest: `sha256:24b94fae68865e7c53827064abae5767cce41702e2232f93d70c633fa64149c4`
- SBOM·provenance attestation: `sha256:34c2c828000b37b8cbee824d563ecca02a90245ab139f53575e6ee204283bbcc`
- OCI chart `registry-1.docker.io/pydemia/git-code-reviewer:0.10.30`: `sha256:1b66111c31a777eec1affd1d75cbc67e5fe9d6f9e51779eae2208e8292d03651`

### 배포 검증

- Image를 UID 1000·read-only·network-none으로 실행해 새 Skill, 공통 Prompt, 펼쳐진 요약·제한, PR의 comment 보유 파일만 표시하는 구성과 전체 Markdown export 보존을 확인했다. 실행 image에 build CA secret·Browser fixture는 없다.
- 실제 Server·Worker의 effective Skill source는 `builtin`이며 bundle hash가 위 값과 일치한다. 동일한 formatter·공통 Prompt 검증도 통과했다.
- 새 Server `git-code-reviewer-server-7995578787-fb5hv` 1/1, Worker `git-code-reviewer-worker-fc4756bf-tv682` 2/2 Ready, restart 0이다. 확인한 log의 warning/error는 0건이다.
- Health startup/live/ready/dependencies 모두 ok, system version alpha.31, 비로그인 `/api/v1/me`는 401이다. Helm 연결 test는 **08:55:39 KST Succeeded**다.
- Migration 31개 checksum 모두 일치하며 새 migration은 없다. 배포 전후 사용자 7명·account 7개·분석 99건·report 91건의 ID가 모두 동일하다. 대기·실행 job은 0개다.
- 실제 gateway의 JS·CSS hash가 게시 image와 일치한다. `/assets/index-BGGs7h6i.js`: `e2e5da63bcc907fa902d22b3d8f4c3155a782eccf02050f2a87efd76a5b0f8db`, `/assets/index-BCAc3R7X.css`: `c6d2a203b4e6cd04c9210492af44cab0075f8e5b75383005c1a3f1ed804978d5`.
- 합성 PR Markdown의 CommonMark AST에서 전체 분석 요약·분석 제한 heading, 하위 heading과 목록 2개를 확인했다. 해당 요약·제한에는 details가 없다. 실제 GitHub 댓글을 게시한 검증과는 구분한다.

### 보존한 설정

- Image 외 Helm values hash는 배포 전·dry-run·배포 후 모두 `5f3eb1ed55f94d7ce9048eb9ef17e4b92400f3533ed9c8a5da1823ef66bb05c9`다.
- Provider v8 `gpt-5.6-terra:medium`·concurrency 4·timeout 300000과 configuration hash를 유지했다.
- Auth·credential registry·PostgreSQL Secret, corporate CA ConfigMap, HTTPRoute의 UID/resourceVersion은 그대로다.
- nfs-csi PostgreSQL RWO 10Gi·artifacts RWX 10Gi의 PVC UID·PV·capacity를 유지했다. Artifacts PVC는 release label에 따른 resourceVersion만 변경됐다.

Alpha.30 Worker `git-code-reviewer-worker-84b7598f5c-f5jfw`는 source-sandbox 종료 유예로 Terminating 상태이며 강제 삭제하지 않았다. 실제 모델 호출·재분석·기존 PR 댓글 갱신은 이번 검증 목적으로 실행하지 않았다.
