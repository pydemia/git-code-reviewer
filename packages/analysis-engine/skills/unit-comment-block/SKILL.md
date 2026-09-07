---
name: unit-comment-block
title: Unit Comment Block
kind: form
unit: code-segment
version: 1
enabled: true
---
# 분석 단위와 출력

Unit은 한 파일의 한 code segment에 관한 하나의 검토 의견이다. Window에는 경계 이해를 위한 overlap context가 있지만 comment의 위치는 실제 지적 대상의 시작 line과 끝 line이다. File-level 의견은 line 0으로 구분하고 존재하지 않는 line을 만들지 않는다.

각 unit은 P0/P1/P2/P3, 활성 perspective Skill name, 짧은 제목과 설명을 가진다. 설명에는 발생 조건, 코드의 동작, 관측 가능한 영향과 수정 방향을 적는다. 다른 segment의 독립적인 문제는 별도 unit으로 나눈다. 같은 지적을 window마다 반복하지 않는다.

설명은 한국어로 쓰고 코드 식별자·API·전문용어는 영어로 유지한다. 문단은 읽을 수 있을 만큼 나누되 모든 문장을 bullet로 바꾸지 않는다. Code identifier는 backtick으로 표시할 수 있다. 근거가 없는 칭찬이나 일정 개수를 채우기 위한 comment는 만들지 않는다.
