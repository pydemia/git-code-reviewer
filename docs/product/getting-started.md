# GCR와 Commit Defender 설치·연결 가이드

GCR는 서버에서 GitHub PR을 수집·분석하고 과거 리뷰 원문과 지침을 보관합니다. Commit Defender(CD)는 개발자의 Git 변경을 로컬에서 준비하고 개발자가 선택한 모델 provider로 리뷰합니다. GCR 연결은 CD의 모델 계정을 바꾸지 않습니다.

GCR를 이미 운영 중이라면 **GCR에서 연결 자료 준비**부터 시작하세요. 중앙 자료 없이 CD만 사용하는 경우에는 **CD 설치와 첫 리뷰**만 따라도 됩니다.

## GCR 설치 방식 선택

| 방식            | 준비물                                                                | 용도와 초기 상태                                                               |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Docker Compose  | Git, Docker Engine, Docker Compose                                    | 한 컴퓨터에서 화면과 흐름 확인. fixture PR, 개발 인증, 모델 비활성 상태로 시작 |
| 소스 개발       | Node.js 22.12 이상, pnpm 10.17.1, Git, PostgreSQL                     | API·Worker·Web을 따로 실행하고 코드 수정                                       |
| Kubernetes Helm | Kubernetes, Helm, 컨테이너 registry, PostgreSQL, 공유 artifact 저장소 | 여러 사용자가 접근하는 서버. 실제 인증·TLS·GitHub·모델 설정 필요               |

Compose의 개발 인증과 fixture 데이터는 실제 사용자 로그인·실제 모델 검증을 대신하지 않습니다. 운영 배포는 [Helm 설치 절차](../operations/deployment.md)를 따르세요.

### Docker Compose로 화면 확인

아래 명령으로 저장소를 받은 뒤 사용할 release 또는 branch를 checkout하고 Compose를 실행합니다.

```bash
git clone https://github.com/pydemia/git-code-reviewer.git
cd git-code-reviewer
docker compose up --build --wait
docker compose ps
curl -fsS http://127.0.0.1:4000/health/ready
```

브라우저에서 `http://127.0.0.1:4000`을 엽니다. PR을 선택하면 snapshot과 보고서 흐름을 확인할 수 있습니다. 초기 모델은 비활성 상태이므로 AI 검토가 완료됐다고 해석하지 마세요. API가 정상이어도 분석이 진행되지 않으면 `docker compose logs --tail=100 worker`로 Worker 상태를 확인합니다.

종료는 `docker compose down`입니다. 기존 DB·artifact를 유지하려면 volume 삭제 옵션을 추가하지 않습니다. 이 기본 profile은 CD의 운영 reader 연결을 활성화하지 않습니다.

### 소스에서 실행

```bash
corepack pnpm install --frozen-lockfile
cp .env.example .env
export POSTGRES_PASSWORD='local-only-password'
export POSTGRES_PORT=25432
docker compose -f compose.dev.yaml up -d postgres
```

`.env`의 `DATABASE_URL`을 위 비밀번호·port와 맞춥니다. `.env`는 자동으로 로드되지 않습니다. 다음 명령은 API·Web을 시작합니다.

```bash
set -a
source .env
set +a
pnpm migrate
pnpm dev
```

별도 terminal에서 같은 `.env`를 export한 뒤 Worker를 시작합니다.

```bash
set -a
source .env
set +a
pnpm build:packages
pnpm --filter @gcr/runtime exec tsx src/index.ts worker
```

Web은 `http://127.0.0.1:5173`, API는 `http://127.0.0.1:4000`입니다. VS Code debugger와 상세 환경변수는 [개발 가이드](../operations/development.md)를 참고하세요.

### Helm으로 서버 설치

[배포 가이드](../operations/deployment.md)의 Secret과 values를 먼저 준비합니다. artifact에는 Server와 Worker가 함께 접근할 저장소가 필요합니다. 기본 chart는 외부 PostgreSQL을 사용하며 선택형 PostgreSQL dependency도 지원합니다. pilot 예제의 StorageClass·암호·공개 주소를 환경에 맞게 바꾸세요.

