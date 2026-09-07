# Local development

로컬 개발은 전체 container stack, host process, VS Code debugger 중 하나를 선택할 수 있다. `compose.yaml`은 PostgreSQL, migration, Server와 Worker를 함께 실행한다. `compose.dev.yaml`은 기존처럼 PostgreSQL만 실행한다.

## Prerequisites

- Node.js 22 이상
- pnpm 10.17.1
- Docker Engine과 Compose
- Git

## Portable Docker Compose

Node.js나 pnpm을 host에 설치하지 않고 fixture repository로 전체 흐름을 확인하려면 repository root에서 실행한다.

```bash
docker compose up --build --wait
open http://127.0.0.1:4000
```

Server와 Worker는 같은 local image와 artifact volume을 사용한다. Compose는 현재 source에서 host와 같은 architecture의 image를 빌드한다. Migration service가 성공한 뒤 두 process가 시작된다. 기본 설정은 development authentication, local authorization, fixture GitHub와 비활성 model이다. Port와 개발용 PostgreSQL password는 필요할 때 바꿀 수 있다.

```bash
APP_PORT=4400 POSTGRES_PORT=55433 POSTGRES_PASSWORD=local-password \
  docker compose up --build --wait
```

`POSTGRES_PASSWORD`를 바꾸면 VS Code의 기본 `DATABASE_URL`과 일치하지 않으므로 debugger에서는 기본값을 사용하거나 `.vscode/launch.json`의 local 값을 함께 조정한다. 실제 GHES credential이나 model API key를 compose 파일에 기록하지 않는다.

TLS inspection 환경에서는 승인된 사내 CA를 `BUILD_CA_CERT`에 넣는다. Compose가 이 값을 BuildKit secret으로 전달하므로 최종 image에는 남지 않는다.

```bash
export BUILD_CA_CERT="$(cat /absolute/path/corporate-ca.crt)"
docker compose up --build --wait
```

상태와 log는 다음 명령으로 확인한다.

```bash
docker compose ps
docker compose logs -f server worker
curl -fsS http://127.0.0.1:4000/health/ready
```

## Host process development

```bash
export POSTGRES_PASSWORD='local-only-password'
export POSTGRES_PORT=25432
docker compose -f compose.dev.yaml up -d postgres
docker compose -f compose.dev.yaml ps
```

`.env.example`을 기준으로 gitignored `.env`를 준비한다. `DATABASE_URL`의 password와 port는 위 값에 맞춘다. 이 application은 `.env`를 자동으로 읽지 않으므로 shell에 명시적으로 export한다.

```bash
set -a
source .env
set +a
corepack pnpm install --frozen-lockfile
pnpm migrate
```

## Run the service

세 개의 terminal을 사용한다.

```bash
# Terminal 1: PostgreSQL은 계속 실행 중이어야 한다.
docker compose -f compose.dev.yaml logs -f postgres

# Terminal 2: API와 Vite client
set -a; source .env; set +a
pnpm dev

# Terminal 3: snapshot/analysis worker
set -a; source .env; set +a
pnpm build:packages
pnpm --filter @gcr/runtime exec tsx src/index.ts worker
```

Browser workspace는 `http://127.0.0.1:5173`에서 연다. `GITHUB_MODE=fixture`, `DEV_USER_ROLE=admin`이면 fixture repository와 PR이 자동 준비되고 `/admin`에서 tenant, user membership, 분석 Provider와 tenant별 prompt를 관리할 수 있다. 첫 PR에서 refresh를 실행하면 별도 Worker가 snapshot과 report를 생성한다.

## VS Code debugger

Repository folder를 VS Code에서 연 뒤 `Run and Debug`에서 `GCR: Full Development Stack`을 실행한다. 이 compound는 Server, Worker와 Vite client를 각각 debugger로 시작하고 `http://127.0.0.1:5173`을 연다.

- Compound의 pre-launch task가 PostgreSQL 시작, package build와 migration을 순서대로 실행한다.
- `GCR: Server`는 API와 browser application backend를 실행한다.
- `GCR: Worker`는 snapshot과 분석 job을 별도 Node debugger에서 실행한다.
- `GCR: Web`은 Vite client를 실행하고 API를 port 4000으로 proxy한다.
- `GCR: Current Test File`은 현재 editor의 Vitest file만 debugger로 실행한다.

처음 실행하기 전에 `corepack pnpm install --frozen-lockfile`을 한 번 수행한다. VS Code 설정은 fixture mode와 비활성 model을 기본값으로 사용하며 credential을 포함하지 않는다.

개별 Server나 Worker 구성만 실행할 때는 먼저 `Tasks: Run Task`에서 `GCR: Prepare Runtime`을 실행한다.

로컬 인가 정책을 실제 Cerbos로 확인할 때에는 정책 compile을 먼저 실행하고 PDP를 띄운다.

```bash
docker run --rm \
  -v "$PWD/deploy/helm/git-code-reviewer/cerbos/policies:/policies:ro" \
  ghcr.io/cerbos/cerbos:0.55.0 compile --strict-evaluation /policies

docker run --rm --name git-code-reviewer-cerbos -p 3592:3592 \
  -v "$PWD/deploy/helm/git-code-reviewer/cerbos/policies:/policies:ro" \
  ghcr.io/cerbos/cerbos:0.55.0
```

