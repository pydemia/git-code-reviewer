---
name: total-summary
title: Total Summary
kind: form
unit: analysis
version: 2
enabled: true
---

# PR 전체 Total Summary

제공된 파일별 Overall Summary·확정된 검토 의견·coverage를 바탕으로 PR 전체의 결론을 작성한다. 이 단계는 전체 report의 요약 부분만 만든다. 파일별 요약, AI Comments, 파일 목록과 provenance는 application이 구성하므로 여기에서 report 전체를 다시 작성하지 않는다.

## 작성 형식

- 첫 문장이나 짧은 첫 문단에 PR 전체에서 확인한 동작 변화와 가장 중요한 검토 결론을 적는다. 변경 목적을 입력에서 확인할 수 없다면 추정하지 않는다.
- 독립적인 위험·확인 사항은 Markdown bullet list로 구분한다. 각 항목은 **짧은 주제**와 영향·발생 조건 또는 필요한 조치로 구성하고 우선순위가 높은 내용부터 쓴다.
- 같은 원인이나 여러 파일에 걸친 같은 변경은 하나의 논점으로 묶는다. 파일 순서대로 나열하지 않으며, 파일 경로는 문제 위치를 이해하는 데 꼭 필요한 경우에만 inline code로 적는다.
- 내용이 길 때만 `검토 의견`, `확인하지 못한 범위` 같은 짧은 소제목을 사용한다. 제목과 목록 앞뒤에는 빈 줄을 넣고 하위 목록은 한 단계까지만 쓴다. 실제 조치 순서가 없다면 numbered list를 쓰지 않는다.
- 통계·판정 badge·파일 목록·전체 AI Comments를 요약 안에 중복해서 넣지 않는다. 전문용어와 코드 식별자는 영어로 유지하고 설명은 한국어로 작성한다. 항목 수를 맞추기 위한 반복이나 상투적인 마무리는 생략한다.

## 판단과 제한

파일별 요약과 AI Comments는 같은 확정 unit을 가리켜야 한다. 새로운 finding·근거·line 번호·칭찬을 만들지 않으며 기존 priority를 높이거나 낮추지 않는다. 대표 priority는 모든 unit의 최고 값이다.

P3가 있으면 차단이 필요한 이유를 유지한다. 분석이 빠짐없이 완료되고 P3가 없을 때의 PASS도 자동 merge 승인이나 모든 오류가 없다는 보증은 아니다. 실패·비활성·데모·생략·일부 검토는 안전으로 표현하지 않는다. 지적할 의견이 없고 검토가 완료됐다면 문제가 발견되지 않았다는 짧은 문장으로 끝내며, 확인하지 못한 범위가 있다면 그 제한을 별도로 짧게 알린다.

출력은 기존 JSON contract를 따른다. `summary` 문자열에 Markdown과 줄바꿈을 담고 `file_comments`는 빈 배열로 유지한다. JSON 바깥에 report나 code fence를 덧붙이지 않는다.
