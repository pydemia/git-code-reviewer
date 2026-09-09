# Review Chat 진행 상태 표시

## 변경

현재 질문의 ‘조회 과정’은 기본으로 펼친다. Native details로 사용자의 접기 조작을 유지하며 같은 run의 event 갱신으로 다시 펼치지 않는다. 새 run ID에서는 펼침을 초기화한다. 저장된 이전 질문의 조회 과정은 기존처럼 접어서 표시한다.

`running` 상태에는 Thinking 글자 안에서 빛이 흐르는 CSS 효과를 적용한다. Queue·계정 호출 한도 대기·사용자 응답 대기·중단 중·완료·실패에는 각각 기존 상태 문구를 표시한다. 요청 접수 전에는 전송 중임을 즉시 알린다. 조회 과정을 접어도 Thinking과 중단 버튼은 남는다. 이 표시는 서버가 알려주는 실행 상태이며 모델의 내부 추론 내용을 나타내지는 않는다.

별도 animation dependency나 timer를 추가하지 않았다. 효과는 7글자 영역에 한정하며 `prefers-reduced-motion`·forced colors에서는 일반 글자로 표시한다. Screen reader에는 ‘답변 생성 중’이라는 status 이름을 제공한다. Impeccable의 gradient-text 검출 두 곳은 사용자가 요청한 진행 상태 shimmer에만 적용한 의도적인 예외이며 제목·본문에는 사용하지 않는다.

## 검증

- Frontend 22개 파일·94개 테스트, web typecheck, 전체 lint·production build 통과. 기존 Zod annotation·bundle size 경고는 유지된다.
- Desktop 1440×1000·Mobile 390×844 합성 Browser: 기본 펼침, 수동 접기 유지, 새 질문의 펼침 복원, running 중 background position 변화, 대기·완료·실패·중단 시 Thinking 제거를 확인했다.
- Reduced motion에서는 animation이 none이고 Thinking 글자와 상태 이름은 유지된다. 두 viewport에 가로 overflow와 alert·console 오류가 없다.
- `/tests/registry-chat.html?activity=1`은 실제 ChatPanel·ChatRunActivity를 사용하는 Vite 전용 합성 검증이다. 외부 모델·운영 대화는 호출하지 않으며 production bundle에는 포함하지 않는다.

배포 결과는 image build·push와 PRISM-DEV 적용 후 이 문서에 기록한다.
