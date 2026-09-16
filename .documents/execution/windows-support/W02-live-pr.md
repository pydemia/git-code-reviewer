# W02 추가 검증: 실제 GitHub 테스트 PR과 로컬 GCR

2026-09-16 사용자가 접근할 수 없는 #917/#915 대신 로컬 GCR과
`pydemia/commit-defender`의 새 PR로 검증하도록 변경했다. 기존 PRISM
원자료를 검증한 것으로 표시하지 않는다. 새 PR의 실제 원문을 수집하고
같은 W02 동작 조건을 확인하는 별도 실행이다.

## 대상과 호출 전 기대 결과

- PR: https://github.com/pydemia/commit-defender/pull/3
- 상태: draft, merge하지 않음.
- base: `codex/windows-native-support`,
  `df7fc59ea64d17e85829327004f66807ef9e7504`
- head: `codex/w02-github-history-test`,
  `2aca9bbc54e811f0d7d8d0c966148d85fff1636a`
- 변경 경로: `vscode-extension/test/fixtures/w02-history/`의 7개 파일.
  제품 코드 변경은 없다. 기존 G04의 고정 fixture를 재사용했다.
- 추가 실제 호출 한도: `gpt-5.6-luna / high`, 세 사례 각 1회,
  회당 최대 240초. 재시도는 실패 원인·수정·추가 한도를 기록한 뒤 수행한다.

| 사례 | source/base 조건 | 기대 결과 |
| --- | --- | --- |
| defect | 정상 model validator를 호출되지 않는 별도 함수로 이동 | 두 model_validate 호출 경로에서 reference_id 누락·null이 통과함을 지적하고 PR 원문·활성 지침을 인용 |
| fixed | 위 결함을 model validator로 복원 | 지침 충족을 설명하며 해결된 결함을 반복 지적하지 않음 |
| unrelated | 요청 검증을 유지하고 저장된 archived 상태를 service에서 거부 | DB 상태 검증은 요청 값 지침의 적용 대상에서 제외하는 이유를 설명 |

각 사례는 schema.py, service.py, api.py, repository.py, pyproject.toml,
경계값 테스트를 고정한다. 테스트는 누락·명시적 null·양수 reference_id와
두 호출부를 포함한다. unrelated에는 저장된 archived 상태의 거부 조건도
포함한다. 읽은 테스트를 실행한 것으로 표시하지 않는다.

Host 실행기는 모델 호출 전에 Git base/tree SHA와 각 파일의
base/source SHA256을 기록한다. 중앙 source ID·본문 hash·관찰 hash와
guidance ID·revision은 실제 reader 응답으로 결정하며 추정하지 않는다.
본문·답글·버전의 온라인/오프라인 응답을 대조한 후 signed offline lease로
고정하고 실제 응답의 적용 판단과 저장 결과 재조회를 별도로 확인한다.

## 로컬 실행 구성

`apps/runtime/test/windows-github-reader-server.ts`는 Windows Node에서
GCR의 실제 인증·credential 발급·history 수집·지침·reader 라우트를
기동한다. TLS와 서명 key는 메모리에만 두며 reader credential은 기존
Windows 보안 저장소를 사용한다. 공개 연결 JSON에는 CA·서명 공개키와
credential 참조만 기록한다. 기존 사용자 설정과 운영 연결은 변경하지 않는다.

임시 PostgreSQL은 고정 Docker image와 별도 volume에서 실행한다.
DB는 Linux container이며 Windows 네이티브 검증 대상은 API와 CD Host다.
기존 사용자 DB·container·volume은 사용하지 않는다. 기존 Git credential을
메모리에서 읽어 GitHub에 읽기 요청만 보낸다. 댓글 게시에는 별도 GitHub
연결 도구를 사용하며 서버가 외부 댓글을 자동 작성하지 않는다.

CD에서 로컬 GCR로 보내는 reader 요청은 GET·본문 0바이트로 관찰한다.
로컬 관리자의 credential 발급·수집·지침 등록 요청은 이 통신과 구분한다.
모델 provider 호출은 W01/W02의 설치된 worker와 수동 실행 경로를 유지한다.
온라인 manifest의 5분 제한과 기존 1시간 signed offline lease를 변경하지 않는다.

## 현재 결과

- GitHub 계정 `pydemia`의 저장소 쓰기 권한과 PR 생성을 확인했다.
- 로컬 GCR의 실제 로그인, 검증용 reader 발급·Windows 저장,
  실제 PR metadata 조회와 history collection 1회를 실행했다.
