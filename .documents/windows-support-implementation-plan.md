# Commit Defender Windows 네이티브 지원 구현 계획

작성일: 2026-09-16
상태: 계획 작성 완료, 구현 미착수. Windows machine의 별도 세션에서 실행한다.

## 목표와 범위

Windows의 일반 사용자 계정으로 VS Code와 Commit Defender(CD)를 설치하고, 기존 계정·provider·모델로 수동 리뷰를 실행한다. GCR의 리뷰 원문·Skill·프롬프트·활성 지침을 읽기 전용으로 가져와 리뷰에 적용하고 출처·버전을 표시한다. 이어서 기존 자동 리뷰와 hook 전달 경로를 Windows에 맞게 이식한다.

GCR 웹 접속과 GCR 서버의 Windows 네이티브 실행은 별개다. 이번 서버는 기존 Linux/container 배포를 사용한다. 변경 대상은 GCR 저장소에 있는 공통 client·executor·private CLI package와 CD 확장이다. 서버를 Windows 서비스로 이식하거나 PostgreSQL·Keycloak·Helm 구성을 바꾸지 않는다.

첫 지원 대상은 **Windows 네이티브 Extension Host + 로컬 NTFS checkout**이다. 대상 machine에서 OS build·CPU·Node·VS Code architecture를 기록해 검증한 조합을 지원표에 명시한다. x64와 ARM64를 같은 검증 결과로 취급하지 않는다. WSL·Remote SSH·Dev Container·UNC/network drive·이동식 FAT 저장소는 이번 완료 조건에서 제외하고 미지원/미검증 상태를 구분한다. WSL 사용을 Windows 네이티브 지원의 대체 증거로 삼지 않는다.

수동 리뷰의 실제 사용을 우선한다. W01은 최소 리뷰까지, W02는 중앙 자료 활용까지 끝낸다. 자동 리뷰 이식 때문에 수동 리뷰 전달을 지연하지 않는다. 다만 W01/W02만 완료한 상태를 Windows 전체 기능 지원으로 표시하지 않는다.

## 인계 기준

| 대상 | 원격 저장소·기준 branch | 문서 작성 직전 기준 SHA |
| --- | --- | --- |
| GCR | `https://github.com/pydemia/git-code-reviewer.git` · `codex/review-memory-pull-g01` | `f40e0437a79ffb7fcecb6a089abfde2c2a7ba522` |
| CD | `https://github.com/pydemia/commit-defender.git` · `codex/review-memory-pull-g03` | `708710178ae1c47cd89e822d7d982fe437a8e5fd` |

위 SHA는 최소 기준이다. 이 계획과 CD 인계 문서를 포함한 원격 branch의 최신 상태를 fetch하고 기준 SHA가 조상인지 확인한다. 원격 branch가 바뀌었으면 차이를 확인하고 실제 시작 SHA를 기록한다. 사용자 변경을 reset/clean/stash로 일괄 정리하지 않는다. 변경이 있는 checkout은 보존하고 별도 worktree를 사용한다.

두 저장소 모두 새 branch 이름은 `codex/windows-native-support`로 한다. 같은 이름이 이미 있으면 기존 작업을 확인해 이어가며 `switch -C`로 덮어쓰지 않는다. Mac의 `/Users/...` 경로는 Windows 실행 경로로 복사하지 않는다.

기존 검증·설치 기준:

- [G01–G04 계획](review-memory-pull-implementation-plan.md), [G03](execution/review-memory-pull/G03.md), [G04](execution/review-memory-pull/G04.md)를 먼저 읽는다. 이미 검증한 서버 동작을 다시 개발하지 않는다.
- 공통 client 3종 `0.1.0-alpha.42`, private service `0.1.0-alpha.37`, Mac 설치 VSIX `2.11.3`.
- [문서 보강 기록](execution/product-documentation/2026-09-16.md)의 UI 변경은 source/build에만 반영됐다. 기존 설치 VSIX에 포함됐다고 간주하지 않는다.
- PRISM-DEV의 기록상 기준은 runtime `0.8.0-alpha.63`, chart `0.10.59`, Helm revision `73`. Windows에서 필요한 서버 URL·CA·reader 접근만 확인한다.
- 기존 PR #917·#915와 출처 연결 지침을 재사용한다. URL·repository ID·guidance ID·revision은 G02/G04 기록 및 현재 reader 응답으로 확인한다. 새 수집·새 PR·외부 댓글 게시를 하지 않는다.
- 모델 검증은 Windows의 기존 기본 Codex 계정에서 `gpt-5.6-luna` / `high`를 우선한다. 실제 계정에서 사용할 수 없으면 대체 모델을 임의 선택하지 않고 그 선택만 확인한다. 다른 PC의 auth.json이나 이 대화의 비밀번호를 복사하지 않는다.

