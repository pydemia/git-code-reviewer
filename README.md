# Git Code Reviewer

GitHub·GitHub Enterprise Server의 PR을 수집·분석하고 보고서와 과거 리뷰 이력을 제공하는 웹서비스입니다. Commit Defender는 중앙 원문·Skill·활성 지침을 내려받아 사용자가 선택한 로컬 provider로 리뷰합니다. CD 연결은 중앙 모델 대행이나 로컬 소스·결과 업로드를 추가하지 않습니다.

## 제품 안내

- [Introduction](docs/product/introduction.md): 제품 목적, 검토 흐름과 개인·집단 메모리 소개
- [기능 목록](docs/product/features.md): 실제 메뉴별 제공 기능과 현재 지원 범위
- 앱 상단의 `문서`에서 Introduction, 설치·연결, 아키텍처, 기능 목록과 사용 가이드를 전환합니다. 직접 경로는 `/introduction`, `/getting-started`, `/architecture`, `/features`, `/guide`입니다.

제품 문서는 Markdown 원문을 앱과 저장소에서 함께 사용합니다. 화면의 새 설명은 다음 Web 빌드·배포에 반영됩니다.

## 설치와 사용 문서

- [설치·연결 가이드](docs/product/getting-started.md): GCR Compose·소스·Helm 설치, 첫 설정, CD VSIX 설치, 모델 선택, reader 연결과 사용 예시
- [아키텍처](docs/product/architecture.md): 중앙 PR 리뷰와 로컬 리뷰의 역할, 원문·지침·cache·권한과 모델 통신 경계
- [문서 색인](docs/README.md): 역할과 작업별 how-to·운영 문서
- [CD 설치·기능 문서](https://github.com/pydemia/commit-defender/blob/codex/review-memory-pull-g03/README.md)

현재 사용 계약은 위 문서와 구현 소스를 따릅니다. [제품 정의](PRODUCT.md), `.documents`의 초기 Blueprint·기능 설계·구현 계획은 변경 배경입니다. 단방향 리뷰 이력 활용으로 정리한 현재 범위와 실제 전달 상태는 [review-memory-pull 계획](.documents/review-memory-pull-implementation-plan.md)과 [G04 실행 기록](.documents/execution/review-memory-pull/G04.md)에서 확인할 수 있습니다.

## Visual

- [동작 가능한 Review Workspace concept](.documents/visuals/review-workspace.html)
- [Review Workspace preview](.documents/visuals/review-workspace-preview.png)
- [Logical/Kubernetes architecture](.documents/visuals/git-code-reviewer.drawio)

초기 아이디어인 `.documents/idea.md`는 배경 자료이며, 현재 제품 범위는 설치·연결 가이드와 기능 목록, 실제 구현을 기준으로 확인합니다.

## 개발과 배포

이 repository는 browser frontend와 API/Worker를 하나의 immutable OCI image로 빌드한다. Kubernetes에서는 Server/Worker/migration/retention이 같은 image의 서로 다른 command를 사용하며, PostgreSQL은 외부 서비스 또는 Helm의 선택형 Bitnami dependency로 운영한다.

- [로컬 PostgreSQL 개발 가이드](docs/operations/development.md)
- [Kubernetes/Helm 배포 가이드](docs/operations/deployment.md)
- [Identity·인가·테넌트 운영 가이드](docs/operations/identity-authorization.md)
- [Private GHES 연동 테스트 가이드](docs/operations/github-enterprise-test.md)
- [Backup/restore 및 reconcile 가이드](docs/operations/backup-restore.md)

배포된 Web UI에서는 로그인 후 GNB의 `내 프로필`에서 계정 정보와 Local account 비밀번호를 관리한다. `문서 → 사용 가이드`에서는 GHES PAT 발급·입력, repository polling, Review workspace, Chat, Memory 관리와 오류 진단 절차를 확인할 수 있다.

`Administration → 분석 Skills`에서 분석 관점과 report 형식의 SKILL.md를 version으로 관리한다. 새 분석은 고정된 Skill bundle으로 code segment를 검토하고 Overall Summary·AI Comments·Analyzed File List를 제공한다. 상세 범위와 검증 기준은 [Skill 기반 report 설계](.documents/skill-based-review-report.md)를 참조한다.

Review workspace의 `Memory` 탭은 사용자별 검토 이력과 GitHub PR 대화를 개인 메모리 후보로 관리하고, 여러 사용자의 승인을 repository 집단 메모리 후보로 집계한다. 분석과 Chat은 현재 코드 근거를 먼저 사용하며 집단 메모리, 개인 메모리 순으로 과거 판단을 참고한다. 관리자 승인은 `Administration → Repository Memory`에서 처리한다. 저장·검색·원문 버전 정책은 [Review Memory 설계](.documents/review-memory-design.md)를 참조한다.

상단의 `리뷰 이력`은 분석 결과나 메모리 승인 없이 원문·답글·본문 버전·출처를 읽는 별도 경로입니다. 원문 연결 지침은 적용 조건과 반증을 확인한 관리자가 활성화·발행할 수 있으며 개인 메모리의 집단 승격을 먼저 거치지 않습니다. `내 프로필 → 클라이언트 연결`의 공개 연결 JSON과 CD용 `knowledge:read` key로 이 자료를 내려받습니다.

기본 관점 6개는 Commit Defender 원문의 점검 항목과 Tone을 한국어로 옮겼다. `분석 프롬프트`에서 tenant별 Severity Level(lean·generous·moderate·rigorous·severe, 기본 moderate)을 고를 수 있다. 지침과 수준은 함께 version으로 저장하고 새 분석 queue에 고정한다. 수준별 범위와 기존 custom Skill 적용 방법은 [분석 수준 설계](.documents/analysis-severity-level.md)를 참조한다.

```bash
export POSTGRES_PASSWORD='local-only-password'
docker compose -f compose.dev.yaml up -d postgres
cp .env.example .env
# .env의 DATABASE_URL 비밀번호를 POSTGRES_PASSWORD와 맞춘다.
set -a; source .env; set +a
corepack pnpm install --frozen-lockfile
pnpm migrate
pnpm dev
```

전체 stack을 container로 실행하려면 다음 명령을 사용한다.

```bash
docker compose up --build --wait
```

VS Code에서는 `GCR: Full Development Stack` launch compound로 Server, Worker와 Web debugger를 함께 시작할 수 있다. 자세한 내용은 [`docs/operations/development.md`](docs/operations/development.md)를 참고한다.

별도 terminal에서 Worker를 실행한다.

```bash
set -a; source .env; set +a
pnpm build:packages
pnpm --filter @gcr/runtime exec tsx src/index.ts worker
```

OCI image 기본 repository는 `docker.io/pydemia/git-code-reviewer`이며, Helm chart는 [`deploy/helm/git-code-reviewer`](deploy/helm/git-code-reviewer)에 있다. 배포본 chart는 같은 Docker Hub repository에서 `oci://registry-1.docker.io/pydemia/git-code-reviewer`로 받을 수 있다.

TLS inspection 환경에서 image를 빌드할 때는 승인된 사내 CA를 BuildKit secret으로 전달한다. 인증서 검증을 끄지 않으며 CA 파일은 Git이나 최종 image에 복사하지 않는다. 이 설정은 build에만 적용된다. 실행 중 outbound TLS에는 Helm의 `trustedCa` 설정이 별도로 필요하다.

```bash
docker build --secret id=build_ca,src=/absolute/path/corporate-ca.crt \
  --tag git-code-reviewer:local .
```