- 최초 수집 시 댓글·답글은 0건이다. collection은 completed이며
  원문 검증·지침 적용 성공을 뜻하지 않는다.
- GCR 새 검증 서버의 ESLint·Prettier·strict TypeScript 검사가 통과했다.
- CD test 타입 검사와 새 Host harness 번들 빌드가 통과했다.
- 추가 모델 호출은 아직 0회다.
- 실제 Windows 클라이언트가 보안 저장소의 reader credential을 다시 읽고
  PR #3의 온라인 응답과 암호화 cache 재조회를 대조했다. 값이 일치했으며
  원문 0건과 collected 상태를 구분했다.
- 사전 검증 후 서버·DB container·volume·reader credential·임시 profile을
  정리했다. 다음 단계에서 같은 검증 서버를 새 임시 상태로 기동한다.
- [사전 검증 근거](evidence/W02-live-pr-preparation.json)에 실제 수행한
  경로와 아직 실행하지 않은 지침 활성화·Host 검증을 분리했다.

사용자는 새 PR 생성을 요청했으나 이전 지침에서 외부 댓글 게시를
제외했다. 이 테스트 PR에 한해 리뷰 댓글·답글을 게시할 수 있는지
질문했으며 답변 전에는 게시하지 않는다. 승인이 도착하면 원문 초판 수집,
본문 수정판과 답글 수집, 지침 활성화, 세 실제 리뷰 순서로 진행한다.

제품 artifact는 client 0.1.0-alpha.48, native helper 1.0.2,
VSIX 2.12.3을 재사용한다. 현재 변경은 검증 코드와 문서에 한정되며
제품을 재빌드·재설치하지 않았다. 기존 사용자 Host 적용 상태는 미확인이다.

## 검증 코드 전달

- GCR 사전 검증 실행 SHA: `6b63e7589386a752fc39c7ca78b1ba7a2f1bfeb4`.
- GCR 후속 지침 hash 기록 코드 SHA:
  `559715c64f37eb5e9f3ad86e423621d0ef6fa29c`.
  지침 활성화 경로는 아직 실행하지 않았다.
- CD Host harness SHA: `ff357d3a600d58ec0d635a83848c79e46c519390`.
  타입 검사·번들 빌드만 수행했으며 이 harness의 실제 모델 실행은 아직 없다.

기동은 GCR에서 `node apps/runtime/node_modules/tsx/dist/cli.mjs
apps/runtime/test/windows-github-reader-server.ts`로 수행한다. 현재 process
PATH에 Git OpenSSL 경로를 추가해야 한다. 서버 stdin의 제어 명령은
`{"action":"collect"}`, `{"action":"activate","sourceGithubId":실제댓글ID}`,
`{"action":"stop"}`이다. ID를 추정하지 않는다. 대기 상한은 40분이며
종료 시 검증 전용 자원을 정리한다. 사용자용 지속 운영 서버로 등록하지 않는다.

댓글 없는 사전 검증은 별도 process에서
`node apps/runtime/test/windows-github-reader-preflight.mjs`를 실행한다.
이 명령은 source 0건을 기대하므로 원문을 게시한 뒤에는 사용하지 않는다.

## 승인 후 게시할 검증용 원문

PR head의 schema.py 9행에 다음 리뷰 댓글을 남긴다.

> [W02 검증용 리뷰] BlockUpdateRequest.model_validate는 클래스 밖의
> validate_block_update_type_rules를 호출하지 않습니다. reference 블록에서
> reference_id를 생략하거나 null로 전달하면 update_block과 preview_block
> 양쪽에서 검증을 통과합니다. 요청 필드 사이의 제약은 BlockUpdateRequest의
> model_validator(mode="after")에서 실행해 주세요.

초판을 수집한 다음 같은 댓글에 다음 문장을 추가해 본문 버전을 검증한다.

> 저장된 archived 상태처럼 DB 조회가 필요한 조건은 service에서 판단합니다.
> 이 지침은 요청 값만으로 결정할 수 있는 조건에 한정하며 기존 Field의
> 양수 제약을 중복 구현하도록 요구하지 않습니다.

답글은 다음과 같다.

> [W02 검증용 답글] 수정 사례에서는 model validator를 복원하고 두 진입점의
> 누락·null 입력을 확인하겠습니다. 무관한 변경 사례의 archived 조건은
> 저장된 DB 상태를 사용하므로 service에 유지하겠습니다. 이 draft PR은
> 결함 fixture를 보존하며 실제 제품 코드가 아닙니다.
