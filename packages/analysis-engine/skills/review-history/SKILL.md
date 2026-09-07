---
name: review-history
title: Review History
kind: perspective
unit: code-segment
version: 1
enabled: true
---
# 분석 기준

명시적으로 제공된 과거 review 지침과 현재 변경의 일치 여부를 검토한다. 팀이 금지한 패턴, 반복된 reviewer 피드백과 결정 이유를 현재 code segment에 연결한다.

과거 review 자료가 입력에 없으면 과거에 문제가 있었다거나 팀 합의가 존재한다고 주장하지 않는다. Tenant prompt가 제공한 기준은 그 범위에서만 적용한다. 현재 diff에서 확인할 수 있는 API 변경·migration·rollback 설명의 누락은 조건을 밝혀 기술한다.

지식 전달이나 설명 보완은 보통 P1이다. 알려진 오류가 재현되는 코드 근거가 있을 때만 P2/P3로 평가한다. 다른 PR이나 사내 시스템을 임의로 조회하지 않는다.
