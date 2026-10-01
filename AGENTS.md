# 인증 정보 출력 방지

- Git 원격 URL, credential helper 결과, 배포 환경 설정을 조회할 때 원문을 터미널·도구 출력·작업 기록에 노출하지 않는다. 필요한 사실만 추출해 인증 정보를 제거한 형태로 보고한다.
- `git remote -v`, `git remote show`, `git config --list`처럼 URL이나 자격 증명을 그대로 출력할 수 있는 명령은 사용하지 않는다. 원격 연결 검사는 인증 정보가 없는 URL을 설정한 뒤 `git ls-remote` 등으로 수행한다.
- 토큰이 출력된 경우 값을 재인용하지 않고 사용자에게 노출 사실과 교체 필요성을 알린다.

# 프런트엔드 작업

- 재사용 가이드는 `agent-skills`의 `reference-led-frontend` 스킬과 `prompts/reference-led-frontend.md`에 저장한다. 설치된 경우 `$reference-led-frontend`를 적용하고 아래 프로젝트별 선호를 함께 따른다.
- UI/UX와 프런트엔드 기능을 개편할 때 `agent-skills`의 관련 스킬을 사용한다. 설계는 `product-ui-ux-design`, 마크업·레이아웃·접근성은 `web-publishing`, 컴포넌트·상태·API 연동은 `frontend-development`를 적용한다. 새로운 참고 자료 조사가 필요하면 `reference-research`를 사용한다.
- 로컬 `../agent-skills`의 해당 `SKILL.md`를 확인한다. 현재 checkout에 없는 스킬은 원격 추적 브랜치의 파일을 읽되 사용자의 checkout과 변경을 임의로 바꾸지 않는다.
- 실제로 확인한 제품 화면·컴포넌트와 기존 제품의 승인된 디자인을 근거로 설계한다. 사용한 reference와 어떤 구조·동작을 적용했는지 작업 기록에 남긴다.
- 배너·패널·박스를 반복 배치하는 획일적인 AI 생성 스타일을 기본값으로 삼지 않는다. 정보 관계와 사용 흐름에 필요한 컴포넌트만 사용한다.
- 코드 라인 코멘트의 수정 제안을 별도 박스로 구분하는 기존 디자인은 사용자가 선호한다. 이 표현은 유지·재사용하되 모든 본문을 박스로 나누는 방식으로 확대하지 않는다.