## 확인된 구현 장벽

아래는 macOS에서 코드를 확인한 결과다. Windows에서 직접 발생시킨 오류와 구분한다.

| 경로: GCR 저장소 기준 | 확인한 제약 | 필요한 변경 |
| --- | --- | --- |
| `packages/client-core/src/local-identity.ts` | 데이터 경로가 darwin/linux만 허용 | Windows 사용자 전용 데이터 위치와 안정된 profile/worktree identity |
| `packages/client-core/src/local-credentials.ts` | master key와 중앙 API key 모두 Keychain/Secret Service만 지원 | Windows 사용자 범위의 보안 저장소. 모델 API credential이 사용하는 저장 경로도 함께 대조 |
| `packages/client-core/src/private-files.ts` | uid·POSIX mode·O_NOFOLLOW·directory fsync·hard link 전제 | NTFS ACL, reparse point, 원자성·충돌·복구를 실제 Windows 의미에 맞게 구현 |
| `packages/client-core/src/source-snapshot.ts` | realpath 비교·파일 open flag·경로/내용 고정 | drive/case/separator/CRLF/junction 처리와 민감 파일 제외 유지 |
| `packages/client-executors/src/process.ts` | darwin/linux 제한, 음수 PID process group 종료 | Windows 자식 process tree 수명·취소·timeout·출력 제한 |
| `packages/client-executors/src/codex.ts`, `codex-isolation.ts` | Codex 준비 단계가 darwin만 허용, sandbox-exec로 전역 AGENTS 읽기 차단 | 기존 계정을 유지하면서 동등한 고정 문맥·tool 제한을 제공하는 Windows 실행 경계 |
| `packages/client-executors/src/catalog-probe.ts` | POSIX PATH 등 환경 전제 | Windows 실행 환경과 실제 Codex version/catalog probe |
| `packages/client-core/src/local-service.ts` | win32 거부, Unix domain socket·uid·chmod 사용 | 사용자 범위 IPC, 서비스 소유권·복구·종료 |
| `scripts/client-packages.mjs`, `scripts/cli-package.mjs` | pnpm/npm 직접 exec, tar·파일목록·bundle 가정 점검 필요 | Windows build/pack, helper 포함 검사와 provenance |

CD 저장소에서는 `vscode-extension/src/standaloneReview.ts`가 중앙 연결이 없는 수동 리뷰에서도 `LocalRecordStore.open`을 호출한다. 저장소 구현을 건너뛰어 Windows 리뷰만 성공시키면 안 된다. `src/backgroundHooks.ts`의 uid 검사와 `/usr/bin/which`, `src/hook/managedHooks.ts`의 win32 거부·POSIX hook 생성도 수정 대상이다. `.cmd` 탐색만 추가해서 해결되는 문제가 아니다.

## 구현 원칙과 Windows 선택 사항

### 보안 저장소·파일

기존 `LocalKeyStore`와 credential port를 유지한다. Windows Credential Manager 또는 **사용자 범위 DPAPI로 보호한 blob + 사용자 ACL**을 사용할 수 있다. W01 첫 commit에서 실제 machine의 지원 방식·배포 의존성·read/write/remove·장애 의미를 짧게 결정하고 하나로 구현한다. 중앙 key와 master key의 namespace를 분리한다.

