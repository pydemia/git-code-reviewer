# 리뷰 문맥 준비 오류 수정 — 2026-09-26

## 원인과 수정

사용자가 `src/semantic_query/adapters`의 14개 파일을 리뷰할 때 `Required review context is unavailable. No model request was made.`가 반복됐다. 로컬 source capture와 저장된 GCR 연결 2개는 정상이었다. 실제 연결의 온라인·오프라인 문맥 준비를 재현해 기존 코드가 `central-context-budget`에서 중단됨을 확인했다. 계정·모델 사용량 오류나 reader key 인증 실패가 아니다.

앞서 추가한 다중 출처 코드가 Skill·지침을 먼저 선택한 뒤 출처 메타데이터를 붙였다. 선택 시점에는 한도 안이었지만 출처 정보를 포함한 최종 크기가 64KiB를 넘으면 선택적인 참고 자료까지 전체 문맥 실패로 처리했다.

출처 메타데이터를 선택 전에 각 항목에 넣어 전체 크기로 admission을 판단하도록 고쳤다. 기본 한도 65,536바이트와 전체 문맥 제한은 그대로다. 선택적인 참고 자료가 한도를 넘으면 budget omission으로 남긴다. 현재 저장소의 필수 Skill·정책이 한도를 넘으면 `needs-context`로 차단한다. 필수 정책을 참고 자료로 낮추거나 만료·철회 검사를 완화하지 않았다.

CD는 필수 지침의 한도 초과와 문맥 검증·읽기 실패를 구분해 알린다. Worker에는 허용한 오류 code와 고정 메시지만 전달하며 개인 자료·provider 원문 오류를 표시하지 않는다.

## 검증

실제 `/Users/a09255/git/semantic-query`의 같은 14개 Python 파일과 저장된 출처 2개로 다시 준비했다. 온라인·오프라인 모두 `ready`, 최종 문맥은 65,387바이트이며 미충족 필수 자료는 없다. 이 검증은 문맥 준비까지이며 실제 모델의 리뷰 결과를 성공으로 간주하지 않는다. 이번 작업의 실제 모델 호출은 0회다.

- GCR 기존 central review·local context·cache·history 4개 파일의 94건이 통과했다. 출처 정보를 포함한 참고 자료가 한도를 넘으면 선택을 줄여 준비가 완료되는 경우와 필수 정책이 들어가지 못하면 차단하는 경우를 추가했다. 관련 lint·typecheck도 통과했다.
- CD의 central sources 6건, central review 12건, standalone review 17건, review security 10건, client contract 22건, local provider executor 10건, review chat 4건, central sync 3건, 총 84건이 통과했다. 큰 참고 Skill과 디렉터리 14개 파일의 준비, 권한 철회, 기존 provider·민감 파일 제외·취소·저장 이력·오프라인 경계를 확인했다. 모델 응답은 합성 executor·fake CLI를 사용했다. 제품·시험 코드 typecheck와 빌드도 통과했다.
- 고정 tarball의 clean consumer와 CLI 설치 검증을 통과했다. CLI는 새 client artifact를 재포장하지 않고 `--reuse-clients`로 가져오며 workspace package metadata와 포함된 library input hash를 대조했다.
- 패키징한 CD 2.13.5를 실제 VS Code 1.138.0 / Electron 42.10.0 / Node 24.18.1의 별도 Host에서 활성화했다. 서명된 두 시험 출처의 discovery·캐시·미리보기를 확인했고 GCR 시험 요청은 GET·본문 0 byte였다. 미리보기 검사는 HTML 원문과 tab 생성 확인이다. 렌더된 DOM의 시각 검사나 실제 사용자의 reader key로 수행한 UI 입력 검증은 아니다.

최초 시험의 fixture 조건, 기본 LibreSSL 출력 형식, CLI 재포장 시도와 VS Code executable 이름 때문에 발생한 실패는 [검증 JSON](2026-09-26-context-preparation-evidence.json)에 구분해 기록했다. 최종 통과로 실패 사실을 덮어쓰지 않았다. 실패한 시험의 임시 키 파일과 소유한 디렉터리 5개, 별도 Host·추출 경로는 정리했다.

## Artifact와 적용

GCR source `fcb100d6ea4c4a560fcf2a8cde25d7b344824cd1`에서 delivery alpha.54를 만들었다. contract alpha.51은 기존 바이트를 재사용했고 core alpha.53 / executors alpha.54 / CLI alpha.43을 고정했다. CD 패키징 source는 `79496503ed4c7b3160a620f678f004be85e2f501`다. Windows helper 1.0.3의 바이너리 2개는 이전 VSIX와 동일하다.

최종 VSIX는 `/Users/a09255/git/commit-defender-windows-macos/vscode-extension/test-results/commit-defender-2.13.5-darwin-arm64.vsix`, SHA-256 `53d9b7515a3b474b4ff897d5d653607dcb849bba922555e6b58f8badc27f793f` (743,998 bytes)다. 로컬 `/Users/a09255/.vscode/extensions/pydemia.commit-defender-2.13.5`에 설치했고 실행 파일 8개와 package metadata가 VSIX와 일치한다. settings hash와 암호화된 중앙 연결 파일 9개는 설치 전후 동일하다. 전역 CLI·계정·provider·모델 설정을 바꾸지 않았다.

현재 열린 사용자 Host에는 강제 reload를 하지 않았다. 일반 **Developer: Reload Window** 또는 VS Code 재시작 후 같은 디렉터리 리뷰를 다시 실행한다. 기존 key와 연결은 보존했으므로 이 수정 때문에 재발급·재연결할 필요는 없다. 필수 정책의 한도 초과 메시지가 표시되면 선택 파일 수 또는 중앙의 필수 지침 크기를 줄여야 한다. 선택한 모든 참고 항목이 매번 문맥에 포함되는 것은 아니다.

서버 runtime 변경은 없어 PRISM-DEV를 재배포하지 않았다. Helm revision 91 / GCR 0.8.0-alpha.83 / chart 0.10.79가 deployed 상태인 것을 확인했다. Marketplace 게시와 추가 실제 모델 실행·Windows/Linux OS 검증은 하지 않았다. 코드·문서·패키징·실행 기록은 구분해 commit하고 두 저장소의 `codex/windows-native-support`에 push한다.
