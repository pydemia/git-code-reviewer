# 사전 예방형 리뷰 개발 결정

2026-09-12, P00-C05. 전체 구현 계획의 범위는 유지하며 아래 결정으로 P01/P02를 시작한다. 실제 상태와 검증은 각 phase 실행 기록을 따른다.

## 실행·package·client 설정

- 개발은 현재 대화 세션에서 처리한다. GCR은 `~/git/git-code-reviewer`, CD는 `~/git/commit-defender-preventive-review`이며 두 저장소 모두 `feat/preventive-review-platform` 브랜치다. 원래 CD checkout과 준비해 둔 codex-work worktree는 보존한다.
- 공통 package는 GCR의 `@gcr/client-contract/core/executors` 세 개로 고정했다. Protocol major와 package version을 구분하고 실제 package는 함께 version을 올린다. [전달 계약](../../../docs/development/client-package-delivery.md)의 `vendor/gcr/<version>/`와 상대 `file:` pin을 사용한다. CD는 GCR source를 직접 import하지 않는다.
- 공통 library는 Node 18 호환, GCR build·새 headless CLI와 Extension Host test tooling은 Node 22 이상이다. CD의 VS Code 최소 범위 `^1.90.0`과 Node 18 bundle target을 유지한다. Package import와 실제 Extension Host 결과를 구분한다.
- 기존 `commitDefender.*` provider·hook 설정을 유지한다. 새 중앙 연결·profile·sync와 mode는 `commitDefender.gcr.*`, 자동 리뷰 설정은 `commitDefender.reviewTriggers.*` 아래에 둔다. 신규 mode는 standalone, 네 자동 trigger는 모두 off다. Namespace는 P02/P06/P07의 실제 manifest가 구현된 기능만 노출한다.
- Local memory·Skill과 central cache는 별도 store다. 모델 credential, 중앙 credential, GitHub credential, publisher credential의 namespace와 사용 목적을 섞지 않는다. OS credential store를 쓸 수 없으면 평문 저장으로 대체하지 않는다.

## 첫 executor와 평가 환경

첫 executor는 현재 사용자가 로그인한 Codex CLI의 `gpt-6-astra / xhigh`로 정했다. CD 기존 `commitDefender.codexPath`가 선택하는 CLI 실행 구조를 재사용한다. Mac에서 검증한 binary는 ChatGPT 앱에 포함된 `codex 0.153.4`다. 이 절대 경로를 제품 기본값이나 package 의존성으로 넣지 않는다. 기존 Homebrew CLI가 모델을 지원한다고 가정하지 않고 executable capability를 확인한다.