DPAPI는 기본적으로 로그인 사용자에 결합되며 `CRYPTPROTECT_LOCAL_MACHINE`은 사용자 경계를 넓힌다. 후자는 사용하지 않는다. 이 근거는 [Microsoft CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)를 따른다. `%LOCALAPPDATA%` 아래의 CD 전용 경로를 기본 후보로 삼되 환경변수의 존재만으로 안전성을 판정하지 않는다.

Windows에서 chmod를 호출한 것만으로 전용 권한을 검증했다고 기록하지 않는다. 다른 일반 사용자 SID·상속 ACL·junction/reparse point·경로 교체를 검사한다. 같은 Windows 사용자로 실행되는 임의 프로그램이나 관리자 전체를 방어한다고 주장하지 않는다. 기존 파일의 ACL을 재귀 변경하지 않고 CD가 소유한 신규 경로만 다룬다. 원자적 생성, concurrent create/CAS, partial write, 공유 잠금·백신으로 인한 일시 오류와 중단 후 복구를 검증한다. directory fsync가 지원되지 않는 경우 차이를 명시하고 오류를 무조건 삼키는 방식은 쓰지 않는다.

helper가 필요하면 범용 플랫폼 framework를 만들지 말고 필요한 OS primitive만 고정 인터페이스로 제공한다. helper의 소스·버전·hash·license와 대상 architecture를 artifact에 포함한다. 비밀은 argv·환경변수·로그·평문 임시 파일로 전달하지 않는다. 고정 helper의 bounded stdin/stdout protocol을 사용할 수 있으며 동적 PowerShell 문자열에 비밀이나 경로를 삽입하지 않는다. 실행 정책을 전역 완화하거나 관리자 실행을 기본 조건으로 만들지 않는다. 회사 정책이 helper를 막으면 오류와 지원 조건을 명시한다.

### 모델 프로세스와 고정 문맥

선택한 계정·실행 파일·provider·모델·reasoning을 유지한다. 인증을 재사용한다는 이유로 전역 CODEX_HOME·AGENTS·사용자 설정을 수정하거나 auth 파일을 검증 자료에 복사하지 않는다. 임시 디렉터리만 바꿔 실행하는 것으로 기존 전역 지침 차단과 동등하다고 판단하지 않는다.

현재 Codex 버전 제한과 catalog probe의 이유를 먼저 확인한다. Windows CLI가 지원하는 실행별 설정 또는 제한된 프로세스 경계로 전역 지침·임의 도구의 유입을 차단할 수 있는지 조사하고 marker fixture로 입증한다. 모델에는 기존 fixed-source bridge에서 허용한 자료만 제공한다. 단순히 `darwin` 검사를 삭제하거나 sandbox를 끄는 수정은 완료로 인정하지 않는다. 안전한 계정 실행이 불가능하면 Codex 항목을 미완료로 남기고 원인·필요 결정을 기록한다. 독립적인 저장·API provider 회귀 작업은 계속할 수 있다.

실행 파일 경로의 공백·한글, `.exe`와 package-manager wrapper, 환경변수 이름의 대소문자, 필수 Windows 환경변수 전달을 검사한다. `.cmd/.bat`는 `execFile`로 직접 실행할 수 없으므로 선택된 실제 executable 또는 고정 Node entrypoint 해석을 우선한다. shell 호출이 필요한 경로는 별도로 검증하며 `shell:true` 일괄 전환을 하지 않는다. [Node child_process 문서](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)

timeout·취소·부모 종료에서 소유한 자식과 손자 프로세스까지 종료해야 한다. Windows Job Object를 우선 검토하되 process group과 같은 의미라고 가정하지 않는다. [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects). 사용자의 다른 Codex·Node·VS Code 프로세스를 이름으로 일괄 종료하지 않는다.

### 기존 자동 리뷰

Unix socket을 Windows named pipe 등 로컬 IPC로 바꾸되 이름을 복잡하게 만드는 것만으로 인가를 대신하지 않는다. 사용자 SID·profile·데이터 경로별 충돌을 막고 다른 일반 사용자와 허가되지 않은 클라이언트의 호출을 거부한다. 기본 named pipe DACL에 기대지 말고 실제 접근 경계를 검증한다. [Microsoft Named Pipe Security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)

