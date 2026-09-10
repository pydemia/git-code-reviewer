---
name: maintenance
title: Maintenance
kind: perspective
unit: code-segment
version: 2
enabled: true
---

# Maintenance

코드의 readability, consistency와 장기적인 maintainability를 검토한다.

## 점검 항목

- **Readability**: 지나치게 복잡한 expression, 깊게 중첩된 logic, 너무 많은 일을 하는 함수, 이름 있는 constant로 정의하지 않은 magic number를 확인한다.
- **Naming**: 의도가 드러나지 않는 variable·function·class 이름과 같은 module 안에서 일관되지 않은 naming style을 확인한다.
- **Code conventions**: formatting, line length, import ordering, spacing의 불일치와 프로젝트에 명시된 style guide에서 벗어난 부분을 확인한다.
- **Linting rules**: 활성화된 linter 설정(ruff, eslint 등)의 위반 여부를 살핀다. 개별 lint message를 반복하지 말고 공통된 패턴을 정리한다.
- **Comments and documentation**: public API의 누락된 docstring, 실제 코드와 모순되는 오래된 주석, 주석 처리한 채 남겨 둔 dead code를 확인한다.
- **Structure and organisation**: 잘못된 layer에 놓인 logic(예: view에서 DB 호출), circular import, 책임이 과도하게 집중된 God object·module, 다른 객체의 데이터에 지나치게 의존하는 feature envy를 확인한다.
- **Consistency**: 같은 작업을 서로 다른 패턴으로 구현한 부분과 shared helper로 분리해야 할 copy-paste 코드를 확인한다.
- **Refactoring opportunities**: 작은 구조 변경으로 코드가 훨씬 명확해지는 경우를 찾는다. 개선 효과가 충분히 큰 경우에만 제안한다.

## 판단 어조 (Tone)

Maintenance 문제는 원칙적으로 suggestion으로 제시한다. 다음 개발자가 코드를 잘못 이해하도록 만들 만큼 심각한 위반은 예외다. 활성화된 linter가 이미 처리하는 사소한 style 문제를 꼬집지 않는다.

## git-code-reviewer 적용 기준

어떤 후속 수정에서 어떤 오해나 중복 변경이 발생하는지 구체적으로 설명한다.

기존 프로젝트의 일관된 관례를 개인 취향으로 교체하지 않는다. Formatter로 해결되는 공백이나 단순한 문체 차이를 반복 지적하지 않는다. 제공된 linter 결과가 있으면 동일 원인의 패턴을 종합하되 실행하지 않은 linter 결과를 만들지 않는다.

읽기 편의만 바뀌는 제안은 P1이다. 유지보수 문제가 실제 오류 경로를 만들 때만 P2 이상으로 평가한다. P0는 같은 파일에 문제 지적이 없고 실제로 좋은 변경의 근거가 있을 때만 사용한다.

## 출처

Commit Defender의 Maintenance SKILL.md를 한국어로 번역하고 위 적용 기준을 추가했다. 원문과 Apache-2.0 license 정보는 `../THIRD_PARTY_NOTICES.md`를 참조한다.
