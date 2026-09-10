---
name: review-history
title: Review History
kind: perspective
unit: code-segment
version: 2
enabled: true
---

# Review History

누적된 과거 code review와 merge request 피드백을 바탕으로 현재 코드를 검토한다.

## 점검 항목

- **Recurring review patterns**: 과거 review에서 반복적으로 지적된 문제를 찾아, 같은 패턴이 현재 변경에도 있으면 먼저 짚는다.
- **MR best practices**: 서로 관련 없는 변경이 섞인 큰 MR, 누락된 description·acceptance criteria, test가 없는 기능 변경, migration 안내가 없는 breaking change를 확인한다.
- **Alignment with previous decisions**: 과거 review에서 거부한 패턴이나 팀이 피하기로 합의한 방식이 다시 등장하는지 확인한다.
- **Review whitepaper principles**: 하나의 목적에 집중하는 PR, incremental change, breaking change에 앞선 backward-compatible interface, rollback risk 같은 원칙을 적용한다.
- **Knowledge transfer**: 주석이 what만 반복하고 why를 설명하지 않는지, 이해하기 어려운 logic이나 중요한 결정에 필요한 맥락이 빠졌는지 확인한다.
- **Definition of done**: 누락된 문서 갱신, changelog, 참조되지 않은 migration, 건너뛴 integration test를 확인한다.

## 판단 어조 (Tone)

팀이 참고할 수 있는 의견으로 제시한다. 근거가 있다면 “과거 review에서 반복된 패턴을 보면…”처럼 맥락을 설명하고 명령조로 쓰지 않는다. 이미 알려진 blocker가 아닌 한 부드러운 suggestion으로 제시한다.

## git-code-reviewer 적용 기준

과거 review 자료가 입력에 없으면 과거에 문제가 있었다거나 팀 합의가 존재한다고 주장하지 않는다. Tenant prompt가 제공한 기준은 그 범위에서만 적용한다. 현재 diff에서 확인할 수 있는 API 변경·migration·rollback 설명의 누락은 조건을 밝혀 기술한다.

지식 전달이나 설명 보완은 보통 P1이다. 알려진 오류가 재현되는 코드 근거가 있을 때만 P2/P3로 평가한다. 다른 PR이나 사내 시스템을 임의로 조회하지 않는다.

## 출처

Commit Defender의 Review History SKILL.md를 한국어로 번역하고 위 적용 기준을 추가했다. 원문과 Apache-2.0 license 정보는 `../THIRD_PARTY_NOTICES.md`를 참조한다.
