# Interactive Review Chat 2차 검증

P6–P10의 변경 범위는 [구현 문서](interactive-review-chat-phase2.md), 운영 제한은 [운영 가이드](../docs/operations/interactive-chat.md)에 기록한다.

## 로컬 검증

- PostgreSQL 17 UTF-8 전용 container, loopback port 25435에서 66개 파일·405개 테스트를 실행했다. 운영 DB를 테스트 fixture로 사용하지 않았다.
- Report 저장 트랜잭션 실패 후 같은 분석을 재개할 때 unit·파일 요약·전체 요약의 upstream mock 호출이 증가하지 않는다. 기존 pinned Skill·severity·report 검증을 유지했다.
- 만료 lease 동시 회수, 최대 3회 복구 후 실패 확정, 이전 attempt의 checkpoint 거부, 늦은 모델 응답 거부를 검증했다. Drain/lease-loss를 partial report로 바꾸지 않는다.
- 두 workspace lease 중 하나가 남으면 오래된 mtime에도 캐시를 삭제하지 않는다. 만료 lease 갱신 거부·준비 실패 rollback·전체 용량 admission을 검증했다.
- 400개 메시지의 원문 ID·role·생략 문자 수와 최근 발췌를 보존한다. Tool 본문 압축 후에도 call/result 연결과 SHA·source ID를 유지한다.
- JS/TS 구문 AST·Python lexical 후보의 정의/호출자/피호출자/테스트 구분과 comment/string 제외, 실제 Git blob·macOS sandbox 읽기를 검증했다.
- History 30건 pagination, 과거 질문 응답과 exact source 읽기, 다른 사용자 접근 거부를 실제 Fastify handler·DB에서 검증했다. UI는 SSR로 과거 질문의 읽기 전용 표시를 검증했다.
- TypeScript·ESLint·production build, Helm lint, Compose와 개발 Compose config를 검증한다. Vite의 기존 500 kB chunk 경고는 남긴다.

Impeccable detector의 경고는 기존 질문 카드의 `border-left` 1건이다. 관련 없는 색상·배치 변경은 하지 않았다. Mac 잠금으로 실제 브라우저 desktop/mobile 조작과 캡처는 미수행이며 SSR·backend 테스트로 대체 완료했다고 판단하지 않는다.

## 운영 적용

작업 시작 시 기존 수동 복구 job `34ce0ab7-e574-4ce8-93b1-a0a912a89570`, `661d6a9c-cb72-4cd3-aeca-33115afd3c32`가 모두 completed임을 확인했다. 배포 직전 running generic job과 Chat run은 모두 0건이었다.

2026-09-09 07:12:40 KST에 application `0.8.0-alpha.23`, chart `0.10.22`를 PRISM-DEV Helm revision **34**로 배포했다. Source `143ba2ff09abc5fc6247233d742d8b1aae924540`를 push 후 git archive에서 빌드했고 image pin은 `1aeae2d`다.

- Image index: `sha256:52d8344b8255d591c9f5853843bc81bf620120a4ee4e5707bd205c1424637641`
- Linux/amd64: `sha256:08aa02d1504c0ceed091eb2625bf7fb45d39d92d4a1678b50bf4f497c88a62c3`
- OCI chart: `sha256:c2cbc4b038b8c2ba32a199cc0cd51311cd61f91925e43626d2a86494b93711b8`
- 게시된 attestation에서 SPDX와 SLSA provenance v1을 확인했다.

Native PRISM-DEV에서 UID 65534, Secret 부재, 쓰기·경로 이탈·process·network 차단, Git blob 읽기와 TypeScript AST 탐색을 통과했다. 신규 검증 스크립트의 `copyfile`은 Kernel/overlay 경로에서 EPERM이 발생해 테스트 파일 복사만 readFile/writeFile로 변경했다. 배포 broker는 기존 streaming copy를 사용하므로 이 후속 테스트 스크립트 변경은 image 재빌드 대상이 아니다.

Server 1/1·Worker 2/2 Ready, restart 0회, health 4종 HTTP 200, system alpha.23, 비로그인 history API 401, 07:14:09 Helm test 성공과 migration 28개 checksum을 확인했다. 제공 중인 JS hash `d2247e117beabf53c8d27ba32f53df71ce1a22bde8d7a1a68ec0226d2c6de080`이 로컬 production bundle과 같다. Image를 제외한 Helm values hash, auth/registry/PostgreSQL Secret UID·resourceVersion, PVC/PV identity를 유지했다.

## 실제 AI 후속 대화

기존 검증 session `18d463e7-c6d6-4099-b213-afdd52743ee0`에서 새 run `68115d81-e856-4963-bfa9-7d22ad813348`을 실행했다. 운영 Server의 실제 Fastify handler와 배포 Worker, 기존에 허용된 `gpt-5.6-sol:medium` 계정을 사용했다. 네트워크 인증을 우회하는 endpoint나 새 cookie는 만들지 않았다. 로그인 HTTP E2E와는 별도 검증이다.

07:13:44.897–07:16:27.970 KST, **163초** 후 completed·error null로 끝났다. 모델 8회가 모두 completed·usage 기록을 남겼고 read-only 도구는 6회였다. 4,687자 답변, source citation, 실제 persisted delta 211건을 확인했다.

1. `read_conversation`으로 이전 사용자 질문을 다시 읽었다.
2. `read_previous_source`로 이전 run의 저장된 소스를 읽었다.
3. `find_related_code`, `read_file`로 현행 고정 revision을 조회했다.
4. `ask_user` 질문에 응답하고 같은 run을 재개했다.
5. 두 번째 workspace 준비는 `고정 revision 작업공간 재사용`으로 기록됐다. 이후 base 원문과 `search_code`를 조회했다.
6. History API에서 이전 run을 계속 조회했고 base/head 근거 2건의 SHA와 SHA-256 본문 hash가 일치했다. 완료 후 활성 workspace lease는 0건이었다.

근거 파일은 `data-management/mainapp/domains/position_management/position/models.py` 1–65행이며 base `aebc554766ea11e022caa557773d3b5651aa59af`, head `9f7a7d14396be6da6bb01d874fb9cfe2c850140d`다. 기존 canonical report와 GitHub PR 게시, 개인·집단 메모리는 변경하지 않았다. 이번 검증은 전체 의미적 호출 graph나 테스트 실행을 입증하지 않는다.

## 정리와 남은 검증

임시 kernel probe Pod와 전용 PostgreSQL container, 임시 Helm registry 인증 파일을 정리했다. 기존 Docker credential 설정은 변경하지 않았다. 구버전 Pod `git-code-reviewer-worker-f67ff8948-nzx85`의 Worker 본체는 더 이상 exec할 수 없고 해당 owner의 활성 job/Chat lease는 0건이었다. 이전 source-sandbox가 최초 3600초 종료 유예 중 Terminating으로 남았다. 유예 축소와 container 내부 종료 신호 뒤에도 90초 삭제 대기가 만료되어 완전 삭제를 확인하지 못했다. API object만 강제 삭제해 실제 프로세스 종료로 간주하지 않았다. 새 Worker의 실제 AI 완료와는 별개인 정리 항목이다. alpha.23 broker에는 SIGTERM 처리와 650초 drain을 추가했다.

Mac 잠금으로 실제 desktop/mobile UI 조작과 캡처도 남아 있다. 로그인 HTTP E2E, 실제 운영 배치의 강제 Worker 교체 재현은 이번에 수행하지 않았고 DB 통합 테스트의 복구 시나리오와 구분한다.
