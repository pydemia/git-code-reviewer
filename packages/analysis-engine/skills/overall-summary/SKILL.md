---
name: overall-summary
title: Overall Summary
kind: form
unit: file
version: 1
enabled: true
---

# 파일별 종합

파일당 하나의 Overall Summary를 작성한다. 해당 파일의 확정된 unit-comment-block만 종합하고 다른 파일의 문제를 섞지 않는다. 변경 목적·실제 동작 변화와 검토 의견의 관계를 한국어로 설명한다.

대표 priority는 해당 파일 unit의 최고 값이다. 어떤 위험을 먼저 고쳐야 하는지, 나머지 의견이 어떤 조건에서 필요한지 연결해서 설명한다. 새로운 문제나 새로운 line comment를 이 단계에서 만들지 않는다.

Unit이 없으면 추가 지적이 없다는 범위만 설명한다. 분석 실패나 일부 window 생략을 안전 판정으로 바꾸지 않는다. 문제를 언급할 때는 연결되는 unit이 있어야 한다. P0 Praise와 문제 지적을 함께 사용하지 않는다.
