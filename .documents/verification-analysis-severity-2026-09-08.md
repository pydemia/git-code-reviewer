# Skill 번역·Severity Level 검증

이 문서는 개발 단계의 검증 기록이다. 후속 요청으로 PRISM-DEV revision 23에 배포했으며 결과는 [배포 문서](../deploy/environments/prism-dev/README.md)에 기록했다.

2026-09-08, branch `feat/browser-review-service`. 실제 GHES·모델 API 호출, account/tenant 운영 설정 변경과 PRISM-DEV 배포는 수행하지 않았다.

## 자동 검증

- `pnpm exec vitest run`: 46 files, **256 tests 통과**, skip 없음. 전용 loopback PostgreSQL 17 container와 test별 임시 schema에서 migration/API/Worker integration까지 실행했다. 기존 다른 프로젝트 DB는 사용하지 않았다.
- `pnpm typecheck`, `pnpm lint`, `pnpm --filter @gcr/web build`, `git diff --check` 통과.
- Skill catalog 검증: perspective 6개·form 3개, perspective version 2, 원문 checklist 수(Review History 6개, 나머지 각 8개), Tone과 추가 적용 기준, bundle hash 검증.
- Severity 검증: 5개 level의 threshold, moderate P1 파일당 2개, 여러 window의 합산·중복 제거, 같은 근거가 P1/P3로 중복되면 P3 보존, 파일 요약 입력과 최종 unit 일치, 의도적 필터를 coverage 실패로 집계하지 않음.
- Prompt API 검증: 빈 지침으로 level 저장, CRLF 정규화, 같은 조합 재사용·다른 level hash 분리, 조회·활성화·기본값 복원, 구형 client의 moderate 기본값, invalid 입력·일반 사용자 차단, version 변경 거부.
- Worker integration: rigorous로 queue에 넣은 뒤 활성 설정을 lean으로 바꿔도 모든 stage는 pinned rigorous를 사용한다. 빈 지침의 Prompt version도 report에 기록된다. Migration 전 NULL binding의 legacy run에는 현재 level을 주입하지 않는다.

Web production output은 JS `index-CbB-AP4c.js` 640.92 kB(gzip 189.05 kB), CSS `index-CxGqHCXb.css`다. Zod dependency의 PURE annotation 경고와 500 kB 초과 chunk 경고가 있으나 build는 성공했다. 이번 작업에서 dependency upgrade·bundle 분할은 수행하지 않았다.

## Browser 검증

실제 `AdminPage`·`SeverityLevelField`와 앱 CSS를 local Vite에서 렌더링하고 admin API 응답만 합성했다. 로그인 권한 자체는 Browser 모의 응답이므로 서버 권한 검증 근거는 위 integration test다. 초기 fixture에 빠진 응답 envelope 필드(`enabled`, `nextCursor`)를 맞춘 뒤 UI를 검사했다.

- Moderate 기본 선택과 각 level의 한국어 설명·priority 범위를 확인했다.
- 추가 지침을 비운 채 rigorous 선택 → 저장 후 request body의 `severityLevel: rigorous`, `instructions: ""`와 활성 history를 확인했다.
- Tenant A → B 전환에 1.5초 모의 지연을 주었을 때 radio와 저장 버튼이 잠긴다. 응답 후 B는 moderate로 표시되고 A의 저장값은 유지된다. A로 돌아와 rigorous를 복원한 뒤 ArrowUp으로 moderate를 선택하는 native keyboard 동작을 확인했다.
- 1440px desktop과 390px mobile에서 확인했다. Mobile의 body scrollWidth는 390px, field 너비는 338px이며 모든 설명이 줄바꿈되고 가로 overflow는 없다. Error event 0건, Vite overlay 없음.

합성 화면: [Desktop](verification-assets/analysis-severity-2026-09-08/desktop.png), [Mobile](verification-assets/analysis-severity-2026-09-08/mobile.png). Screenshot은 해당 section으로 scroll한 상태다. Browser 검증은 실제 LLM의 분석 품질이나 GHES 게시 성공을 증명하지 않는다.

Impeccable 기준은 기존 관리자 UI token·native control·설명 노출·좁은 화면의 줄바꿈에 적용했다. Detector는 새 control에서 경고가 없었고 기존 CSS의 side border 4건만 보고했다. 기존 선택/상태 표현이라 이번 범위에서 수정하지 않았다. React 점검은 비동기 응답 취소·tenant 데이터 일치 확인, 제어된 radio, label/legend와 저장 중 control 상태를 확인했다.

검증용 Browser·Vite를 종료하고 일회성 harness 파일을 제거했다. PostgreSQL test schema는 test teardown에서 삭제한다. 전용 test container도 검증 후 제거하며, 합성 데이터 외 운영 데이터에는 접근하지 않는다.