기존 Git for Windows hook 실행 환경에서 경로 변환·quoting·CRLF·worktree·core.hooksPath를 확인한다. 기존 hook을 삭제하거나 덮어쓰지 않고 부착·해제 뒤 원래 동작을 복원한다. 기존 Save/Stage/Commit/Push opt-in만 이식한다. Windows Service 설치, 로그인 자동 시작, 새 trigger와 자동화 확대는 제외한다.

## Phase와 commit 계획

각 phase는 별도 goal로 실행하고 완료 후 멈춘다. 테스트만을 위한 framework나 긴 사전 조사 phase를 만들지 않는다. 표의 commit은 논리적 분리 기준이며 결함 수정은 해당 단계에 포함한다. 실제 SHA는 실행 기록에 남긴다.

### W01 — Windows 수동 리뷰 완성

**결과:** 중앙 연결 없이 Windows 실제 Extension Host에서 기존 Codex 계정으로 최소 리뷰 1건을 완료하고 결과를 다시 조회한다.

| Commit | 저장소·작업 | 완료 근거 |
| --- | --- | --- |
| W01-C01 | GCR docs: machine·시작 SHA·현재 실패·OS primitive 선택 기록 | OS/CPU/VS Code/Node/Git/Codex versions, 계정은 비식별 상태만 기록. 비밀 없는 최소 재현 |
| W01-C02 | GCR core: Windows 데이터 경로·private files·key/credential adapter | 같은 사용자의 Host/worker/headless 접근, 다른 사용자 거부, 손상·권한 오류, 동시성·복구 |
| W01-C03 | GCR executors/core: Windows process tree·실행 파일·고정 문맥·snapshot | 실제 native process fixture의 취소/timeout/후손 정리, 외부 지침 유입 차단, 민감 파일·경로 경계 |
| W01-C04 | CD source: 기존 provider와 공통 리뷰에 Windows 경로 연결 | staged/current-file 리뷰, 오류 구분, 계정·모델·자동 설정 불변, 저장 결과 재조회 |
| W01-C05 | GCR/CD packaging: 고정 client artifact와 개발용 VSIX | 새 package version, source/hash 연결, clean consumer, Windows Host 설치·실행 |
| W01-C06 | 양쪽 docs: 실제 결과·제한·수동 리뷰 사용법 | 실제 모델 결과와 합성 fixture 구분, 설치/열린 Host 적용 상태 기록 |

착수 점검은 Windows의 차단 경로를 재현하는 데 필요한 항목만 수행한다. 우선 저장소와 Codex 격리 경로의 성립 여부를 확인하고 자동 service로 범위를 넓히지 않는다. 초기 실제 모델 호출은 **최소 결함 fixture 1회, 최대 240초**로 기록한다. 기존 모델이 부적합하면 필요한 선택만 확인한다. timeout·partial·실패는 완료 건수에 넣지 않는다.

### W02 — 중앙 pulling과 관련 지침 적용

**의존성:** W01. **결과:** Windows에서 원문 → 지침 → pulling → 로컬 리뷰 → 출처 표시를 확인한다.

| Commit | 저장소·작업 | 완료 근거 |
| --- | --- | --- |
| W02-C01 | GCR core / CD: 필요한 reader credential·CA·cache 경로 수정 | HTTPS/CA 검증, 재시작 후 credential 접근, 사용자·repository·profile 경계 |
| W02-C02 | CD 검증: 이력 조회와 source-history 문맥 통합 | 기존 #917/#915의 원문·답글·본문 버전·출처, 현재 활성 지침·revision, 리뷰 중 버전 고정 |
| W02-C03 | 필요한 artifact/VSIX만 새 버전으로 전달 | 제품 수정이 없다면 W01 artifact 재사용. runtime 수정 없으면 Helm 배포 없음 |
| W02-C04 | 양쪽 docs: 실제 세 사례 결과·통신 관찰·운영 절차 | 기대 결과와 적용/충족/제외 판단 및 source ID/URL/hash 대조 |

