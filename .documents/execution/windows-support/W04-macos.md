# W04 macOS 호환성 회귀 결과

상태: **이번 macOS 회귀 goal 완료, W-A09 필수 회귀 충족. W04 전체는 미완료.** 원래 Windows의 폴더 19개 수동 정리는 별도 작업으로 남긴다. 해당 폴더에 접근하거나 삭제를 시도하지 않았다.

2026-09-16에 [인계 문서](W04-macos-handoff.md)의 범위만 실행했다. GCR은 기존 `git-code-reviewer` checkout의 최신 `codex/windows-native-support`를 사용했다. CD는 기존 checkout을 보존하고 `commit-defender-windows-macos` worktree에 같은 branch를 준비했다. 두 저장소 기준 commit과 요구된 Windows 전달 commit의 조상 관계를 확인했다.

## 환경과 변경

macOS 26.3.2 / build 25D2140 / ARM64, Node 25.9.0, pnpm 10.17.1, Apple Git 2.50.1에서 실행했다. 기존 사용자 Host·service를 교체하거나 강제 reload하지 않았다. 실모델 호출과 운영 서버 요청은 **0회**다.

제품 실행 코드의 회귀는 발견하지 않았다. GCR `local-foundation.test.ts`에 남은 “win32는 미지원이므로 생성자가 거부해야 한다”는 기대값만 실제 미지원 OS인 `freebsd`로 고쳤다. 미지원 플랫폼 거부·잘못된 key·잠금 오류·비밀 누출 방지 검사는 유지했다. `scripts/macos-w04-package-smoke.mjs`는 고정 package의 실제 macOS 경계 검증을 보완한다. 테스트 commit은 `6c945067847bf6c68fb0044346c2b78897606098`이다.

첫 source build는 이전 node_modules에 새 workspace dependency 연결이 없어 실패했다. `pnpm install --frozen-lockfile`로 설치 상태를 맞춘 뒤 통과했다. lockfile이나 dependency version은 바꾸지 않았다. 첫 GCR 실행의 실패 1건과 executor suite 로딩 실패 2건은 [검증 근거](evidence/W04-macos-validation.json)에 남겼다. 해당 항목을 수정 후 다시 실행했으며 이미 통과한 전체 검사를 반복하지 않았다.

## 검사 결과

| 대상 | 결과 | 검증한 경계 |
| --- | --- | --- |
| GCR foundation·records·history·review observations | 34건 통과 | POSIX 권한·symlink 거부, 암호화·손상·동시성·재조회와 오류 의미 |
| GCR snapshot | 28건 통과 | source 고정·민감 파일·경로/링크 경계 |
| GCR service | 8건 통과 | 실제 Unix IPC, queued/started 복구·report 재사용·중복 owner·시작 실패·종료 오류. 서비스 executor와 key port는 fixture |
| GCR process·Codex isolation·config·source bridge | 18건 통과 | 실제 프로세스 취소/timeout·후손 정리, macOS sandbox marker, synthetic catalog, 도구/전송 계약 |
| GCR central credential adapter | 4건 통과, 1건 제외 | command 경계 검사. 제외 1건은 Windows native 전용이며 이전 Windows 결과 재사용 |
| CD model credential | 13건 통과 | 설정/참조/암호화 경로와 실패·이전 설정 처리 |
| CD automatic review·background recovery | 26건 통과 | 기존 trigger·수동 우선·중복 방지·재시작·취소·실패. VS Code API는 mock |
| CD managed hooks | 6건 통과 | 실제 Git/hook 실행·stdin/exit 보존, partial commit·worktree·core.hooksPath·해제 |
| CD review outcome | 23건 통과 | failed/partial/cancel/timeout 판정과 기존 고정 hook bundle. 모델은 합성 fixture |

최종 중복 제외 집계는 **160건 통과, 0건 실패, Windows 전용 1건 제외**다. CD test typecheck와 GCR 변경 파일 lint도 통과했다. 실제 Extension Host나 실제 모델을 새로 실행한 근거로 해석하지 않는다.

### 고정 artifact의 실제 OS 검사

CD의 lockfile로 설치한 contract48/core49/executors49를 그대로 사용했다. source package로 import를 바꿔서 통과시키지 않았다.

- 기존 `scripts/local-store-smoke.mjs`: 실제 Keychain을 사용해 암호화 지식·리뷰·대화·보존 정책을 다른 process에서 다시 읽었다. 8개 writer 중 1개 성공·7개 revision conflict, 삭제 후 새 process에서 부재를 확인했다. 시험 key는 삭제 후 재조회 부재를 assert했다.
- 추가 smoke: 실제 Keychain으로 저장한 record의 ciphertext 손상을 거부하고, key를 삭제한 뒤 기존 데이터 접근이 `credential-unavailable`로 실패하며 새 key를 만들지 않음을 확인했다. reader credential의 저장·새 adapter 재조회·삭제도 실제 Keychain으로 검사했다.
- core49의 실제 Unix socket은 현재 uid 소유·다른 사용자용 POSIX 권한 없음, 중복 service 거부, status·stop·restart·close와 socket 삭제를 확인했다. Keychain key 2개와 고유 reader credential, 임시 root·소유 service를 정리했다.
- executors49의 sandbox-exec에서 합성 auth 파일 접근은 허용하고 두 전역 AGENTS marker 읽기는 거부했다. 실제 Node 자식의 timeout·취소 상태를 확인했다. 실제 Codex 계정/모델 호출은 하지 않았다.
- CLI38 tgz에서 원본 bundle을 추출해 macOS에서 `--help`를 실행하고 hash를 대조했다. 서비스/VSIX를 재발행하지 않았다.

