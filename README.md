# Git Code Reviewer

사내 GitHub Enterprise Server의 PR을 중앙에서 분석하고 browser review workspace와 GHES PR timeline에 결과를 제공하는 Kubernetes 기반 웹서비스입니다. 대상 repository의 CI와 webhook 없이 polling, isolated clone, evidence 기반 report, 관리형 PR 요약 댓글과 Chat을 제공합니다.

## 기준 문서

1. [제품 정의](PRODUCT.md)
2. [제품·시스템 Blueprint](.documents/blueprint.md)
3. [요구사항 명세서](.documents/requirements-specification.md)
4. [기능 설계서](.documents/functional-design.md)
5. [Review Workspace UI 설계](.documents/ui-implementation-design.md)
6. [구현 계획서](.documents/implementation-plan.md)
7. [설계 검토 처리 결정](.documents/design-review-resolution-2026-09-02.md)
8. [테넌시·인가·프롬프트 설계](.documents/tenancy-identity-authorization-prompt-design.md)
9. [Agent handoff](.documents/handoff.md)

## Visual

- [동작 가능한 Review Workspace concept](.documents/visuals/review-workspace.html)
- [Review Workspace preview](.documents/visuals/review-workspace-preview.png)
- [Logical/Kubernetes architecture](.documents/visuals/git-code-reviewer.drawio)

초기 아이디어인 `.documents/idea.md`는 배경 자료이며, 현재 제품 범위는 위 기준 문서가 우선합니다.

## 개발과 배포

이 repository는 browser frontend와 API/Worker를 하나의 immutable OCI image로 빌드한다. Kubernetes에서는 Server/Worker/migration/retention이 같은 image의 서로 다른 command를 사용하며, PostgreSQL은 외부 서비스 또는 Helm의 선택형 Bitnami dependency로 운영한다.

- [로컬 PostgreSQL 개발 가이드](docs/operations/development.md)
- [Kubernetes/Helm 배포 가이드](docs/operations/deployment.md)
- [Identity·인가·테넌트 운영 가이드](docs/operations/identity-authorization.md)
- [Private GHES 연동 테스트 가이드](docs/operations/github-enterprise-test.md)
- [Backup/restore 및 reconcile 가이드](docs/operations/backup-restore.md)

배포된 Web UI에서는 로그인 후 GNB의 `내 프로필`에서 계정 정보와 Local account 비밀번호를 관리한다. `사용 가이드`에서는 GHES PAT 발급·입력, repository polling, Review workspace, Chat과 오류 진단 절차를 확인할 수 있다.

`Administration → 분석 Skills`에서 분석 관점과 report 형식의 SKILL.md를 version으로 관리한다. 새 분석은 고정된 Skill bundle으로 code segment를 검토하고 Overall Summary·AI Comments·Analyzed File List를 제공한다. 상세 범위와 검증 기준은 [Skill 기반 report 설계](.documents/skill-based-review-report.md)를 참조한다.

Review workspace의 `Memory` 탭은 사용자별 검토 이력과 GitHub PR 대화를 개인 메모리 후보로 관리하고, 여러 사용자의 승인을 repository 집단 메모리 후보로 집계한다. 분석과 Chat은 현재 코드 근거를 먼저 사용하며 집단 메모리, 개인 메모리 순으로 과거 판단을 참고한다. 관리자 승인은 `Administration → Repository Memory`에서 처리한다. 저장·검색·원문 버전 정책은 [Review Memory 설계](.documents/review-memory-design.md)를 참조한다.

기본 관점 6개는 Commit Defender 원문의 점검 항목과 Tone을 한국어로 옮겼다. `분석 프롬프트`에서 tenant별 Severity Level(lean·generous·moderate·rigorous·severe, 기본 moderate)을 고를 수 있다. 지침과 수준은 함께 version으로 저장하고 새 분석 queue에 고정한다. 수준별 범위와 기존 custom Skill 적용 방법은 [분석 수준 설계](.documents/analysis-severity-level.md)를 참조한다.

```bash
export POSTGRES_PASSWORD='local-only-password'
docker compose -f compose.dev.yaml up -d postgres
cp .env.example .env
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
