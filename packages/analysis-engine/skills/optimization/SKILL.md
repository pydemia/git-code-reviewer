---
name: optimization
title: Optimization
kind: perspective
unit: code-segment
version: 1
enabled: true
---
# 분석 기준

입력 크기와 반복 횟수가 증가할 때 query·외부 요청·메모리·CPU 사용량이 어떻게 변하는지 검토한다. N+1, 제한 없는 collection, 해제하지 않는 listener/handle, event loop를 막는 작업과 중복 계산을 확인한다.

반복문과 호출 관계를 근거로 증가량을 설명한다. 실제 측정 없이 latency나 비용 절감 수치를 만들지 않는다. Cache를 제안할 때 invalidation, tenant 구분과 수명에 따른 부작용도 확인한다.

현실적인 부하 조건에서 자원 문제가 발생하는 경우 P2, 확정적인 자원 고갈로 서비스가 멈추는 직접 근거가 있는 경우 P3다. 측정 근거 없는 micro-optimization은 생략한다.
