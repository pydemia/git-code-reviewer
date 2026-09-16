/goal

GCR 작업 위치는 <이 장비의 GCR 절대 경로>,
CD 작업 위치는 <이 장비의 CD 절대 경로>야.

Windows 호환성 개발 후 macOS/Linux의 기존 기능이 유지되는지 점검해 줘.
GCR의 .documents/execution/windows-support/W04-macos-handoff.md와
양쪽 W04 실행 기록·변경 영향·검증 결과를 먼저 읽어 줘.

두 저장소 모두 기존 codex/windows-native-support branch에서 이어서 작업하고
최신 원격을 fetch해 다음 전달 commit을 포함하는지 확인해 줘.

- GCR: 59ac49a430eb4b5c8038720a774e301ec12dec13
- CD: 3afe86e50d5b95b9513567a9099dd05c682c3de6

실제 macOS에서 저장·Keychain·snapshot·Unix service·process 취소/격리·
기존 hook과 리뷰 결과 처리의 영향받은 회귀를 검사해 줘.
기존 테스트를 우선 사용하고 빠진 실제 OS 검증만 최소한으로 보완해 줘.
Linux는 기존 ARM64 container 결과를 재사용하고 추가 수정의 영향이 있을 때만
해당 항목을 다시 검사해 줘. 실행하지 않은 환경은 미검증으로 남겨 줘.

제품 변경이 없으면 기존 고정 package와 VSIX를 재사용해 줘.
추가 실제 모델 호출 기본 한도는 0회야. 기존 실제 리뷰 근거를 재사용하고
꼭 재검증해야 하면 이유·대상·추가 횟수와 회당 최대 240초를 먼저 기록해 줘.
기존 Codex 계정의 gpt-5.6-luna/high를 임의로 대체하지 마.

기존 작업·데이터·계정·설정을 보존하고 임시 repository/profile만 사용해 줘.
비밀을 평문 파일·argv·환경변수·로그에 남기거나 보안 검사를 완화하지 마.
실제 OS 검사와 mock을 구분하고 실패·partial·timeout을 성공으로 표시하지 마.
회귀가 발견되면 최소 수정하고 영향받는 플랫폼만 재검증해 줘.
새 Windows 검증이 필요하면 원래 장비로 인계해 줘.

양쪽 .documents/execution/windows-support/W04-macos.md에 환경·검사 결과·
source/package hash·수정 사항·남은 조건을 기록하고 W-A09를 갱신해 줘.
변경을 구분해 commit·push하고 시험 자원 정리와 작업 트리를 확인해 줘.

Mac 회귀와 필요한 Linux 재검증·인계가 끝나면 이 goal을 완료하고 멈춰 줘.
필수 검사가 남으면 완료 처리하지 마. 새 기능·중앙 업로드·CI 구축·배포·
Marketplace 게시는 하지 마. 원래 Windows의 폴더 19개 수동 정리는 별도이므로
이번 회귀 완료를 W04 전체 완료로 표시하지 마.
