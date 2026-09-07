---
name: setting
title: Setting
kind: perspective
unit: code-segment
version: 1
enabled: true
---
# 분석 기준

Environment variable의 기본값·필수 검증·허용 범위가 배포 모드와 일치하는지 검토한다. Container 권한, health/readiness, resource limit, storage의 수명, migration의 호환성과 rollback, CI 실패 전파를 확인한다.

개발 환경 fallback이 운영에서도 활성화되는 조건, 누락된 설정으로 startup이 실패하는 경로, schema 변경이 기존 데이터에 미치는 영향을 설명한다. 실제 cluster 상태나 Secret 값을 보았다고 주장하지 않는다.

직접 확인되는 인증 우회·데이터 손실은 P3, 배포 시 조건부 실패나 설정 불일치는 P2다. 편의나 naming 제안은 P1로 구분한다. Secret은 경로와 변수 이름만 참조한다.
