# Local development

로컬 개발은 application과 PostgreSQL을 분리한다. `compose.dev.yaml`은 PostgreSQL만 실행하며 Server와 Worker는 host process로 실행한다.

## Prerequisites

- Node.js 22 이상
- pnpm 10.17.1
- Docker Engine과 Compose
- Git

## Start PostgreSQL

```bash
export POSTGRES_PASSWORD='local-only-password'
export POSTGRES_PORT=55432
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

Browser workspace는 `http://127.0.0.1:5173`에서 연다. `GITHUB_MODE=fixture`, `DEV_USER_ROLE=admin`이면 fixture repository와 PR이 자동 준비된다. 첫 PR에서 refresh를 실행하면 별도 Worker가 snapshot과 report를 생성한다.

## Model setup

Model을 사용하지 않으면 `MODEL_MODE=disabled`, `CHAT_MODEL_MODE=disabled`로 둔다. 활성화할 때는 endpoint, API key뿐 아니라 model name을 반드시 명시한다. Server 시작 시 Chat 설정을, Worker 시작 시 분석 설정을 검증하므로 name 누락은 즉시 실패한다.

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
