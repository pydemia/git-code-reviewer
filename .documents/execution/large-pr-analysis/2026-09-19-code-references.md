# #1024 계정 사용량 재확인과 코멘트 코드 참조

## 실제 사용 가능 상태

2026-09-19 15:27:43 KST에 #1024 분석에 고정된 등록 계정으로 `GET https://chatgpt.com/backend-api/wham/usage`를 조회했다. 계정의 quota identity가 기존 분석 HTTP ledger와 같은지 서버 메모리 안에서 대조했다. 현재 Codex 대화 계정의 사용량으로 대신 판단하지 않았고 credential을 Pod 밖으로 내보내지 않았다.

HTTP 200 응답은 `allowed=false`, `limit_reached=true`, 604,800초(주간) 창 `used_percent=100`, `rate_limit_reached_type=workspace_member_credits_depleted`였다. reset은 `2026-09-19T10:32:02Z`, 즉 **오늘 19:32:02 KST**다. 저장된 cooldown만 남은 상태가 아니라 현재 제공자도 사용 불가를 확인했다. 조회에는 생성 모델 호출이 없다.

조회 방법은 로컬 공식 Codex 소스 `codex-rs/backend-client/src/client.rs`의 `get_rate_limits_many`와 OpenAPI rate limit schema를 확인했다. 이 작업은 읽기 전용 운영 점검이며 새 계정 관리 기능을 추가하지 않는다. reset credit 사용, 결제 변경, 다른 계정·모델 대체, quota ledger 초기화는 수행하지 않는다.

128은 제공자의 주간 한도가 아니라 GCR의 실행당 호출 예산이다. PRISM-DEV의 `model.analysis.groupMaxModelCalls`를 **256**으로 올린다. 배포 기본값은 128을 유지한다. 기존 분석 동시 요청 2개, 대화 슬롯 1개, 모든 lane을 합산한 분석 admission 30회·512KiB/분, 전체 60회·1MiB/분, 실행 3시간 제한을 유지한다. 256으로 바꿔도 계정의 현재 사용량 제한은 해제되지 않는다.

