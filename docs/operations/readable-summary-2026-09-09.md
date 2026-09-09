# Summary Skill과 PR 댓글 가독성

## 적용 범위

- Built-in `overall-summary`·`total-summary` form을 version 2로 올렸다. 짧은 결론 뒤에 독립적인 논점을 bullet list로 정리하고 실제 조치 순서가 있을 때만 numbered list를 사용한다. 파일별 comment·coverage를 근거로 하며 새로운 finding이나 priority를 만들지 않는다.
- Total Summary는 PR 전체 요약만 작성한다. 전체 report·AI Comments·파일 목록을 다시 생성하지 않는다. 검토가 완료됐고 지적할 내용이 없는 파일에는 짧은 완료 문장만 사용한다.
- PR publication은 `formatReviewMarkdown`의 `audience: pull-request`를 사용한다. PR 전체 요약, 검토 수·판정·분석 제한, comment가 있는 파일의 요약·comment-block, provenance와 전체 report 링크를 남긴다. 전체 파일 목록과 comment가 없는 파일별 요약은 생략한다.
- 긴 AI Comments는 기존처럼 하나의 details 안에 접는다. 파일 요약은 해당 comment 묶음 안에서 한 번만 표시한다. 앱·Markdown export의 전체 파일 목록과 Raw JSON은 유지한다.
- 문단·목록·강조·inline code는 제한적으로 복원한다. 소제목은 굵은 글자로 정리하며 HTML·임의 링크·mention은 escape한다. 길이 제한은 기존 block 단위 처리와 닫는 details 보존 규칙을 유지한다.

기존 report 원문과 이미 queue에 고정된 Skill bundle은 바꾸지 않는다. 관리자 custom Skill version을 자동으로 덮어쓰지 않는다. PRISM-DEV 사전 점검에서는 active custom version이 없어 Built-in을 사용 중이었다. 변경된 Skill은 배포 후 생성하는 새 분석부터, PR 댓글 구성은 다음 정상 게시·갱신부터 적용된다. 기존 PR 댓글을 검증 목적으로 일괄 수정하지 않는다.

Built-in bundle SHA-256은 `1f82188dfc8f859b220087784ce08a90e4e01c8ab15bcf303c52ddb87a6a6a6c`다. 다른 perspective와 unit-comment-block의 내용·version은 유지했다.

## 검증

- 격리된 PostgreSQL 17 UTF-8 환경에서 76개 파일·469개 테스트 통과. Skill version·hash, pinned bundle, Worker의 canonical report 게시, comment가 없는 파일 생략, export의 전체 파일 보존과 immutable report를 확인했다.
- 전체 lint·typecheck·production build 통과. 기존 Zod annotation·bundle size 경고는 유지된다.
- 합성 PR Markdown을 실제 CommonMark parser로 읽어 목록 3개·강조 10개·comment blockquote 1개를 확인했다. 생성한 report/finding 링크 두 개만 남았고 comment가 없는 파일과 Analyzed File List는 없었다. GitHub 서비스의 실제 렌더링 화면을 검증한 것은 아니다.
- HTML·link·mention·details injection, inline code escaping, 기본 접힘과 60,000자 게시 제한을 테스트했다. 실제 모델 호출·재분석·PR 댓글 게시를 검증 목적으로 실행하지 않았다.

배포 결과는 PRISM-DEV 적용 후 기록한다.
