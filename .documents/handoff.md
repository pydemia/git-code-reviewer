# Git Code Reviewer — Session Handoff

## 이어서 할 작업

`idea.md`를 바탕으로 작성한 architecture blueprint를 사내 네트워크 제약에 맞게 수정한다. 현재 blueprint는 GitHub webhook ingress를 기본 경로로 기술했지만, 실제 환경에서는 외부에서 사내망으로 들어오는 inbound 연결이 보안 정책상 제한될 수 있다. 다음 session에서는 outbound-only 구조를 기본안으로 확정할지 사용자에게 확인하고, 확정되면 blueprint 전반의 관련 항목을 일관되게 바꾼다.

## 먼저 읽을 문서

- [`.documents/idea.md`](./idea.md): 원래 제품 아이디어와 참고 프로젝트
- [`.documents/blueprint.md`](./blueprint.md): 현재 작성된 제품·기술 blueprint

기존 문서에 이미 있는 요구사항, contract, 단계별 구현 계획은 이 문서에 반복하지 않았다.

## 현재 상태

- branch: `main`
- `.documents/idea.md`: 사용자가 추가한 참고 프로젝트 내용이 아직 commit되지 않음
- `.documents/blueprint.md`: 이번 session에서 새로 작성했으며 아직 untracked 상태
- `.documents/handoff.md`: 다른 computer에서 작업을 이어가기 위해 추가
- commit과 push는 수행하지 않음

예상 `git status --short`:

```text
 M .documents/idea.md
?? .documents/blueprint.md
?? .documents/handoff.md
```

## 확인된 환경 제약

- 대상은 enterprise private GitHub이다.
- 사내 대표 IP를 거치지 않는 GitHub 접근은 허용되지 않는다.
- GitHub에서 사내 service로 시작하는 inbound webhook 연결은 보안 정책 제한을 받을 수 있다.
- public SaaS에 source code와 분석 system을 배치하는 구조는 현재 요구와 맞지 않는다.
- GitHub API, GraphQL, Git fetch, Check/comment 게시를 사내 대표 IP를 통한 outbound HTTPS로 수행하는 것은 가능한 후보 구조다.

GitHub Enterprise Cloud인지 사내 GHES인지, 허용되는 outbound endpoint와 repository 규모는 아직 확인하지 않았다.

## 제안된 배포 구조

현재 대화에서 가장 적합한 기본안으로 제안한 것은 **사내 중앙 web application + outbound PR poller**다.

```text
GitHub Cloud / GHES
        ▲
        │ outbound HTTPS only: API · GraphQL · Git
        │
PR Poller / Snapshot Collector / Check Publisher
        │
        ▼
Queue → Analysis Worker → PostgreSQL / Object Storage / Model Gateway
        ▲
        │ 사내망 또는 VPN
Reviewer Browser → Web/API
```

이 구조에서는 GitHub가 사내 endpoint에 요청하지 않는다. 사내 poller가 등록된 repository의 open PR을 조회하고 `base SHA`, `head SHA`, `updated_at` 또는 cursor 변화를 감지해 분석 작업을 생성한다. reviewer가 PR 화면을 열면 해당 PR을 즉시 조회하고, background polling은 활성도와 API quota에 따라 주기를 조절한다. 분석 결과를 GitHub Check나 review comment로 게시하는 동작도 outbound 요청이다.

실제 application 실행 위치에 대해서는 다음과 같이 설명했다.

- 기본안: 사내 VM 또는 Kubernetes에 `web`, `api`, `worker`, database를 배포한다. 사용자는 browser로 접근한다.
- public remote SaaS는 사용하지 않는다.
- 각 사용자 PC에서 실행하는 local-first app은 PoC 또는 code를 중앙 서버에도 저장할 수 없는 경우의 대안이다.
- local-first는 PC가 꺼지면 분석이 중단되고 공용 report, audit, 조직 정책 적용이 어려우므로 enterprise 기본안으로 권장하지 않았다.
- code를 중앙에 둘 수 없으면서 결과 공유가 필요하면 중앙 control plane과 pull-based local runner를 조합할 수 있지만 운영 복잡도가 높다.

이 구조는 아직 사용자가 명시적으로 확정하지 않았고, 현재 `.documents/blueprint.md`에도 반영되지 않았다.

