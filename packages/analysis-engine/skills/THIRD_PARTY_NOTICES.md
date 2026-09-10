# Commit Defender 번역 및 적용 안내

이 디렉터리의 `correctness`, `maintenance`, `optimization`, `review-history`, `security`, `setting` SKILL.md는 [pydemia/commit-defender](https://github.com/pydemia/commit-defender/tree/14203044e4e0cf2ba5d44fcf521425a4113f7840/.commit-defender)의 같은 이름의 파일을 한국어로 번역했다. 원문의 점검 항목과 Tone을 유지하고 git-code-reviewer의 frontmatter 및 근거·priority 적용 기준을 추가했다. 변경일: 2026-09-08.

Severity Level의 이름, 기본값과 필터 기준은 같은 revision의 `vscode-extension/src/ai/prompt.ts` 및 `reviewer.ts`를 참고해 적용했다. 원본 설정 화면의 설명과 실제 필터가 다른 경우 실행 코드를 기준으로 삼았다. 대상 코드의 TODO·skip 문자열을 지침으로 신뢰하는 동작은 이식하지 않았다.

원본은 Apache License 2.0으로 제공된다. License 전문은 [LICENSE.commit-defender](LICENSE.commit-defender)에 보관한다. Report form 세 개는 이 번역 대상에 포함하지 않는다.