실제 모델은 결함이 있는 변경, 수정된 변경, 무관한 변경을 각각 1회씩 호출한다. 초기 한도는 **총 3회, 회당 240초**다. 사례별 기대 결과와 호출부·계약·경계값 테스트 등 고정 문맥을 먼저 기록한다. G04 fixture를 우선 재사용한다. 자료를 넣었다는 metadata와 실제 판단에 활용했다는 응답을 구분한다.

GCR 통신은 서버가 이미 아는 repository/PR/history ID·cursor/revision의 읽기 요청으로 제한한다. source/diff/질문/결과/개인 memory를 올리지 않는다. 선택한 provider로 보내는 모델 요청은 별도로 관찰한다. 중앙 자료 없음·서버 장애·403/철회·만료·모델 실패를 구분한다. 현재 온라인 manifest 5분 제한과 signed offline lease를 유지하며 시험을 통과시키려고 유효기간을 늘리거나 무효 자료를 재사용하지 않는다. 테스트가 실제 계정의 권한 철회를 필요로 하면 사용자 운영 key 대신 검증용 reader credential만 사용한다.

### W03 — 기존 자동 서비스와 Git hook 이식

**의존성:** W01·W02. **결과:** 기존 opt-in 자동 리뷰를 Windows에서도 같은 범위로 사용한다.

| Commit | 저장소·작업 | 완료 근거 |
| --- | --- | --- |
| W03-C01 | GCR core/CLI: Windows IPC·서비스 ownership·수명 관리 | 같은 사용자 접속, 다른 사용자 거부, 중복 기동·stale 상태·중단 후 복구 |
| W03-C02 | CD: service 시작·실행 파일 탐색·managed hooks | Git for Windows native hook 전달, 공백/한글/worktree/core.hooksPath, 기존 hook 보존·해제 |
| W03-C03 | 회귀: Save/Stage/Commit/Push·수동 우선·취소 | opt-in 유지, 중복 억제, 실패를 성공으로 표시하지 않음, 사용자 다른 프로세스 보존 |
| W03-C04 | packaging/docs: 새 private service·VSIX·사용 절차 | source/artifact 연결, 서비스 구버전/신버전과 열린 Host의 차이 표시 |

trigger matrix는 합성 executor로 먼저 검증한다. 실제 native 서비스에서 Codex 실행까지 확인하는 호출은 **1회, 최대 240초**를 초기 한도로 한다. 사용자의 실제 저장소에서 commit/push를 만들어 시험하지 말고 임시 repo와 로컬 bare remote를 사용한다. 기존 legacy Python hook의 별도 기능 확장은 하지 않는다.

### W04 — Windows 전달과 플랫폼 회귀

**의존성:** W01–W03. **결과:** 검증한 Windows 조합에 설치 가능한 VSIX와 지원표·사용법을 전달한다.

| Commit | 저장소·작업 | 완료 근거 |
| --- | --- | --- |
| W04-C01 | 관련 코드의 최종 결함만 수정, 플랫폼 fixture 정리 | Windows native + 영향받은 macOS/Linux 회귀. shebang/chmod mock을 Windows 성공 증거로 쓰지 않음 |
| W04-C02 | GCR package: 버전·helper·manifest·provenance | client 3종 version 정합성, private CLI 의존성, clean consumer, 기존 OS 경로 유지 |
| W04-C03 | CD package: vendor·lockfile·bundle·VSIX | 설치 artifact SHA256과 포함 package 버전/파일 대조. native helper가 있으면 검증 architecture별 packaging |
| W04-C04 | 양쪽 docs: Windows 설치/지원표·최종 실행 기록 | W-A01–W-A10 판정, 실제 Host 버전, 미지원/미검증 환경과 복구 절차 |

W01/W02의 실제 모델 결과를 재사용한다. 이후 실행 코드가 바뀌면 영향받은 사례만 추가 한도를 기록해 다시 실행한다. 문서만 바뀌면 같은 제품을 재빌드·재배포하지 않는다. 현재 2.11.3/client alpha.42/service alpha.37 artifact를 덮어쓰지 않는다. 기존 package script의 파일 allowlist가 native helper를 누락하거나 광범위하게 포함하지 않는지도 검사한다.

