# 프로젝트 개요
enterprise, private github에서 하나의 git pull request가 open되었을 때, code reviewer가 그 git pull request에 대해 검토하고, 분석하는 작업을 도와 주어 빠르고 안전하게 merge를 수행하도록 지원하는 agent system 구축

# 주요 기능

## User Interface

* 핵심 Interface
  * interactive chat interface: a git pull request에 대한 code reviewer와의 질의/응답
* 부가 Interface
  * Branch: Git Branch Graph 시각화
  * Diff View: 코드 변경 전/후 Split view
  * Folded History : 파일 변경내용 Accordion & Timeline 표기
  * File Tree: Module 및 File 구조를 Sidebar Panel에 Tree 구조로 표기

## Git 분석
* a git pull request에 대한 코드 분석 제공: branch comparison
  * a git pull request의 base와 compare에 대한 기존 코드(base)와, 새 코드(compare)의 diff 및 변경 영향도 분석 및 요약
  * a git pull request의 새 코드(compare)를 이루는 각 세부 commit에 대한 diff 및 변경 영향도 분석 및 요약
* git log: 다른 git pull request history와의 비교: commit 또는 다른 pull request 단위의 file history 비교 분석
* git blame: git ownership 분석: pull request 요청자, commit 작업자, code line별 작업자에 대한 정보
* git show: git commit의 각 metadata와 내용 분석
* git graph: git branch 분리/병합 구조 시각화
* git bisect: bug commit 탐색

## Code 분석
* Object Inspection & Churn: code, 내부 구현체 분석, 변경 내용 및 영향도 분석
  * File History: 파일 변경내용 분석
  * Module History: 모듈 변경내용 분석
  * Line History
  * Function History
  * Class History 


# 참고할 내용

https://github.com/pydemia/commit-defender
* 중요도 및 영향도: code 분석 결과 Priority levels
* Skip 여부: Inline skip directives
* 출력 Richness