사용자의 실제 Keychain을 잠그거나 기존 key를 지워 오류를 유발하지 않았다. 잠금·helper 오류는 기존 command mock 근거이고, 실제 key 누락·손상·영속화·IPC는 위 OS 검사 근거다.

## Source와 artifact 연결

| 대상 | SHA / 버전 |
| --- | --- |
| GCR 시작 HEAD | `ffb0ed30117742ccaeed24fd0643408b52daf5da` |
| GCR 검증 source commit | `6c945067847bf6c68fb0044346c2b78897606098` |
| CD 시작·검증 HEAD | `53a98161f1db535507c4aa6f887ee11863f26360` |
| 기존 GCR 제품 source | `8ea024aa1fa8ea9bf6bf3c1a7d522e4008f62a44` |
| 기존 CD 제품 / packaging | `2c2a40647c72e9ae00489ba0a5efaa7c3351792c` / `722b55cb6d93269aa76bf298e9e9531dc9ac7ecc` |
| client-contract | alpha.48 · `1b1245f4540cecf8d00279a0491ec1124fa669b8c5ad5993f3d284c4d109d3b8` |
| client-core | alpha.49 · `0471d3f34a10a4c1badb7e6e8586bf6bb16f33308b15a117a71ad647b7a25be4` |
| client-executors | alpha.49 · `627faa3b2855a1f33c2e781c7036e28a6295ed231a7ad1f2a7cadf8d6c2e6e47` |
| private CLI tgz | alpha.38 · `01a7e41379e9f1f22d76a16cf89090345df986a1a2e542c147cb76d7d09631e5` |
| private CLI bundle | `47d59eb3b668d2d9067730ed963cedb244f96876e7708af61145fcf05b8ef364` |
| Windows helper | 1.0.3 · `c289d819f52c2f610c7c69d0d27393b4aaaebeb6103a0e6f442f024559018e89` · 기존 Windows 근거만 사용, Mac 실행 없음 |
| Windows VSIX | 2.12.4 · `88471efee2b80a1b79d28e4712d90566eeeac1fa3ea6fa340d515efba5a48f1b` · 기존 전달 근거 재사용, Mac 설치 없음 |

위 package hash는 SHA256이며 CD vendor 실파일과 대조했다. 전체 경로별 hash와 테스트 이름·상태는 [W04-macos-validation.json](evidence/W04-macos-validation.json)에 있다. 문서 commit은 이 기록 뒤에 추가되며 제품 source/artifact hash를 바꾸지 않는다.

macOS에서 검사용으로 compile한 JS 66개를 고정 package와 대조한 결과 65개가 byte 단위로 일치했다. `builtin-review.js` 한 개는 Windows build의 template literal CRLF와 macOS LF가 다르다. 줄바꿈을 정규화한 본문은 같지만 실제 bytes와 계산되는 builtin hash가 같다고 주장하지 않는다. 이번에는 Windows에서 고정한 package를 그대로 사용하고 새 artifact를 만들지 않았으며 이 차이를 성공 판정에 맞춰 정규화하지 않았다.

## Linux·보존·남은 조건

제품 실행 코드와 package가 바뀌지 않아 Linux를 다시 실행하지 않았다. [W03 Linux service/hook](evidence/W03-validation.json)과 [W04 Linux outcome](evidence/W04-validation.json)의 ARM64 container 결과를 재사용했다. Linux desktop Secret Service나 Linux Codex 계정 executor 전체의 지원 근거로 확대하지 않는다. 이번 macOS 전용 smoke 추가와 미지원 OS 테스트 기대값 변경은 Linux 제품 재검증을 요구하는 실행 변경이 아니다.

Codex auth/config, VS Code 사용자 settings, 전역 Git 설정과 설치된 CD manifest의 전후 hash가 일치했다. 고정 package/vendor/CD 기존 build 변경도 없다. 시험 Keychain key·reader credential은 삭제 후 부재, 임시 root·socket은 삭제, fixture process는 잔존 없음으로 확인했다. 사용자 service·Host와 전역 CLI는 변경하지 않았다. CD npm 의존성과 검증 로그는 이 작업 worktree의 개발 자료로 유지한다.

**W-A09는 이번 macOS 필수 회귀와 기존 범위의 Linux 근거로 충족한다.** W-A10의 원래 Windows 삭제 차단 폴더 19개는 그대로 남는다. Windows x64·다른 OS 조합, 이미 열린 사용자 Host의 적용 버전, 기존 W03 launcher 실패와 PR3/로컬 GCR 대체 검증 범위는 종전 제한 그대로다. W04 전체 완료를 표시하지 않는다.