macOS/Linux 실행 환경이 없으면 해당 회귀를 수행하지 않았다고 기록하고 독립 작업은 끝낸다. 공통 보안·실행 코드 변경의 필수 회귀가 남아 있으면 Windows 전체 지원 goal을 완료 처리하지 않는다. 원격 CI를 사용하려면 저장소의 기존 실행 권한·workflow를 따른다. 새 CI/배포 플랫폼 구축으로 확대하지 않는다.

## 최종 수용 기준

| ID | 검증 항목 | 필요한 증거 |
| --- | --- | --- |
| W-A01 | 비관리자 Windows 설치·활성화 | native OS/CPU/VS Code 조합, VSIX 설치·실제 Extension Host 버전. WSL 결과와 분리 |
| W-A02 | 보안 저장·인가 경계 | master/model/reader credential의 저장·재시작·삭제·손상 처리, 다른 일반 사용자 접근 거부, 평문 누출 없음 |
| W-A03 | 파일·snapshot·로컬 context | NTFS ACL/reparse, 한글·공백·drive/case·CRLF, 민감 파일 제외, worktree 격리·버전 고정 |
| W-A04 | 선택한 provider의 수동 리뷰 | 기존 Codex 계정·Luna/high 또는 사용자가 지정한 대체 모델의 실제 성공, API provider adapter 회귀, silent fallback 없음 |
| W-A05 | 프로세스 격리·취소·실패 | 전역 지침 marker 유입 차단, 도구 catalog 제한, timeout/abort/crash 시 자식·손자 종료, 다른 실행 보존 |
| W-A06 | 중앙 원문·지침 pulling | reader API와 PR #917/#915 대조, TLS/CA, 캐시·403/철회·만료, 중앙 단방향 요청 관찰 |
| W-A07 | 과거 지침의 실제 판단 | 결함/수정/무관 세 사례의 기대 결과·실제 결과·출처/버전, 부적절한 과거 지적 반복 여부 |
| W-A08 | 기존 자동 리뷰 | native IPC·접근 경계·복구·기존 trigger·hook 원상 보존, 실제 서비스 모델 실행 1건 |
| W-A09 | 기존 플랫폼 보존 | 영향받은 macOS/Linux 저장·실행·서비스 회귀. Mac 전용 Codex와 Linux API adapter의 기존 지원 범위를 구분 |
| W-A10 | 전달·문서·정리 | 두 source SHA, client/service/helper 버전·hash, VSIX, 설치/열린 Host 상태, 임시 credential/session/process 정리 |

OS 보안 경계는 `process.platform` 문자열 mock만으로 통과시키지 않는다. 다른 Windows 사용자 접근 시험을 할 계정이 없으면 사용자 승인 없이 OS 계정을 만들지 말고 해당 검증에 필요한 계정만 요청한다. 실제 모델·외부 연결·네이티브 OS 경계·합성 회귀 증거는 별도로 표기한다.

모든 phase에서 추가 모델 호출 전 실패 원인, 변경 사항, 재검증 대상, 추가 횟수·timeout을 기록한다. 자동 무한 재시도는 하지 않는다. 기본 호출 예산은 W01 1회 + W02 3회 + W03 1회이며 W04는 근거 재사용을 기본으로 한다.

## 다른 Windows 세션에서 시작하는 방법

두 저장소를 같은 부모 디렉터리 아래 별도 checkout으로 준비한다. 아래는 **아직 존재하지 않는 디렉터리에 새로 clone하는 예시**다. 기존 checkout이 있으면 그대로 실행하지 말고 상태를 확인해 worktree를 만든다. 경로·실행 정책·계정·credential을 전역 변경하지 않는다.

