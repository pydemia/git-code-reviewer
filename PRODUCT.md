# 제품 정의

<!-- impeccable:product-schema 1 -->

## Platform

web

## 기술 Stack

현재 visual prototype은 static HTML, CSS, JavaScript로 작성한다. Production 기준 architecture는 `.documents/blueprint.md`에 정의한 Next.js, React, TypeScript 구성을 따른다.

## 사용자

- merge 전에 private GitHub PR을 검토하는 code reviewer
- evidence를 확인하고 finding에 대응하는 PR 작성자
- review, model, retention, merge policy를 관리하는 repository 관리자
- 접근 기록과 분석 이력을 확인하는 보안·감사 담당자

## 제품 목적

Git Code Reviewer는 PR의 base/merge-base/HEAD를 immutable snapshot으로 고정하고 Git과 code history를 분석한다. Reviewer는 각 finding을 정확한 diff, symbol, commit, ownership evidence와 대조해 확인할 수 있다.

## 제품 위치

Deterministic Git/AST evidence와 specialist Review Agent를 결합한다. Findings와 Chat은 같은 immutable snapshot에 고정하며 stale 상태나 근거가 부족한 주장을 숨기지 않는다.

## 운영 환경

Application은 사내 VM 또는 Kubernetes cluster에 중앙 배포한다. Reviewer는 사내망 또는 VPN으로 접근한다. GitHub API, GraphQL, Git, Check와 review comment 요청은 고정된 사내 egress IP를 통해 outbound-only로 전송하며 기준 구조는 inbound webhook을 요구하지 않는다.

## 기능과 제약

- Repository별 layout preference를 저장하는 resizable LNB/Main/Chat/FNB review workspace
- LNB의 Files, Findings, Outline, Impact mode
- Findings 옆에서 계속 사용할 수 있는 snapshot-scoped Chat dock과 split diff
- Git graph, History, Ownership, Impact, 관련 test를 제공하는 compact evidence dock
- PR polling, 수동 refresh, immutable snapshot과 stale run 처리
- P0–P3 priority, 독립된 confidence와 감사 가능한 suppression directive
- 사람의 승인 없는 merge나 source branch 수정은 하지 않음
- Private source code는 승인된 storage와 model 경계 안에서만 처리
- GitHub Enterprise Cloud/GHES, 우선 지원 언어, repository 규모와 model endpoint는 구현 전에 확정

## 현재 근거 문서

- `.documents/idea.md`
- `.documents/blueprint.md`
- `.documents/requirements-specification.md`
- `.documents/functional-design.md`
- `.documents/implementation-plan.md`
- `.documents/handoff.md`
- `.documents/ui-implementation-design.md`
- Production telemetry, 고객 claim, brand asset과 실측 performance data는 아직 없음

## 제품 원칙

- 모든 finding은 검증 가능한 evidence로 돌아갈 수 있어야 한다.
- Review 상태를 표시하는 곳에는 snapshot identity를 함께 보여준다.
- Findings와 Chat은 동시에 사용할 수 있어야 하며 navigation 전환으로 대화 상태나 작성 중인 입력을 버리지 않는다.
- Concept prototype은 시각 방향을 보여주는 자료다. Production 범위는 blueprint와 UI 구현 설계를 따른다.
- Deterministic 수집과 model inference를 분리한다.
- 불완전한 분석과 omission을 명시한다.
- 최종 merge 판단은 사람이 담당한다.
