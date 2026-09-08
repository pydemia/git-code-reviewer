---
name: correctness
title: Correctness
kind: perspective
unit: code-segment
version: 2
enabled: true
---

# Correctness

잘못된 결과나 crash를 일으킬 수 있는 logic error와 runtime failure를 검토한다.

## 점검 항목

- **Test coverage**: 검증하지 않은 branch, 빠진 edge-case test, 잘못된 코드에서도 실패하지 않는 assertion을 확인한다.
- **Type safety**: type mismatch, unsafe cast, public API의 누락된 type annotation을 확인한다.
- **Null / undefined / None safety**: guard 없는 역참조, boolean이 아닌 값에 대한 암묵적 falsy 검사, method 호출 전 누락된 null 검사를 확인한다.
- **Empty-string and zero handling**: 빈 입력을 그대로 받아들여 오해를 부르는 결과를 반환하는 함수를 확인한다. 빈 문자열과 0을 유효한 값으로 처리해야 하는지도 살핀다.
- **Off-by-one errors**: loop, slice index, pagination offset의 경계를 한 칸 잘못 계산하는 fence-post error를 확인한다.
- **Syntax and semantic validity**: unreachable code, dead branch, 잘못된 operator precedence와 loop variable scope를 확인한다.
- **Data integrity**: 잘못된 default value, mutable default(예: Python의 `def f(x=[]):`), shared state mutation을 확인한다.
- **Error propagation**: 삼켜 버린 exception, 무시한 return code, 누락된 error handling 경로를 확인한다.

## 판단 어조 (Tone)

운영 환경에서 오류를 알리지 않은 채 잘못된 결과를 반환하거나 crash를 일으킬 수 있는 Correctness 문제는 must-fix로 표시한다. Test coverage와 type 검증의 빈틈은 명백히 위험한 경우가 아니라면 suggestion으로 제시한다.

## git-code-reviewer 적용 기준

실패 경로의 입력, 분기, 결과를 하나의 code segment에 연결한다. Test 변경이 보이면 assertion이 실제 문제를 검출하는지 설명하되 test를 실행했다고 주장하지 않는다. 보이지 않는 호출자나 schema를 가정해야 하면 그 조건을 명시한다.

직접 확인되는 build 실패·확정적인 crash·데이터 손실은 P3, 조건부 기능 위험은 P2, 동작에 영향 없는 제안은 P1이다. 테스트가 없다는 사실만으로 치명적인 결함을 단정하지 않는다.

## 출처

Commit Defender의 Correctness SKILL.md를 한국어로 번역하고 위 적용 기준을 추가했다. 원문과 Apache-2.0 license 정보는 `../THIRD_PARTY_NOTICES.md`를 참조한다.
