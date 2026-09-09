---
name: overall-summary
title: Overall Summary
kind: form
unit: file
version: 2
enabled: true
---

# 파일별 Overall Summary

한 파일의 확정된 unit-comment-block과 제공된 coverage를 종합한다. 다른 파일의 문제를 섞거나 새로운 finding·line comment를 만들지 않는다. 변경 목적과 동작은 입력으로 확인할 수 있는 범위에서만 설명한다.

## 작성 형식

- 첫 문장에는 이 파일에서 검토자가 먼저 알아야 할 결론을 짧게 적는다.
- 서로 독립적인 검토 의견이 여러 개라면 Markdown bullet list로 나눈다. 한 항목에는 하나의 논점만 담고, **짧은 주제** 뒤에 발생 조건·영향·필요한 조치를 간결하게 연결한다.
- 우선 수정할 위험부터 배치한다. 순서가 실제로 필요한 조치만 numbered list로 쓰고, 긴 설명이 필요하면 해당 항목 아래에 짧은 문단이나 한 단계의 하위 목록을 둔다.
- 목록 앞뒤에는 빈 줄을 넣는다. 코드 식별자·API·전문용어는 영어로 유지하며 코드 식별자는 backtick으로 감싼다. 모든 문장을 목록으로 만들거나 항목 수를 채우려고 내용을 반복하지 않는다.
- 상세 comment-block의 본문을 그대로 복사하지 않는다. 같은 원인의 의견은 요약에서 묶되 원래 unit의 구분·priority·조건은 바꾸지 않는다. 파일 경로·판정·통계는 화면이 별도로 표시하므로 요약 안에서 반복하지 않는다.

## 판단과 제한

대표 priority는 해당 파일 unit의 최고 값이다. 문제를 언급할 때는 연결되는 unit이 있어야 한다. P0 Praise는 근거 있는 칭찬이며 문제 지적의 label로 사용하지 않는다.

검토 범위를 모두 확인했고 지적할 unit이 없다면 `검토한 변경 범위에서 문제가 발견되지 않았습니다.` 한 문장만 쓴다. 분석 실패·일부 window 생략·미검토 상태에서는 확인하지 못한 범위나 원인을 짧게 알리고 안전 판정으로 바꾸지 않는다.

출력은 기존 JSON contract를 따른다. `summary` 문자열 안에 Markdown과 줄바꿈을 담고 `file_comments`는 빈 배열로 유지한다. JSON 바깥에 report나 code fence를 덧붙이지 않는다.
