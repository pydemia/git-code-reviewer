# PR 게시 직전 커밋 확인

관리 댓글을 생성하거나 갱신하기 직전에 GitHub에서 해당 PR을 다시 읽는다. PR 번호와 대상 저장소, 열린 상태, 분석의 전체 head SHA가 일치해야 한다. 저장된 댓글 ID 갱신과 marker 복구 모두 같은 검증을 거치고 PATCH 404 이후 복구할 때도 다시 조회한다. 조회에는 조건부 캐시를 사용하지 않으며 15초 제한을 둔다. 조회 실패·304·잘못된 응답은 게시 허용으로 처리하지 않는다.

원격 head가 바뀌거나 PR이 닫혔으면 해당 게시 건을 `disabled`로 남기고 `GITHUB_REVIEW_HEAD_CHANGED` 또는 `GITHUB_REVIEW_PULL_CLOSED`를 기록한다. 저장소 게시 설정 자체를 끄지는 않는다. 이후 새 분석은 기존 댓글 ID를 유지하며 새 게시 대상으로 등록된다. 원격 조회 이후에는 DB에서도 게시 대상, 저장소·instance 활성 상태, 삭제 여부, 선택한 credential·원격 저장소와 PR head를 재확인한다. 대상이 바뀌면 오래된 job은 새 게시 건을 덮거나 비활성화하지 않는다.

관리 댓글 검색이 20페이지를 초과하면 전체 검색을 완료하지 못한 것으로 처리하고 새 댓글을 만들지 않는다. 저장된 댓글 ID는 양의 안전한 정수만 허용한다. 최신 분석 재게시 선택은 개인 분석을 제외하고 현재 PR head의 최신 공용 보고서를 고른다. DB에서 이미 닫힌 PR은 게시 queue에 넣지 않는다.

[GitHub PR 조회 API](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)의 head를 확인한 뒤 [issue comment 갱신 API](https://docs.github.com/en/rest/issues/comments#update-an-issue-comment)를 호출한다. 후자의 요청 매개변수에는 PR head와의 원자적 비교 조건이 없다. 따라서 마지막 조회와 쓰기 사이의 변경 가능성은 남는다. 이 검증은 그 시간 간격을 줄이며 원격 쓰기를 atomic CAS로 만들지는 않는다.

검증에는 실제 publisher의 요청 순서, 캐시/시간 제한, 원격 head·닫힘·인가/일시 오류·잘못된 응답·다른 PR 거부, PATCH 404 복구 중 head 변경, DB의 최신 target 경쟁과 게시 설정 해제를 포함한다. 운영 이미지 검증은 소유한 합성 HTTP 서버를 사용하며 실제 외부 GitHub 댓글을 작성하지 않는다. 로컬 commit-defender와 중앙→로컬 전파 계약은 변경하지 않는다.