```bash
helm dependency build deploy/helm/git-code-reviewer
helm lint deploy/helm/git-code-reviewer -f /secure/path/gcr-values.yaml
helm upgrade --install git-code-reviewer deploy/helm/git-code-reviewer \
  --namespace git-code-reviewer --create-namespace \
  -f /secure/path/gcr-values.yaml --atomic --wait --timeout 20m
kubectl -n git-code-reviewer get pods,pvc,jobs
helm test git-code-reviewer -n git-code-reviewer
```

`/secure/path/gcr-values.yaml`은 사용자가 준비한 파일을 뜻합니다. 예제를 그대로 실행할 수 있는 기본 파일명은 아닙니다. 배포 image는 승인된 version/digest에 고정합니다. 기존 설치에서는 암호화·서명 key와 PVC를 재생성하지 말고 [백업·복구 절차](../operations/backup-restore.md)를 함께 확인하세요.

CD 연결을 제공하려면 HTTPS 공개 주소, local 또는 SAML 인증, 지식 발행·서명 배포, client API key 기능이 필요합니다. 기본 development 인증의 Compose와 loopback HTTP pilot만으로는 이 조건을 충족하지 않습니다. [클라이언트 연결 운영 설정](../operations/client-connections.md)과 [지식 배포 설정](../operations/review-knowledge-distribution.md)을 적용합니다. SAML을 선택한 환경은 IdP/Keycloak을 별도로 구성합니다. GCR 자체가 모든 설치에서 Keycloak을 필수로 요구하지는 않습니다.

DB의 TLS는 웹 HTTPS와 별개입니다. 운영 DB에서 `verify-full`을 사용하려면 DB 서버 인증서의 호스트 이름과 신뢰 CA를 맞춥니다. CD 연결 JSON의 공개 CA는 웹 서버 인증서를 검증하는 용도이며 DB CA를 자동으로 사용하지 않습니다.

## GCR의 첫 설정

관리자는 다음 순서로 설정합니다. 메뉴 이름과 세부 입력은 [사용 가이드](/guide)를 따릅니다.

1. 사용자·tenant membership과 저장소 접근 권한을 준비합니다. 로그인 성공과 특정 저장소를 읽을 권한은 별개입니다.
2. **관리 → GHES 연결**에서 GitHub 연결과 PAT를 등록하고 repository의 polling을 설정합니다. 토큰은 GitHub 권한이며 CD의 reader key나 모델 API key로 사용할 수 없습니다.
3. **관리 → 분석 모델**에서 중앙 PR 분석에 사용할 계정 또는 provider와 model을 설정·검증·활성화합니다. 필요하면 Chat 계정 할당도 구성합니다. 이 선택은 CD의 로컬 모델 선택과 별개입니다.
4. **분석 프롬프트·분석 Skills**에서 지침을 확인합니다. 새 설정은 이후 생성한 분석에 고정되며 기존 보고서를 다시 쓰지 않습니다.
5. PR 목록에서 실제 PR을 열고 수집 상태, 분석 상태, 보고서와 사용한 commit을 확인합니다. 모델 비활성·partial·실패 상태를 완료로 해석하지 않습니다.

GitHub 결과 게시는 별도 설정입니다. 처음 검토할 때 반드시 댓글을 게시하거나 새 PR을 만들 필요는 없습니다.

## GCR에서 연결 자료 준비

로그인 후 **내 프로필 → 클라이언트 연결**에서 준비합니다.

1. 클라이언트로 **Commit Defender**를 선택하고 대상 저장소·이름·유효 기간을 정해 **API key 발급**을 누릅니다. 원문 key는 발급 직후만 확인할 수 있습니다.
2. 같은 저장소의 **연결 설정 다운로드**를 누릅니다. JSON에는 서버 주소, server/tenant/repository ID, 서명 공개키와 필요한 공개 CA가 들어갑니다. 비밀 API key는 들어가지 않습니다.
3. key 원문은 CD의 비밀번호 입력란에 넣습니다. 설정 JSON이나 Git 저장소에 붙여 넣지 않습니다. `gcr-cli`용 key는 CD 연결에 사용할 수 없습니다.

