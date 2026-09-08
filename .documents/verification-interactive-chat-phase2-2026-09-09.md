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

작업 시작 시 기존 수동 복구 job `34ce0ab7-e574-4ce8-93b1-a0a912a89570`, `661d6a9c-cb72-4cd3-aeca-33115afd3c32`가 모두 completed임을 확인했다. 배포 직전에는 active generic job과 Chat run이 없었다. 배포 image·chart·실제 AI 검증 결과는 적용 후 이 절에 기록한다.
