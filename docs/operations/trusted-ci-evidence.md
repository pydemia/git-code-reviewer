# 중앙 PR 리뷰의 CI 검증 근거

중앙 서버는 GitHub Check Run의 서명된 JSON을 읽고 해당 보고서의 입력과 대조한다. 로컬 Commit Defender·CLI·MCP의 결과 제출이나 중앙 모델 실행 경로는 없다. 중앙 리뷰와 프롬프트를 로컬로 내려받는 전파 방향은 유지한다.

보고서의 **중앙 CI 검증 근거 → CI 근거 조회**에서 현재 근거를 요청한다. 자동 조회·CI 실행·PR 승인·지적 삭제는 하지 않는다. 서명이 유효한 실패 결과도 그대로 표시한다. `verified`는 발급자와 입력이 일치한다는 뜻이며 검사 성공이나 개별 결함 재현을 뜻하지 않는다. 과거 보고서는 과거 소스 기준이고 조회 시각 이후의 변경을 보증하지 않는다.

## 신뢰 설정

Helm `trustedCi.policies`는 기본값이 `[]`다. 운영자가 저장소마다 하나의 정책을 등록해야 한다. 서버 환경 변수는 JSON 배열 `TRUSTED_CI_POLICIES`다. 공개키만 ConfigMap에 넣을 수 있으며 개인키·잘못된 Ed25519 키·동일 GitHub 주소와 저장소 ID의 중복 정책은 기동 시 거부한다.

정책 필드는 다음과 같다.

| 필드                                                | 운영자가 고정하는 값                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apiBaseUrl`                                        | 후행 `/`를 포함한 HTTPS GitHub API 주소. 예: `https://api.github.com/`                  |
| `repositoryId`, `repository`                        | GitHub 숫자 ID의 문자열과 `owner/repo`                                                  |
| `issuer`, `keyId`, `publicKey`                      | CI 발급자 URL, 키 식별자, Ed25519 SPKI PEM 공개키                                       |
| `workflowId`, `workflowPath`, `workflowContentHash` | Actions workflow ID 문자열, `.github/workflows/*.yml` 경로, 원본 파일 bytes의 SHA-256   |
| `checkAppId`, `checkName`                           | Check Run을 발행하는 App ID 문자열과 정확한 이름                                        |
| `allowedRefs`                                       | 정확한 PR ref 목록 또는 `refs/pull/*/head`. v1 수집기는 `pull_request` 실행만 채택한다. |
| `environmentHash`                                   | 운영자가 승인한 CI 검증 환경 명세의 SHA-256                                             |
| `maxAgeSeconds`                                     | 근거 최대 수명과 최대 경과 시간. 60–86400초                                             |

이 계약은 **고정 공개키 기반 CI 진술**이다. GitHub OIDC, Sigstore, GitHub artifact attestation 검증을 구현한 것으로 해석하면 안 된다. 서버는 환경을 직접 실행·측정하지 않으며 허용한 발급자가 검사와 실행 환경을 정확히 측정·서명한다는 신뢰가 필요하다.

## 서명 생산자 계약

1. 운영자가 관리하는 생산자는 중앙 분석과 동일한 base/head/merge-base 커밋 및 tree를 측정한다. 기본 PR merge checkout을 head checkout으로 간주하면 안 된다. 서버가 읽는 Check Run과 Actions run의 `head_sha`도 서명된 head와 같아야 한다.
2. 해당 실행에 실제로 적용한 중앙 context·rule·tool·profile 식별자와 CI 환경 명세를 기록한다. 중앙 예상값을 복사한 뒤 이를 측정값으로 서명하면 검증 근거가 성립하지 않는다. context/rule은 보고서에 고정된 공용 기준, tool은 `report.versions`, profile은 중앙 prompt/provider/policy/memory/severity 식별자의 canonical JSON SHA-256이다. 환경 hash는 이들 중앙 메타데이터와 구분되는 CI 환경 명세다.
3. 검사별 명령, 기대값, 실제값, 종료 코드, `passed|failed|incomplete|unavailable`을 기록한다. `passed`는 종료 코드 0이 필요하다. 원문에 비밀정보를 넣지 않는다.
4. PR 코드를 실행하는 작업과 개인키를 사용하는 서명 작업을 분리한다. 서명 작업은 PR에서 가져온 스크립트나 임의 job output을 검증 없이 실행·서명하지 않는다. workflow 파일이 고정되어 있다는 사실만으로 그 작업이 실행하는 코드까지 신뢰할 수 있는 것은 아니다.
5. [`ciValidationPayloadSchema`](../../packages/contracts/src/trusted-ci.ts)의 payload를 생성하고 아래 명령으로 envelope 파일을 만든다. 이 유틸리티는 입력 형태와 키 종류를 확인하고 서명만 하며 생산자 측 측정·격리·정책 검증을 대신하지 않는다.

