# Git Code Reviewer — Session Handoff

## 이번 session에서 완료한 작업

`.documents/blueprint.md`의 기준 배포 구조를 GitHub webhook ingress에서 **사내 중앙 service + outbound-only PR polling**으로 변경했다. 사용자의 계속 작업 요청에 따라 이전 handoff에서 권장한 polling 안을 기준안으로 채택했다.

다음 항목을 같은 운영 모델로 정합화했다.

- MVP 범위와 PR 분석 시작 흐름
- 시스템 구성도, 기준 기술 스택과 source layout
- GitHub Adapter, Poll Scheduler와 Snapshot Collector 책임
- data model, 외부 API와 내부 event contract
- network/security boundary와 권한 회수 처리
- detection lag, quota reserve, scheduler 복구 목표
- telemetry, Phase 0 완료 조건, test 전략과 주요 위험

Webhook은 완전히 삭제하지 않고 보안 정책상 inbound가 허용될 때만 사용하는 `internal-webhook` 또는 `dmz-relay` 선택 mode로 내렸다. 기준 구현과 Phase 0에는 webhook이 필요하지 않다.

## 확정한 기준 구조

```text
GitHub Cloud / GHES
        ▲
        │ outbound HTTPS only
        │ API · GraphQL · Git · Check/comment publish
        │ fixed corporate egress IP
        │
PR Poller / Snapshot Collector / Report Publisher
        │
        ▼
Queue → Analysis Worker → PostgreSQL / Object Storage / Model Gateway
        ▲
        │ internal network or VPN
Reviewer Browser → Web/API
```

- application은 사내 VM 또는 Kubernetes에 중앙 배포한다.
- reviewer는 사내망 또는 VPN에서 browser로 접근한다.
- GitHub는 application workload로 연결을 시작하지 않는다.
- poller는 active/idle 정책으로 PR을 조회하고 화면 진입 또는 수동 refresh를 우선 처리한다.
- Check와 review comment 게시도 대표 egress IP를 통한 outbound 요청이다.

## 핵심 contract

- poll state에는 완료 checkpoint, pagination cursor, conditional request validator, quota, `x-poll-interval`, backoff와 다음 실행 시각을 저장한다.
- `updated_at`은 조회 후보를 줄이는 hint이며 snapshot 생성 여부는 base/head OID와 PR state transition으로 판단한다.
- snapshot unique key는 `GitHub host + repository ID + PR number + base OID + head OID`다.
- 같은 ref의 reopen/draft 해제는 snapshot을 복제하지 않고 필요한 analysis run만 예약한다.
- scheduler는 PostgreSQL lease로 shard별 단일 순회를 유도하고, 최종 중복 방지는 snapshot/run idempotency가 담당한다.
- automatic polling은 quota의 80%까지만 사용하고 refresh, 게시, 권한 확인용 reserve를 둔다. 비율은 sizing 결과에 따라 조정한다.
- webhook 없는 권한 변경은 짧은 authorization TTL, 민감 동작 재검증과 installation/repository reconciliation으로 처리한다.

## 다음 작업

구현에 들어가기 전에 아래 환경 값을 확인한다.

- GitHub Enterprise Cloud인지 특정 GHES version인지
- GitHub host별 허용 outbound endpoint, 대표 egress IP와 DNS/TLS inspection 방식
- organization/repository 수, open/active PR 수, 허용 가능한 detection lag
- GitHub App token을 직접 발급할지 사내 credential broker를 사용할지
- 중앙 service가 bare mirror, diff artifact와 chat을 보존할 수 있는지
- approved model endpoint와 source/prompt retention 조건
- 우선 지원 언어 두 개와 monorepo/build system
- inline comment와 P3 Check failure 정책

위 값이 일부 미정이어도 작은 private test repository를 대상으로 Phase 0 walking skeleton을 시작할 수 있다. 구현 순서는 monorepo/local stack → poll state schema와 scheduler lease → GitHub installation/repository reconciliation → PR change detection → immutable snapshot/diff → 빈 report와 Check 게시가 적절하다.

## 현재 repository 상태

- branch: `main`
- 수정 파일: `.documents/blueprint.md`, `.documents/handoff.md`
- commit과 push는 수행하지 않음

`idea.md`와 blueprint에는 Korean/English technical term을 섞어 쓰는 기존 문체가 있으므로 이번 수정도 이를 유지했다.

## 먼저 읽을 문서

- [`.documents/idea.md`](./idea.md): 원래 제품 아이디어와 참고 프로젝트
- [`.documents/blueprint.md`](./blueprint.md): 현재 제품·기술 blueprint와 구현 단계

## 참고 자료

- [commit-defender](https://github.com/pydemia/commit-defender)
- [GitHub App 권한 선택](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub App 자체 인증](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app)
- [GitHub REST API rate limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub REST API conditional request](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate)
- [GitHub GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
