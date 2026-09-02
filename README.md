# Git Code Reviewer

사내 GitHub Enterprise Server의 PR을 중앙에서 분석하고 browser review workspace로 제공하는 Kubernetes 기반 웹서비스입니다. 대상 repository의 CI, webhook과 GitHub write-back 없이 polling, isolated clone, evidence 기반 report와 Chat을 제공합니다.

## 기준 문서

1. [제품 정의](PRODUCT.md)
2. [제품·시스템 Blueprint](.documents/blueprint.md)
3. [요구사항 명세서](.documents/requirements-specification.md)
4. [기능 설계서](.documents/functional-design.md)
5. [Review Workspace UI 설계](.documents/ui-implementation-design.md)
6. [구현 계획서](.documents/implementation-plan.md)
7. [설계 검토 처리 결정](.documents/design-review-resolution-2026-09-02.md)
8. [Agent handoff](.documents/handoff.md)

## Visual

- [동작 가능한 Review Workspace concept](.documents/visuals/review-workspace.html)
- [Review Workspace preview](.documents/visuals/review-workspace-preview.png)
- [Logical/Kubernetes architecture](.documents/visuals/git-code-reviewer.drawio)

초기 아이디어인 `.documents/idea.md`는 배경 자료이며, 현재 제품 범위는 위 기준 문서가 우선합니다.
