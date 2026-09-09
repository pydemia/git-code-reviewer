---
name: unit-comment-block
title: Unit Comment Block
kind: form
unit: code-segment
version: 2
enabled: true
---

# 분석 단위와 출력

Unit은 한 파일의 한 code segment에 관한 하나의 검토 의견이다. Window에는 경계 이해를 위한 overlap context가 있지만 comment의 위치는 실제 지적 대상의 시작 line과 끝 line이다. File-level 의견은 line 0으로 구분하고 존재하지 않는 line을 만들지 않는다.

각 unit은 P0/P1/P2/P3, 활성 perspective Skill name, 짧은 제목과 설명을 가진다. 설명에는 발생 조건, 코드의 동작, 관측 가능한 영향과 수정 방향을 적는다. 다른 segment의 독립적인 문제는 별도 unit으로 나눈다. 같은 지적을 window마다 반복하지 않는다.

## 작성 형식

- 제목은 문제나 관찰을 한 문장으로 특정한다. 설명 첫 부분은 결론을 짧게 적는다.
- 여러 조건·영향·조치를 요약할 때는 Markdown Header와 List를 사용해 개조식으로 작성한다. 한 항목에 하나의 논점만 담으며 실제 순서가 있는 조치만 numbered list로 쓴다. 제목과 목록 앞뒤에는 빈 줄을 둔다.
- 코드의 실행 흐름·발생 원인·예외·trade-off는 필요한 만큼 문단으로 설명한다. 모든 문장을 bullet로 바꾸지 않으며 간결함을 위해 근거나 위험 조건을 생략하지 않는다.
- `comment`, `impact`, `recommendation`에 같은 내용을 반복하지 않는다. 화면이 이미 ‘영향’·‘수정 제안’ 제목을 붙이므로 각 필드에 동일한 제목을 다시 넣지 않는다. 별도 논점을 구분해야 할 때만 소제목을 쓴다.
- 한국어 설명과 영어 코드 식별자·API·전문용어를 유지한다. Code identifier는 backtick으로 표시한다. 근거가 없는 칭찬이나 일정 개수를 채우기 위한 comment는 만들지 않는다.

Markdown은 기존 JSON contract의 문자열 필드 안에만 넣는다. 다른 segment의 문제를 하나의 comment로 합치거나 priority·line·근거 계약을 바꾸지 않는다.
