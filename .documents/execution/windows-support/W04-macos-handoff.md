# W04 macOS/Linux 회귀 점검 인계

Windows 호환성 개발과 Windows 검증은 끝났다. 이번 작업은 변경 후에도
macOS/Linux의 기존 기능이 유지되는지 확인하고 발견된 회귀만 수정하는 것이다.

Linux ARM64 container에서는 service, hook, 결과 판정 검사를 이미 수행했다.
기존 결과를 재사용하고 추가 수정의 영향을 받는 항목만 다시 검사한다.
macOS native 검사는 아직 실행하지 않았다.

## 시작

GCR과 CD의 기존 `codex/windows-native-support` branch를 fetch하고 다음
전달 commit을 포함하는지 확인한다. 기존 작업·계정·설정·데이터를 보존한다.

- GCR: `59ac49a430eb4b5c8038720a774e301ec12dec13`
- CD: `3afe86e50d5b95b9513567a9099dd05c682c3de6`

먼저 [W04 실행 기록](W04.md),
[변경 영향](evidence/W04-impact.json),
[기존 검증 결과](evidence/W04-validation.json)를 읽는다.
세부 source와 artifact hash는
[전달 기록](evidence/W04-delivery.json)에 있다.

## 점검할 기존 기능

실제 Mac에서 기존 테스트와 필요한 최소 smoke 검사를 실행한다.

| 항목 | 확인할 동작 |
| --- | --- |
| 저장소 | Keychain과 암호화 데이터의 저장·재조회·실패 처리 |
| 파일·snapshot | 기존 권한·symlink·민감 파일 제외·source 고정 |
| service | Unix IPC 연결, 중복 기동, 종료·재시작·복구 |
| process | Codex 격리, 취소·timeout과 소유 자식 process 정리 |
| CD | 기존 hook 보존, 자동/수동 리뷰 제어와 결과 판정·재조회 |

관련 검사는 GCR의 `local-*.test.ts`, `source-snapshot.test.ts`,
`process.test.ts`, `codex-isolation.test.ts`와 CD의
`managed-hooks`, `review-outcome`, `automatic-review`,
`background-recovery`, `model-credentials` 테스트다.
실제 구현과 test 내용을 확인해 영향받은 항목을 선택한다.
전체 테스트나 모델 리뷰를 무조건 반복하지 않는다.

Keychain은 실제 OS 접근도 확인한다. in-memory/mock 또는 POSIX 임시 key
fixture의 통과를 Keychain 검증으로 쓰지 않는다. 기존
`scripts/local-store-smoke.mjs`는 고정 package의 consumer에서 재사용할 수 있다.
비밀을 평문 파일·argv·환경변수·로그에 남기지 않는다.

## 실행 기준

- 고정 package는 CD vendor에 있다. contract48, core/executors49,
  CLI38과 helper1.0.3을 재사용한다. 테스트가 실행한 package/hash를 기록한다.
- 제품 변경이 없으면 재발행·VSIX 재빌드·설치는 하지 않는다.
  Windows VSIX 2.12.4를 Mac에 설치할 필요는 없다.
- 추가 실제 모델 호출은 기본 0회다. 기존 실제 리뷰 근거를 재사용한다.
  수정으로 실제 모델 재검증이 필요해지면 이유와 호출 한도를 먼저 기록한다.
  기존 Codex 계정의 gpt-5.6-luna/high를 임의로 대체하지 않는다.
- 실제 OS 검사와 mock, source test와 고정 package 실행을 구분한다.
  실패·partial·timeout·skip을 성공으로 바꾸지 않는다.
- 임시 repository/profile만 사용하고 작업이 만든 자원만 정리한다.
  사용자 Host/service와 전역 설정을 바꾸지 않는다.

회귀가 발견되면 필요한 최소 수정만 한다. 공통 실행 코드를 수정하면
영향받는 Linux/Windows 재검증 범위를 기록한다. 새 Windows artifact 검증이
필요하면 원래 장비에 인계하고 Mac 결과로 대신하지 않는다.

## 결과 전달

양쪽 `.documents/execution/windows-support/W04-macos.md`에 실제 환경,
검사 결과, 사용한 source/package hash, 수정 사항과 남은 조건을 기록한다.
필요한 evidence를 연결하고 W-A09 판정을 갱신한다. 코드·test·문서 변경을
구분해 commit·push한 뒤 원격 SHA와 작업 트리를 확인한다.

Mac 회귀와 필요한 Linux 재검증, 이번 장비 정리가 끝나면 결과를 보고하고
멈춘다. 새 기능·중앙 통신·CI 구축·배포·Marketplace 게시는 하지 않는다.

원래 Windows의 [삭제 차단 폴더 19개](W04-cleanup.md)는 별도 수동 정리
대상이다. Mac에서 처리하거나 완료로 바꾸지 않는다. Mac 회귀 완료와
W04 전체 완료를 구분한다.
