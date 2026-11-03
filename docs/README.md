# 문서 안내

처음 설치하거나 CD를 연결한다면 [설치·연결 가이드](product/getting-started.md)부터 읽으세요. 현재 동작은 아래 문서와 소스를 기준으로 확인합니다. 날짜가 붙은 운영 기록과 `.documents`의 단계별 설계는 당시 결정·검증 범위이며 현재 사용 절차와 구분합니다.

| 필요한 작업                 | 문서                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 제품 역할 이해              | [Introduction](product/introduction.md), [아키텍처](product/architecture.md)                                      |
| 설치·모델 설정·CD 연결·예시 | [설치·연결 가이드](product/getting-started.md)                                                                    |
| 메뉴별 기능과 권한·상태     | [기능 목록](product/features.md), 실행 중인 앱의 `/guide`                                                         |
| 개발 환경 실행              | [개발](operations/development.md)                                                                                 |
| Helm·TLS·DB·Secret 준비     | [배포](operations/deployment.md), [공유 PostgreSQL](operations/shared-postgresql.md)                              |
| 로그인·계정·repository 권한 | [Identity와 인가](operations/identity-authorization.md), [SAML](operations/saml-web-authentication.md)            |
| reader key와 연결 JSON      | [클라이언트 연결](operations/client-connections.md), [API key 계약](operations/client-api-keys.md)                |
| Skill·지침의 발행·서명      | [지식 발행](operations/review-knowledge-publication.md), [서명 배포](operations/review-knowledge-distribution.md) |
| 원문 이력 API               | [reader API](../.documents/review-history-reader-api.md)                                                          |
| 장애·복구·보존              | [백업·복구](operations/backup-restore.md), [게시 head 보호](operations/publication-head-guard.md)                 |
| 실제 전달·검증 범위         | [G04 실행 기록](../.documents/execution/review-memory-pull/G04.md)                                                |

GCR의 모델 계정, GitHub PAT, CD reader key와 CD 모델 credential은 서로 다른 권한입니다. CD는 중앙 자료를 읽어 사용자가 선택한 provider로 리뷰하며 로컬 소스·결과·대화를 GCR에 올리지 않습니다. 과거 설계의 제출·runner 기능을 현재 연결 과정에 추가하지 마세요.
