# Windows 지원 완료 후 게시

2026-09-16 기준 CD 게시 파일의 로컬 검증을 완료했다.
Marketplace 업로드는 아직 수행하지 않았다. 이 PC에 `pydemia` 게시용
credential이 없어 보안 입력을 기다리고 있다. GCR 서버 image·Helm chart의
추가 게시 여부는 사용자에게 확인 중이다. W04 완료 상태와 별도 작업이다.

## CD 게시 파일

| 항목 | 값 |
| --- | --- |
| ID | `pydemia.commit-defender` |
| 버전·대상 | `2.12.5`, `win32-arm64` |
| 파일 | `vscode-extension/commit-defender-2.12.5-win32-arm64.vsix` |
| SHA256 | `42e3f49567afca1c74d36892fc6e36b3c0de347be4d4cf411fa19e9b40f9008c` |
| CD 패키징 source | `469e4362686a81644cc84aa28e623b20fdea3def` |
| GCR source | `2380be86e8c84e91f5168cc3482b2adcf50f5f3d` |
| GCR 고정 artifact source | `8ea024aa1fa8ea9bf6bf3c1a7d522e4008f62a44` |

2.12.4의 실행 파일 11개는 그대로다. Windows 안내·changelog를 포함하고
Marketplace README의 잘못된 저장소 루트 링크를 CD source SHA의
`vscode-extension/` 경로로 고쳤다. 기존 2.12.4 VSIX를 덮어쓰지 않았다.

`@vscode/vsce 4.0.0`의 기본 prepublish/typecheck/build와 secret 검사를
통과했다. 패키지 51개 항목에 Windows 안내·license·native helper가 있으며
test/vendor/credential/임시 파일은 없다. 검증 우회 옵션은 사용하지 않았다.
VSIX·빌드·별도 설치본의 실행 파일 hash 11개가 W04 검증본과 일치한다.

별도 Windows ARM64 Extension Host가 설치된 2.12.5를 로드했다.
service 시작, opt-in hook 연결, service를 먼저 종료한 Host 종료,
임시 profile/key 정리를 통과했다. Host launcher exit 0이다.
모델 추가 호출은 0회이며 동일 실행 파일의 W01~W03 실제 리뷰 근거를
재사용한다. W03의 실패 기록과 report/launcher 판정은 그대로 유지한다.

현재 사용자 설치본은 2.12.4이고 열린 사용자 Host의 적용 버전은 미확인이다.
이번 2.12.5는 별도 QA 설치만 수행했다. 사용자 Host 재로드, 전역 CLI·계정·
모델·자동 실행 설정 변경과 운영 service 교체는 하지 않았다.

- [패키지·source·hash 대조](evidence/publish-2.12.5-artifacts.json)
- [2.12.5 실제 Host 수명 검증](evidence/publish-2.12.5-host.json)
- [기존 전체 수용 근거](W04.md)
- [설정 보존과 정리 상태](evidence/publish-preservation.json)

검증 service·Host·임시 credential/profile은 종료·정리됐지만 별도 VSIX
설치 폴더는 자동 승인 검토의 삭제 차단으로 남아 있다. 재시도하거나 다른
도구로 우회하지 않았다. 수동 정리 대상은 다음 한 곳이다.

`C:\Users\pydemia\git\commit-defender\vscode-extension\test-results\publish-2.12.5`

## 게시할 때 남은 단계

Marketplace 실제 조회의 최신 version은 2.3.0이었다. `vsce login pydemia`의
마스킹된 입력으로 인증하고 publisher 쓰기 권한을 확인한다.
PAT는 채팅·argv·환경변수·평문 파일로 전달하지 않는다.
Windows 보안 저장소를 사용하며 다른 publisher로 대체하지 않는다.

검증한 위 VSIX를 `vsce publish --packagePath`로 게시한다.
게시 응답·Marketplace의 version/target·별도 신규 설치와 activation을
확인한 뒤 이 기록을 갱신한다. 게시 시 재빌드하거나 동일 version을
덮어쓰지 않는다. 현재 인증·업로드·게시 후 설치는 미완료다.

GCR의 contract alpha.48, core/executors alpha.49, helper 1.0.3,
CLI/service alpha.38은 W04 고정 파일을 유지한다. CLI 전달 manifest의
tarball 4개 SHA256을 다시 확인했다. 공개 npm package는 만들지 않는다.
기존 서버 image alpha.63 / chart 0.10.59의 추가 게시 여부를 확인한 뒤
필요한 변경 범위만 진행한다. 운영 서버 적용은 수행하지 않았다.

Windows x64와 다른 OS 조합을 이번 Windows ARM64 게시의 실행 검증
범위에 포함하지 않는다. macOS ARM64 회귀와 Linux ARM64 container 근거는
W04 기록의 범위를 따른다.
