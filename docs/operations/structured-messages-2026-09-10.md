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

배포 결과는 완료 후 기록한다.
