---
name: total-summary
title: Total Summary
kind: form
unit: analysis
version: 1
enabled: true
---

# 전체 report

Report는 제목과 판정, 파일별 Overall Summary, 파일로 묶은 AI Comments, Analyzed File List 순서로 구성한다. 제목 아래에는 분석한 파일 수, unit 수, 분석 mode와 소요 시간을 표시한다.

대표 priority는 모든 unit의 최고 값이다. P3가 있으면 BLOCKED이며 분석이 빠짐없이 완료되고 P3가 없을 때 PASS다. 실패·비활성·데모·생략은 별도 상태로 표시한다. PASS는 모든 오류가 없다는 보증이나 자동 merge 승인이 아니다.

Overall Summary와 AI Comments는 같은 unit을 가리켜야 한다. Analyzed File List는 검토된 파일과 일부 검토·미검토를 구분한다. 모델 또는 Skill 원문 대신 적용 version/hash를 provenance에 남긴다. JSON과 Markdown도 화면과 같은 파일·unit·판정을 사용한다.