```dotenv
AUTHORIZATION_MODE=cerbos
CERBOS_URL=http://127.0.0.1:3592/
```

## Model setup

Model을 사용하지 않으면 `MODEL_MODE=disabled`, `CHAT_MODEL_MODE=disabled`로 둔다. OpenAI-compatible mode를 활성화할 때는 endpoint, API key뿐 아니라 model name을 반드시 명시한다. Server 시작 시 Chat 설정을, Worker 시작 시 분석 설정을 검증하므로 name 누락은 즉시 실패한다.

Gemini OpenAI compatibility를 사용할 때 현재 공식 base URL은 `https://generativelanguage.googleapis.com/v1beta/openai/`이다. 사용 가능한 model을 먼저 조회하고, 반환된 정확한 ID를 `MODEL_NAME`과 `CHAT_MODEL_NAME`에 선택한다. 특정 model 이름을 기본값으로 가정하지 않는다. [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)

```bash
curl -sS https://generativelanguage.googleapis.com/v1beta/openai/models \
  -H "Authorization: Bearer $GEMINI_API_KEY"

curl -sS https://generativelanguage.googleapis.com/v1beta/openai/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $GEMINI_API_KEY" \
  --data "{\"model\":\"$SELECTED_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with OK\"}]}"
```

사전 호출이 성공한 뒤 다음 값을 설정한다.

```dotenv
MODEL_MODE=openai-compatible
MODEL_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai/
MODEL_API_KEY=...
MODEL_NAME=<selected-model-id>
CHAT_MODEL_MODE=openai-compatible
CHAT_MODEL_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai/
CHAT_MODEL_API_KEY=...
CHAT_MODEL_NAME=<selected-model-id>
```

분석 Provider를 process restart 없이 관리하려면 deployment fallback은 유지하고 다음 값을 Server와 Worker에 동일하게 설정한다. 암호화 key는 base64로 encoding한 정확히 32 byte여야 하며, allowlist는 path가 아닌 exact origin을 comma로 구분한다.

```bash
export MODEL_CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

```dotenv
MODEL_ADMIN_ENABLED=true
MODEL_CREDENTIAL_ENCRYPTION_KEY=<the-same-key-for-server-and-worker>
MODEL_PROVIDER_ALLOWED_ORIGINS=https://generativelanguage.googleapis.com,https://models.example.internal
```

Administrator로 `/admin?tab=provider`에서 Provider를 저장하고 `/admin?tab=prompt`에서 tenant 지침을 저장한다. API key는 다시 표시되지 않으며, 이후 생성한 analysis run이 해당 provider/prompt version과 hash를 보존하는지 확인한다.

### ChatGPT account for local Chat

관리자 화면의 **ChatGPT accounts**에서는 `auth.json` 입력 후 **모델 목록 조회**로 계정의
모델 카탈로그를 가져올 수 있다. 모델을 선택하면 Model ID와 지원 effort, 기본 effort를
채운다. 현재 앱이 지원하는 `low`, `medium`, `high`, `xhigh` 범위만 표시하며, 조회만으로
계정을 저장하거나 분석 모델을 활성화하지 않는다. 조회 실패 시 Model ID를 직접 입력할 수
있다. 등록 전 조회는 access token만 사용하고 refresh token을 회전하지 않으므로 인증 만료 시
다시 로그인한 `auth.json`으로 조회한다. 모델 조회 호환 버전은
`CHATGPT_ACCOUNT_CLIENT_VERSION`으로 설정한다(기본값 `0.153.0`).

오른쪽 Review Chat만 ChatGPT/Codex 구독 계정으로 실행하려면 먼저 Codex CLI에서 로그인한다. 이 mode는 batch 분석 Worker에는 적용되지 않는다. OpenAI 공식 문서의 ChatGPT login과 API key login은 서로 다른 인증 방식이다. [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)

```bash
codex login
codex login status
```

그다음 host의 Codex credential directory를 Server에 지정한다. `CHAT_MODEL_ENDPOINT`를 생략하면 Codex account endpoint를 사용하며, model은 계정에서 사용할 수 있는 정확한 ID를 명시한다.

```dotenv
CHAT_MODEL_MODE=chatgpt-account
CHAT_MODEL_NAME=gpt-5.6-sol
CHATGPT_ACCOUNT_HOME=/home/user/.codex
CHATGPT_ACCOUNT_REFRESH_ENDPOINT=https://auth.openai.com/oauth/token
CHATGPT_ACCOUNT_PROACTIVE_REFRESH_MINUTES=5
```

Server는 `auth.json`을 읽고 access token 만료 전에 refresh token을 회전하여 같은 파일에 mode `0600`으로 원자 저장한다. 이 개발 편의 경로를 container의 hostPath mount로 옮기지 않는다. Kubernetes에서는 아래 배포 가이드의 Secret bootstrap과 전용 PVC를 사용한다.

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build

curl -fsS http://127.0.0.1:4000/health/live
curl -fsS http://127.0.0.1:4000/health/ready
```

Artifact 검사는 report/source를 출력하지 않고 개수만 반환한다.

```bash
node apps/runtime/dist/index.js retention --reconcile
node apps/runtime/dist/index.js retention
```

작업을 마치면 PostgreSQL을 중지한다. volume 삭제는 개발 DB를 완전히 폐기할 때만 수행한다.

```bash
docker compose -f compose.dev.yaml down
```