## Blueprint에서 수정할 부분

outbound polling 구조가 확정되면 최소한 다음 부분을 함께 수정해야 한다.

- `2.2 MVP 범위`: webhook event 기반 실행을 polling과 user-triggered refresh로 교체
- `4.2 주요 흐름`: webhook delivery 대신 repository cursor와 head SHA 변경 감지로 시작
- `5. 시스템 구성`: Webhook Ingress를 PR Poller/Scheduler로 교체하고 inbound가 없음을 표시
- `5.1 기준 기술 스택`: polling scheduler, API quota 제어, leader election 요구 추가
- `6.1 GitHub Adapter`: webhook HMAC/delivery 항목을 제거하거나 optional mode로 내림
- `6.2 Snapshot Collector`: poll cursor, conditional request, active/idle polling 정책 추가
- `6.6 Report Publisher`: Check/comment가 outbound-only임을 명시
- `10. API와 event`: `/webhooks/github`와 `github.delivery.accepted`를 기본 contract에서 제거하고 poll event로 교체
- `13. 보안과 privacy`: 대표 egress IP, outbound allowlist, DNS/TLS, no-inbound network policy 추가
- `14. 신뢰성, 성능, 비용 목표`: webhook 응답 목표를 detection lag, API quota, poll recovery 목표로 교체
- `16. Phase 0`: webhook idempotency 대신 poll cursor와 동일 snapshot dedupe 검증
- `17. Test 전략`: rate limit, cursor loss, scheduler restart, concurrent poller, delayed detection 추가
- `18. 주요 위험`: GitHub rate limit과 탐지 지연 대응 구체화

Webhook은 완전히 삭제하기보다 배포 mode를 `polling` 기본값, `internal-webhook` 또는 `dmz-relay` 선택값으로 남길지 결정할 수 있다. 현재 보안 제약만 보면 문서의 기준 구현은 `polling`이 적절하다.

## Polling 설계에서 결정할 항목

- GitHub Enterprise Cloud 또는 GHES와 정확한 version
- 설치 대상 repository와 organization 수
- open PR 수와 허용 가능한 변경 탐지 지연
- GitHub App installation token을 사용할지 별도 사내 credential broker를 사용할지
- GraphQL batching과 REST conditional request의 역할 분담
- active PR, draft PR, idle repository의 polling interval
- scheduler 단일 실행을 보장하는 lease 또는 leader election 방식
- API rate-limit 임계값에서 수동 분석과 자동 polling 중 무엇을 우선할지
- 중앙 service가 bare mirror, diff artifact, chat을 보존할 수 있는지
- approved model endpoint가 사내망에 있는지, 별도 outbound 연결이 필요한지

## Codex session 이전에 관한 결정

Git repository clone만으로 현재 Codex 대화 thread가 다른 computer에서 자동 재개되지는 않는다. `codex resume`은 저장된 session ID 또는 session picker를 대상으로 하며 repository 문서를 session으로 import하는 기능이 아니다.

`~/.codex`, `$CODEX_HOME`, session database 또는 raw JSONL을 Git에 올리지 않는다. 인증 정보, 다른 repository의 기록, absolute path, command output이 섞일 수 있다. 이 handoff처럼 필요한 결정과 작업 상태만 정리해 commit한다.

다른 computer에서는 repository를 clone한 뒤 새 Codex session에서 다음과 같이 시작한다.

```text
Read .documents/idea.md, .documents/blueprint.md, and .documents/handoff.md.
Confirm the outbound-only deployment choice, then revise the blueprint consistently.
Preserve existing user changes and do not commit or push without explicit approval.
```

## 참고 자료

- [commit-defender](https://github.com/pydemia/commit-defender)
- [GitHub App IP allow list](https://docs.github.com/en/enterprise-cloud@latest/apps/maintaining-github-apps/managing-allowed-ip-addresses-for-a-github-app)
- [GitHub App webhook 설정](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
- [Codex developer commands와 `resume`](https://learn.chatgpt.com/docs/developer-commands?surface=cli)

## Suggested skills

- `openai-docs`: 다음 session에서 Codex session, remote app-server, cloud handoff 등 Codex 제품 동작을 추가로 확인할 때 사용
- 현재 blueprint의 Markdown architecture 수정 자체에는 필수 skill이 없음
