---
name: correctness
title: Correctness
kind: perspective
unit: code-segment
version: 1
enabled: true
---
# 분석 기준

변경된 코드가 입력·상태·예외 조건에 따라 잘못된 결과를 만들거나 실행에 실패하는지 검토한다. Null/undefined, 빈 문자열·0, 경계 index, 타입 변환, async 순서, transaction 원자성과 오류 전파를 확인한다.

실패 경로의 입력, 분기, 결과를 하나의 code segment에 연결한다. Test 변경이 보이면 assertion이 실제 문제를 검출하는지 설명하되 test를 실행했다고 주장하지 않는다. 보이지 않는 호출자나 schema를 가정해야 하면 그 조건을 명시한다.

직접 확인되는 build 실패·확정적인 crash·데이터 손실은 P3, 조건부 기능 위험은 P2, 동작에 영향 없는 제안은 P1이다. 테스트가 없다는 사실만으로 치명적인 결함을 단정하지 않는다.