계정 제한 중에는 기존 재개 API·버튼의 차단을 유지한다. 해제 후 현재 PR head와 권한이 유효하면 [#1024 보고서](https://pr-review.prism.ai/reviews/841560c1-98a2-417c-84f7-21a2d4330e93)의 `남은 검토 재개`로 최대 256회짜리 후속 revision을 시작할 수 있다. 완료된 92개 작업은 재사용한다. 남은 317개 경계 작업은 한 실행으로 모두 끝나지 않을 수 있다. 자동으로 다음 예산을 반복 승인하지 않는다.

## 코드 참조와 게시 문안

`reference-led-frontend` 및 agent-skills의 `product-ui-ux-design`, `web-publishing`, `frontend-development`를 적용했다. [GitHub 공식 코드 snippet reference](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet)와 문서의 실제 예시를 확인했다. 파일명·라인 범위 header, 줄 번호가 있는 코드, 특정 커밋의 permalink 구조를 기존 GCR 코멘트 안에 적용했다. 별도 수정 제안 박스와 본문 Markdown은 유지한다.

- GCR은 이미 권한 검사를 거쳐 조회한 snapshot diff를 재사용한다. 코멘트마다 새 source API를 호출하지 않는다. 참조 범위와 앞뒤 문맥을 최대 12줄로 보여 주고 긴 코드만 가로로 스크롤한다. 이전/변경 코드와 줄 번호를 구분한다.
- diff에 없는 범위나 다른 commit의 코드는 임의로 채우지 않는다. 미리보기 제한과 원문 링크를 표시한다. 서로 떨어진 hunk는 생략 표시로 구분하며 source 문자열을 HTML로 실행하지 않는다.
- 이전 코드 permalink는 rename 전 경로와 merge-base를 사용한다. 변경 코드는 head를 사용하며 anchor에 별도 고정 commit이 있으면 그 commit을 유지한다. Markdown 파일에는 `?plain=1`을 붙인다.
- 게시용 코멘트는 검증된 anchor에서 만든 permalink를 독립된 줄에 넣는다. 모델 본문의 URL로 permalink를 만들지 않는다. GitHub는 같은 저장소의 댓글에서 이를 native code snippet으로 표시한다. 다른 저장소·클라이언트에서는 링크로 보일 수 있다.
- 기존 P2/P3 필터는 그대로 적용한다. P2 전체 문안이 길이 제한을 넘으면 의견 묶음 전체가 빠지던 결함을 실제 #1024 문안에서 발견했다. 이제 P3부터 완전한 코멘트 단위로 담고 포함/전체 의견 수, 생략 안내, 전체 보고서 링크를 남긴다. 하나의 큰 코멘트 때문에 다른 코멘트를 모두 버리지 않는다.

GitHub 게시 결과의 실제 시각적 unfurl은 외부 PR 댓글 게시 없이 확인할 수 없어 미검증으로 남긴다. permalink 형태·출처·게시 문안과 실제 GCR 화면은 별도로 검증한다.

## 검증 기록

- UI·permalink·게시 formatter·GitHub adapter 59개 검사 통과. 실제 Chrome 1360px/420px에서 코드 참조, 강조 줄, 키보드 focus, 내부 가로 스크롤과 페이지 overflow를 확인했다.
- 격리 PostgreSQL의 작업 재개·게시 회귀 17개 통과. API의 merge-base 전달과 게시 문안의 고정 SHA 링크 assertion을 보강하고 해당 10개 검사를 다시 통과했다.
- 후속 길이 제한·게시 검사 37개 통과. 140개 의견 fixture에서 뒤에 있던 P3를 먼저 남기는지, 길이 상한과 details 태그·원문 불변성을 확인했다.
- packages/runtime/web build, runtime/web typecheck, 변경 파일 ESLint 통과. 기존 Rollup annotation/bundle 크기 경고는 유지한다.
- 첫 게시 formatter 검사 10건은 이전 변경에서 갱신되지 않은 `분석 완료 · 제한 있음` 기대값 때문에 실패했다. 현재 제품의 `일부 검토 · 제한 있음`으로 assertion을 바로잡고 재검증했다. 새 브라우저 fixture의 문자 encoding도 보완해 한글 screenshot을 다시 확인했다.
- alpha.75는 첫 코드 참조 수정으로 이미지를 만들었지만 운영 배포하지 않았다. 실제 #1024 문안으로 길이 제한 결함을 확인한 뒤 수정한 alpha.76을 최종 대상으로 만든다. 기존 tag를 덮어쓰지 않는다.

## 운영 배포와 보존 확인

- 코드 참조 commit: `03c74aef5226`; 길이 제한 보정 및 최종 image source: `971ddbe2e6f09465db6789d39fca51239d3766d2`.
- 배포 pin commit: `dc54fdf8758f86a07b7b03ea967240ae34b36b2a`.
- App `0.8.0-alpha.76`, chart `0.10.72`, PRISM-DEV Helm revision **84**, 상태 `deployed`.
- Image digest: `sha256:142984c0f5eb6047e7815008fe331422535a718e554a1de891c59ede95513558`.
- Chart OCI digest: `sha256:1ced4bebf726638d7a6a353343088f5f0a8570bba2d98edd601d757d11971e59`.
- Chart package SHA256: `ecd0c058ac124923bca8065ba32e29da0625caec8cafbd09237bf4c06f237f61`.

server·worker·source-sandbox가 위 digest로 Ready이고 restart는 0이다. 구 worker는 정상 종료 중이며 강제 삭제하지 않았다. PostgreSQL은 1Gi limit, restart 0, TLSv1.3를 유지한다. Helm lint와 렌더링을 확인했고 health 연결 시험도 Succeeded다. 첫 렌더링 검사는 image 사용 지점을 3개로 잘못 세어 실패했다. init·hook·retention을 포함한 실제 7곳 모두 같은 digest를 사용함을 확인한 뒤 패키징했다.

기존 Helm user values와 배포 후 값을 비교해 `image.tag`, `image.digest`, `model.analysis.groupMaxModelCalls`만 달라졌음을 확인했다. 기존 12개 데이터·설정 테이블의 전체 행 hash, #1024 작업 목록, 모델 요청 ledger는 모두 같다. 새 migration은 없다. 기존 보고서 26/1,045·의견 25개와 새 partial 보고서 336/1,045·의견 140개를 HTTP와 HTTPS 양쪽에서 확인했다.

15:48~15:50 KST의 운영 점검 결과:

- HTTP·HTTPS의 로그인·scheme별 cookie 보호·로그아웃 후 401을 확인했다.
- 256회 후속 실행 예산, 92/409 작업, 현재 quota와 19:32 재개 예정 시각을 확인했다. 재개 버튼은 계정 제한 중 비활성 상태다.
- 실제 Chrome의 코멘트 140건 모두 코드 미리보기를 표시하고, API permalink 140건의 커밋·경로·라인 범위를 대조했다. 별도 수정 제안 박스가 유지되고 page error는 없다. 기존 패널 크기 조절로 코드와 의견 전체가 함께 보이는 screenshot을 남겼다. 시험용 브라우저의 저장소만 사용해 사용자의 패널 설정을 변경하지 않았다.
- 실제 저장 보고서에서 게시 문안을 만들었다. P2 이상은 135건 중 45건(44파일, P3 3건 포함), 59,337자에 permalink 45개를 담았다. P3 전용은 3건 모두, 4,434자에 permalink 3개를 담았다. 추가 의견은 전체 보고서에 남는다. 외부 GitHub 댓글은 게시하지 않았다.

운영 브라우저 검사는 API 읽기만 허용했다. 자동 chat-session POST의 시험 차단 응답은 실제 chat 장애 증거가 아니다. 로그인 세션은 모두 로그아웃했고, Helm 시험 Pod와 이 작업의 임시 registry credential·Helm values 디렉터리를 정리했다. 전역 CLI·Docker 계정·사용자 설정은 바꾸지 않았다.

**실제 분석은 재개되지 않았다.** 이번 생성 모델 호출은 0회이고, 기존 ledger의 HTTP 완료 93·실패 8·중단 1은 동일하다. 707파일 미완료·2파일 제외 상태를 완료로 바꾸지 않았다. 제공자의 사용량 제한이 해제된 후 명시적으로 재개해야 한다. 이 변경은 재개 시 사용할 256회 예산과 화면·게시 문안의 개선을 배포한 것이다.

안전한 집계와 hash는 [검증 JSON](2026-09-19-code-references-evidence.json)에 기록한다. 원문 코드 screenshot은 `artifacts/operations/usage-code-view-2026-09-19/code-comment-live.png`에 보관하고 Git에는 추가하지 않는다.