P00에서는 임시 synthetic Python 파일 두 개만 허용해 실제 source read-witness, 결함 판단, CLI 취소를 확인했다. 호출 수는 최대 2회, 완료 리뷰 timeout은 120초였다. [CD 실행 기록](https://github.com/pydemia/commit-defender/blob/54165ec/.documents/execution/preventive-review/P00.md)에 증거와 제한이 있다. 개발 executor의 read-only와 제품의 source 읽기 허용 범위는 다르다. P02-C05에서 불변 source view·제한된 조회·timeout·취소·하위 process 정리를 구현하기 전 새 backend를 지원 완료로 노출하지 않는다. Legacy adapter의 `maxTokens` 미적용은 P02의 실행 정책에서 해소하거나 명시적으로 미지원 처리한다.

첫 pilot repository는 GCR `tests/fixtures/preventive-review/`의 synthetic corpus로 생성한다. Python cache·TypeScript 권한·혼합 API 계약에 대한 결함/수정/정상/반증을 각각 사용한다. PR #953의 원문은 아직 확인하지 않았으므로 해당 PR의 실제 규칙을 승인하거나 모델 평가 source로 보내지 않는다. 실제 사내 repository·PR에 대한 재분석·게시·backfill은 후속 phase에서 대상과 권한을 확인한 뒤 진행한다.

두 환경은 다음과 같이 고정한다.

| 환경                     | 사용 경로                             | 실제 확인 범위와 남은 gate                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: 로컬 macOS arm64      | VS Code extension와 headless CLI      | VS Code 1.90.2·설치된 1.135.0·조회 당시 stable 1.137.0의 activation 기준을 통과. P02부터 실제 제품 리뷰·store·UI 검증                                                                                                                                     |
| B: Linux arm64 container | 설치 artifact의 headless CLI·MCP·sync | Docker Engine 29.3.1과 기존 local image의 Linux arm64 Node 22.23.2 실행을 확인했다. Image는 `node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`로 고정한다. Credential store·실제 executor와 두 환경 sync는 P02/P06/P09의 gate |

후속 모델 평가도 기본 source 범위는 synthetic corpus이며 명시된 executor를 자동으로 다른 계정·provider로 전환하지 않는다. 실패·한도·불충분한 context는 미완료로 남긴다. P00의 단일 결함 PoC를 12개 사례 전체의 모델 품질 검증으로 계산하지 않는다.

## Identity·운영·게시 사전 조건

SAML 구현 후보는 Fastify에서 직접 사용하는 `@node-saml/node-saml`, IdP는 공식 Keycloak image다. 최종 library/image version·지원/보안 상태·persistent NameID·서명·replay·cookie를 P03-C01의 공식 자료와 실제 PoC로 결정한다. 현재 후보명을 운영 지원 확인이나 SAML 완료로 표시하지 않는다. 공유 PostgreSQL의 별도 DB/role, 기존 사용자 mapping·권한·볼륨·암호화 key 보존은 [설계](../../keycloak-saml-deployment-design.md)를 따른다.

P00에서 실제 조회한 PRISM-DEV release는 namespace `git-code-reviewer`, Helm revision 42, chart `0.10.30`, app `0.8.0-alpha.31`, status `deployed`였다. Server와 Worker deployment는 각각 ready/desired `1/1`이며 image digest는 `sha256:c190547fe932f7b8d8219986260bb7feb6bc76f32889478a61955511f52c4f3d`다. 이 조회는 이번 변경 배포가 아니다. P00의 package·fixture·test tooling은 운영 서비스에 연결하지 않았으므로 실행 image를 바꾸지 않았다.

| 외부 조건                                   | 현재 상태                                                   | 해결 단계·재개 조건                                                                                |
| ------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 실제 SAML hostname·DNS/TLS·SMTP·관리자 연결 | 새 identity 환경으로 검증하지 않음                          | P03 통합 전 기존 route와 인증서를 조회해 구성하고 실제 관리자 mapping·로그인·복구 gate 통과        |
| macOS·Linux credential store                | 기존 계정 CLI 사용만 확인                                   | P02 local key, P04 broker에서 OS store 성공/실패·재시작·headless 경로 검증                         |
| Publisher 인증                              | Marketplace 조회 version 2.3.0, `verify-pat`는 20초 timeout | P09 로컬 Development Host·최종 VSIX 검증 뒤 본인 인증을 완료하고 실제 write role 확인              |
| Marketplace 게시·새 설치                    | 이번 변경 미게시                                            | P09-R03에서 검증한 동일 hash VSIX 게시 후 Marketplace 새 설치 smoke                                |
| 운영 변경 전달                              | 현재 cluster 조회 가능, 변경 없음                           | 서버 기능 변경 checkpoint에서 source push·실제 image/chart digest·기존 설정 보존·배포·smoke를 기록 |

Publisher 인증 대기는 현재 source 개발·fixture·서버 구현을 막지 않는다. 인증 성공만으로 쓰기 권한이나 업로드 성공을 주장하지 않으며 실제 게시가 남은 상태로 전체 goal을 완료하지 않는다.

Linux 준비 중 새 `node:22-bookworm-slim` pull은 `docker-credential-desktop` 조회에서 완료되지 않았다. 이 검사에서 시작한 Docker CLI와 자식 credential helper만 종료했고 기존에 있던 고정 digest의 `node:22-alpine`을 `--pull never --rm`으로 실행해 Node 22.23.2를 확인했다. 원격 image pull과 기존 local image 실행의 결과를 구분한다. PRISM-DEV의 Linux amd64 배포 검증은 별도 release gate로 유지한다.

## P02-C01 계약 검증용 선행 전달

공통 fixture를 CD projection에서 실제로 소비하도록 `0.1.0-alpha.2`의 contract를 CD devDependency에 먼저 고정한다. P00의 tarball 전달·동일 version 불변·Node 18·Apache-2.0 경계는 유지한다. Core/executors의 기능 통합과 runtime dependency 전환은 P02-C07에 남긴다. 이는 C01의 두 저장소 검증을 위한 전달 순서 조정이며 P02-C07 완료나 신규 backend 활성화를 뜻하지 않는다.