메뉴가 비활성 상태라면 관리자가 client API key와 서명 발행 설정을 확인해야 합니다. 저장소가 없다면 본인의 현재 tenant/repository 권한을 먼저 확인합니다. key는 `knowledge:read`이며 모델 호출·지침 작성·수집 요청 권한이 아닙니다.

## CD 설치와 첫 리뷰

현재 소스의 기능을 설치하려면 해당 소스에서 만든 VSIX를 사용합니다. Marketplace의 별도 게시 상태와 로컬 설치 버전은 다를 수 있습니다. VS Code 1.90 이상, 신뢰한 Git workspace, 사용 가능한 OS credential store가 필요합니다. Codex 고정 소스 리뷰는 macOS의 지원 CLI 버전을 사용합니다. API provider와 OS별 범위는 [CD 설정 가이드](https://github.com/pydemia/commit-defender/blob/codex/review-memory-pull-g03/vscode-extension/docs/standalone-review.md)에 정리되어 있습니다.

```bash
git clone https://github.com/pydemia/commit-defender.git
cd commit-defender/vscode-extension
npm ci
npm run build
npx @vscode/vsce package --no-dependencies --out commit-defender-local.vsix
code --install-extension ./commit-defender-local.vsix
```

원하는 release/branch를 checkout한 뒤 빌드하세요. 이미 받은 VSIX는 VS Code의 **Extensions → Install from VSIX…**로도 설치할 수 있습니다. 설치 뒤 확장 화면의 버전을 확인합니다. 이미 열린 창이 이전 버전을 실행 중이면 사용자가 편한 시점에 재로드합니다. 설치 명령 성공과 기존 Extension Host 적용은 다른 상태입니다.

1. Git repository를 열고 **Commit Defender: Select Account Provider and Model**에서 로컬 provider/model을 선택합니다. 계정·모델은 **User Settings**에 설정합니다.
2. Codex는 **Sign in with Codex**, API provider는 **Manage Model API Credential**로 인증을 준비합니다. GCR reader key와 모델 credential을 혼동하지 마세요. `reviewReasoningEffort`는 선택 모델이 지원하는 값으로 별도 설정합니다.
3. 작은 변경을 저장하고 stage한 뒤 **Commit Defender: Analyze Staged Files**를 실행합니다. stage하지 않은 편집 내용이나 저장하지 않은 buffer는 이 리뷰의 대상이 아닙니다.
4. Summary·Problems·inline 의견을 확인합니다. `completed`와 `partial`, `failed`, `cancelled`를 구분합니다. 소스 read와 코드 위치 확인은 테스트 실행의 증거가 아닙니다.

자동 Save·Stage·Commit·Push 리뷰는 새 설치에서 꺼져 있습니다. 수동 리뷰를 먼저 확인한 뒤 필요한 trigger만 명시적으로 선택하세요. 현재 공통 리뷰와 자동 service는 advisory이며 기존 legacy pre-commit hook의 차단 정책은 별도입니다.

## CD를 GCR에 연결

1. 중앙에 등록된 repository와 일치하는 로컬 Git checkout을 엽니다.
2. **Commit Defender: Central Review Connection → Connect with API key…**를 선택합니다.
3. 다운로드한 연결 JSON을 열고 서버·저장소·공개키를 확인한 뒤 CD용 reader key를 입력합니다. 초기 서명 발행은 최대 60초 기다릴 수 있습니다.
4. **Connection status**에서 선택된 profile/worktree, 저장소, 마지막 sync와 유효기간을 확인합니다. 연결해도 로컬 provider/model/reasoning은 유지됩니다.
5. **Browse PR review history**로 PR·코멘트를 골라 Original comment, Replies, Body versions, Thread observations, Source-linked guidance를 확인합니다. 자료를 읽는 데 메모리 승인은 필요하지 않습니다.
6. **View downloaded review knowledge**로 Skill·프롬프트·활성 지침을 확인하고 같은 Analyze 명령으로 로컬 변경을 리뷰합니다.

GCR에는 이미 알려진 저장소·PR·이력 ID와 cursor/revision으로 읽기 요청을 보냅니다. 로컬 코드·diff·질문·결과·대화·개인 Memory는 GCR에 올리지 않습니다. 리뷰에 필요한 소스와 문맥은 사용자가 선택한 모델 provider로 전달됩니다. 클라이언트에서 실행한다는 말이 모델 추론도 반드시 컴퓨터 안에서 수행된다는 뜻은 아닙니다.

## 사용 예시: 과거 코멘트를 다음 리뷰에 활용

과거 PR에서 “요청 값만으로 결정할 수 있는 검증은 Pydantic validator에 두자”는 코멘트가 있었다고 가정합니다.

- GCR **리뷰 이력**에서 원문·답글·본문 버전을 확인합니다. 관리자는 원문에 연결된 지침에 적용 파일, 요청 필드만으로 판단한다는 조건, DB·권한·저장 상태 검증은 제외한다는 반증 지침을 적고 활성화·발행합니다. 원문 자체에는 이 승인 절차가 필요하지 않습니다.
- CD는 관련 파일의 변경을 리뷰할 때 적용 가능한 지침과 원문을 로컬에서 선택합니다. 원문은 과거 관측이며 “수정했다”는 답글만으로 현재 코드가 맞다고 판단하지 않습니다.
- 검증 함수를 호출하지 않는 변경이라면 현재 호출부를 확인해 결함을 지적할 수 있습니다. 이미 validator에서 처리하는 변경에는 같은 지적을 반복하지 않아야 합니다. DB의 archived 상태를 검사하는 변경에는 요청 schema로 무조건 옮기라고 요구하면 안 됩니다.
- 결과의 전체 요약에서 적용·충족·제외·미사용 설명을 읽고 **Review criteria used / Evidence**에서 source ID, 원문 URL, revision과 hash를 대조합니다. 자료가 문맥에 있었다는 기록과 실제 판단에 활용했다는 모델 설명은 구분합니다.

이 예시는 사용 절차와 기대 결과입니다. 실제 프로젝트의 결함 여부는 현재 코드·호출부·계약에 따라 판단합니다. 내려받은 검증로직은 Skill·프롬프트·검토 지침이며 임의 실행 파일이나 테스트 runner가 아닙니다.

## 장애와 결과 읽기

| 증상                         | 먼저 확인할 것                                             | 다음 행동                                                                                                      |
| ---------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 과거 PR이 없음               | 수집 범위와 접근 저장소                                    | 기존 수집 이력을 먼저 확인. 추가 수집이 필요하면 관리자가 PR 번호와 한도를 지정                                |
| GCR 장애, 로컬 모델 정상     | Connection status의 일반 통신 오류와 허용한 fallback       | 허용된 signed cache 또는 명시한 standalone fallback 사용. 실패한 중앙 리뷰를 성공으로 표시하지 않음            |
| 401/403 또는 identity 오류   | key 만료·폐기, 사용자·저장소 권한                          | 권한을 복구하고 정상 인증·동기화. 만료·철회 자료를 다시 사용하지 않음                                          |
| 모델 실행 실패               | 선택 provider/model, CLI 지원, model credential, 시간 한도 | GCR key를 바꾸기 전에 로컬 provider 오류를 확인                                                                |
| 긴 온라인 리뷰가 취소됨      | manifest의 online refresh 시각                             | 현재 서버의 5분 유효기간 경계를 확인하고 정상 sync 후 재시도. 동기화가 고정 실행의 수명을 무조건 늘리지는 않음 |
| 설치했지만 새 설명이 안 보임 | 설치 버전과 열려 있는 Host 버전                            | 자동 재로드를 가정하지 말고 사용자가 창을 재로드한 뒤 확인                                                     |

자세한 기능·제약은 [기능 목록](features.md), 데이터 흐름은 [아키텍처](architecture.md)를 참고하세요.