```sh
node scripts/sign-ci-validation.mjs payload.json ci-private-key.pem envelope.json
```

`packages/contracts`와 `packages/client-contract` 빌드가 필요하다. 출력은 신규 파일에만 쓰며 파일 권한은 0600이다. 서명 대상은 UTF-8 `git-code-reviewer:ci-validation:v1\n`과 canonical payload JSON을 연결한 bytes다. Ed25519 서명을 base64url로 인코딩하고 `{payload,signature}` JSON 전체를 허용한 Check Run의 `output.text`에 넣는다. envelope는 60,000 bytes 이하여야 한다.

Check 게시와 키 보관은 운영자가 지정한 CI 생산자가 맡는다. 이 저장소는 실제 저장소의 workflow·키·Check App을 자동 등록하거나 외부 Check를 게시하지 않는다. 인증된 웹 API `GET /api/v1/analyses/:analysisId/ci-validation` 응답의 `input`은 대조할 중앙 입력이다. 현재 이 조회는 사용자 세션 인증을 사용하며 CI용 machine credential 발급과 자동 입력 전달은 후속 작업이다.

## 서버 검증과 실패 처리

서버는 public completed/partial 분석, 보고서 bytes/checksum, 공용 기준 원문/hash와 저장소 범위, 고정 context/hash, 실제 materialization에서 저장한 커밋/tree를 확인한다. migration 0052 이전 snapshot은 tree를 역산하거나 채우지 않고 `input-unavailable`로 남긴다.

서명과 모든 입력이 일치한 뒤 GitHub에서 run ID·attempt·workflow·저장소·PR 연결·head·완료 상태·발행 시간 범위를 읽고 같은 head의 workflow 파일 hash도 대조한다. API origin, issuer, ref, 키, 시간 또는 입력 중 하나라도 다르면 채택하지 않는다. 같은 payload를 여러 Check에 붙여도 한 번만 표시한다.

GitHub 읽기에는 저장소의 등록 자격 증명 또는 배포 GitHub App을 사용한다. 필요한 read 권한은 Checks, Actions, Contents다. GitHub의 [Check Run 조회 API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)와 [Actions run attempt 조회 API](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt)를 사용하며 provider 데이터 변경 요청은 하지 않는다.

응답당 2 MiB, 요청당 10초, Check 목록 100개, 유효 서명 후보 8개와 수집 경과 시간 제한을 둔다. 목록이 잘렸거나 provider 조회가 실패하면 일부 성공분도 반환하지 않는다. 현재 근거를 읽은 후 저장소 접근 권한을 다시 검사한다. 화면 새로고침 실패와 보고서 이동 시 이전 결과를 지운다.

## 구현 및 운영 상태

수집기·검증기·사용자 조회 API·화면·Helm 설정과 서명 유틸리티를 구현했다. 실제 운영 CI 생산자, 공개키, workflow 및 환경 명세가 정해지기 전에는 `not-configured`가 정상 상태다. 합성 서명과 격리된 GitHub 응답, 로컬 DB·브라우저 검증은 실제 CI의 측정 정확도나 생산자 격리 검증을 대신하지 않는다. P13-C02 전체 완료 판정은 실제 생산자 연결과 운영 근거 확인 후에 한다.

PRISM-DEV 배포: `0.8.0-alpha.60`, chart `0.10.56`, Helm revision `70`, DB schema `52` (2026-09-15 07:19 KST). 수집기 기본 정책은 빈 배열이다. 검증 증거는 [P13-C02 기록](../../.documents/execution/preventive-review/evidence/P13-trusted-ci.json)에 있다.
