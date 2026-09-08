# Interactive Review Chat 운영

기본 flag는 꺼져 있다. 등록 ChatGPT account와 exact snapshot이 있는 Review에서 활성화한다. `chatAgent.allowedUserIds`에 검증 사용자 UUID를 넣어 canary를 제한하고 실제 모델 검증 후 빈 배열로 모든 허용 사용자에게 제공한다. 설정 변경은 Server 재시작 후 반영된다. 기존 canonical report와 GitHub 게시 동작은 변경하지 않는다.

## 실행

Docker Compose는 native CPU architecture에서 `CHAT_AGENT_ENABLED=true MODEL_ADMISSION_ENABLED=true docker compose --profile agent up --build -d`로 실행한다. 먼저 로컬 `.env`에 `GITHUB_MODE=registry`, `CHAT_MODEL_MODE=registry`, `CREDENTIAL_REGISTRY_ENABLED=true`, `MODEL_ADMIN_ENABLED=true`와 직접 생성한 32-byte base64 `CREDENTIAL_ENCRYPTION_KEY`를 설정하고 UI에서 GitHub·ChatGPT account를 등록한다. Key는 volume의 기존 credential을 복호화하는 데 필요하므로 재시작 때 바꾸거나 Git에 넣지 않는다. PostgreSQL host port는 기존 25432다. macOS의 VS Code Full Development Stack은 `sandbox-exec`로 source 도구를 실행한다. Linux native launch에는 별도 broker socket이 필요하며 격리 환경이 없으면 도구 실행을 거부한다. Apple Silicon의 amd64 에뮬레이션에서 seccomp를 사용할 수 없는 경우 native arm64 image를 사용한다. 격리를 끄는 fallback은 없다.

Helm의 `chatAgent.enabled`와 `modelAdmission.enabled`를 설정한다. 기존 release upgrade에서 `--reuse-values`만 사용하면 새 values가 없을 수 있으므로 `chatAgent`와 `modelAdmission` 전체 설정을 override 파일에 포함한다. Worker의 source-sandbox는 DB·GitHub·모델 Secret 및 service account token을 받지 않는다. Broker에만 chroot·UID 전환·장치 생성 등의 제한된 capability를 부여한다. 자식 도구는 chroot 안에서 UID/GID 65534, no-new-privileges, seccomp로 실행하고 실제 파일은 root 소유 읽기 전용이다. 네트워크 socket 생성, ptrace, process memory, mount와 namespace 진입을 차단한다.

## 한도와 복구

- `CHAT_AGENT_MAX_MODEL_CALLS=8`, `CHAT_AGENT_MAX_TOOL_CALLS=24`, `CHAT_AGENT_CONTEXT_BYTES=131072`. 설정은 실행 시작 시 고정한다.
- 계정별 inference 동시 1개, 분당 60개·serialized input 합계 1 MiB. 같은 ChatGPT upstream account ID로 묶는다. 정확한 token quota는 아니며 제공자가 보낸 usage는 가능한 경우 ledger에 기록한다.
- 실제 요청마다 영속 ledger를 기록하고 전송 이후 실패·401 재시도도 예산에 포함한다. 429는 Retry-After를 3초–30분 안에서 적용한다. 헤더가 없으면 30초 대기한다. 새 Chat은 Worker slot을 반환하고 `waiting_capacity`로 재개한다. 기존 자동 분석·legacy Chat은 최대 2분 안에서 대기한다.
- 실행 lease는 30초, heartbeat 5초와 fence로 오래된 Worker의 저장을 막는다. 실행 attempt의 active timeout은 10분, run 만료는 24시간, 사용자 질문은 30분이다. 중단은 최대 다음 heartbeat에 모델을 abort한다. clone 준비가 이미 시작되었다면 그 subprocess의 timeout까지 정리가 늦어질 수 있다.
- workspace는 사용자·session·attempt·snapshot·credential version별로 분리한다. revision은 정확한 SHA로 fetch하며 shallow depth는 64다. worktree 파일은 Git blob에서 복원해 checkout filter를 실행하지 않는다. symlink·submodule·1 MiB 초과 파일은 materialize하지 않는다. LFS 대용량 객체는 다운로드하지 않는다.
- workspace 상한 기본 2 GiB, file entry 최대 50,000. fetch 후와 파일 생성 중 quota를 검사한다. fetch 도중 일시적인 초과를 막는 최종 경계는 Kubernetes volume size limit이다. 전체 캐시는 최대 3개 workspace 예산으로 admission하며 준비는 Worker process당 직렬이다. 30분 미사용 캐시를 다음 준비 때 정리하고 broker의 jail도 idle TTL로 정리한다. 명시적인 DB workspace lease나 공용 mirror는 아직 없다.
- source 본문·메타데이터는 run checkpoint와 같은 트랜잭션으로 DB에 저장하고 session 삭제 시 cascade한다. 사용자/repo 권한 철회 시 다음 도구·모델 단계와 source API에서 다시 검사한다. 원본 캐시의 즉시 물리 삭제 대신 접근 차단과 TTL을 사용한다. 자동 분석의 추가 source는 기존 artifact retention을 따른다.

## 검증과 관찰

`GCR_TEST_DATABASE_URL`에 격리된 local PostgreSQL을 지정하고 `pnpm test`를 실행한다. `deploy/sandbox/verify.mjs`는 native Docker에서 실제 Git과 쓰기·탈출·프로세스·네트워크 차단을 검증한다. `kernel-probe.mjs`는 별도 임시 Kubernetes Pod에서 같은 검증을 수행하는 도구이며 운영 Secret을 주입하지 않는다.

`chat_runs`의 status·fence·model_calls·tool_calls·error_code, `chat_run_steps`, `model_request_ledger`, `model_account_capacity`로 진단한다. SSE는 event ID 이후 DB event를 다시 읽고 UI가 3초 polling으로 보완한다. 사용자 입력과 source 본문, credential은 로그에 출력하지 않는다.

문제 발생 시 새 실행 flag를 끄기 전에 활성 run을 중단하거나 완료시킨다. `CHAT_AGENT_ENABLED=false`이면 Worker가 새 queue를 claim하지 않으므로 기존 queued/awaiting 상태는 남아 있으며 재활성화하면 만료 정책에 따라 회수된다. UI는 legacy Chat으로 돌아간다. 기존 report·message와 additive migration은 유지하고 downgrade를 위해 테이블을 삭제하지 않는다.

## 이번 릴리스에서 남긴 범위

P0–P5의 사용자 경로를 우선 구현했다. 기존 snapshot diff materializer는 그대로 두었고 자동 분석의 추가 context와 Chat만 공통 source provider를 사용한다. `find_related_code`는 문자열 기반 후보 검색이며 완전한 symbol call graph가 아니다. UI는 최신 run과 입력 초안을 복구하지만 모든 과거 run의 source 탭과 장기 대화 압축은 제공하지 않는다. 호출·입력 byte 제한은 비용과 재시도를 제한하지만 모든 모델 실패를 방지하지 않는다.