```powershell
# 원하는 작업 부모 디렉터리에서 실행
git clone --branch codex/review-memory-pull-g01 https://github.com/pydemia/git-code-reviewer.git git-code-reviewer-windows
git clone --branch codex/review-memory-pull-g03 https://github.com/pydemia/commit-defender.git commit-defender-windows
git -C git-code-reviewer-windows merge-base --is-ancestor f40e0437a79ffb7fcecb6a089abfde2c2a7ba522 HEAD
if ($LASTEXITCODE -ne 0) { throw 'GCR baseline mismatch' }
git -C commit-defender-windows merge-base --is-ancestor 708710178ae1c47cd89e822d7d982fe437a8e5fd HEAD
if ($LASTEXITCODE -ne 0) { throw 'CD baseline mismatch' }
git -C git-code-reviewer-windows switch -c codex/windows-native-support
git -C commit-defender-windows switch -c codex/windows-native-support
```

GCR 개발 toolchain은 Node 22.12 이상·pnpm 10.17.1, CD는 lockfile 기반 npm 설치를 기준으로 현재 manifest를 대조한다. 확장 runtime과 빌드용 Node를 혼동하지 않는다. 최초 준비에서 `pnpm install --frozen-lockfile`, CD `vscode-extension`의 `npm ci`를 사용하되 Windows에서 실패하면 command wrapper 등 원인을 먼저 고친다. 최신 dependency로 일괄 갱신하지 않는다.

Windows에서 `PRISM-DEV` DNS·VPN·CA가 없을 수 있다. 서버 URL과 CA는 기존 운영 연결 JSON으로 준비하고 reader key는 별도 보안 입력으로 전달한다. 접속이 안 되면 W01을 계속하고 W02에 필요한 연결 정보만 확인한다. 중앙 장애를 우회하려고 TLS 검증을 끄거나 서버를 새로 배포하지 않는다.

실행 기록은 GCR `.documents/execution/windows-support/W01.md`부터 W04까지 작성한다. CD `.documents/execution/windows-support/`에는 해당 source·vendor·VSIX·Host 근거를 연결한다. 비밀 없는 요약·작은 JSON은 commit하고 auth·key·개인 대화·모델에 보낸 민감 source는 제외한다. source·docs·packaging 변경을 구분해 commit·push한다. 이번 계획 작성은 구현 goal 시작이나 Marketplace 게시 요청이 아니다.

### 첫 goal 명령

아래의 `<GCR 경로>`와 `<CD 경로>`를 Windows의 실제 절대 경로로 바꿔 새 세션에서 실행한다. branch 준비를 하지 않은 경우 해당 세션이 위 기준에서 안전하게 분리한다.

```text
/goal
<GCR 경로>/.documents/windows-support-implementation-plan.md의 W01만 실행해 줘.

GCR 작업 위치는 <GCR 경로>, CD 작업 위치는 <CD 경로>야.
두 저장소는 codex/windows-native-support branch를 사용해 줘.
계획의 최소 기준 SHA와 최신 원격 상태, G03/G04 기록을 확인하고
기존 변경·데이터·계정·사용자 설정을 보존한 뒤 이어서 진행해 줘.

Windows 네이티브에서 보안 저장소·파일 경계·프로세스 수명과
Codex 고정 문맥 격리를 구현하고 실제 Extension Host에서 수동 리뷰를 확인해 줘.
OS 제한 검사만 제거하거나 plaintext 저장·shell 일괄 실행·격리 해제로 우회하지 마.
기존 기본 Codex 계정의 gpt-5.6-luna / high를 우선 사용하고
실제 호출은 최소 결함 fixture 1회, 최대 240초를 초기 한도로 먼저 기록해 줘.
사용할 수 없는 경우 모델을 임의로 바꾸지 말고 필요한 선택만 확인해 줘.
실패하면 원인을 확인하고 추가 호출의 수정 내용·대상·한도를 기록해 줘.

필요한 공통 package를 새 버전의 고정 artifact로 만들고
개발용 VSIX 빌드·패키징·로컬 설치·실제 Host 검증까지 진행해 줘.
source·문서·packaging을 구분해 commit·push하고 W01 실행 기록을 남겨 줘.
전역 계정·설정·CLI 교체나 강제 VS Code 재로드는 하지 마.
새로운 중앙 업로드, 서버 모델 대행, P11 runner, W02–W04,
PRISM-DEV 변경과 Marketplace 게시는 시작하지 마.
W01 완료 조건을 충족하면 결과·설치 상태·남은 제한을 보고하고 멈춰 줘.
```
