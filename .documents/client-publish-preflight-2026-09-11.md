# Commit Defender 게시 네트워크 사전 점검

점검일: 2026-09-11, 로컬 Mac  
대상: `pydemia.commit-defender`, 설치된 `vsce 3.9.1`  
상태: 네트워크 조회 통과, 게시 인증·쓰기 권한·VSIX 업로드는 미완료. 실제 publish·version 변경·build·extension 설치는 수행하지 않음.

## 관측 결과

| 점검                                           | 결과                                                                | 해석                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `vsce show pydemia.commit-defender --json`     | exit 0, publisher/name 일치, 최신 응답 version `2.3.0`              | 실제 게시 CLI의 Marketplace metadata 조회 성공                                        |
| Marketplace DNS·HTTPS                          | curl의 TLS 검증 결과 0, Node HTTPS 응답 수신                        | 현재 설정에서 DNS/TLS 차단 미관측                                                     |
| Gallery API 무인증 HEAD/GET                    | 경로·method에 따라 302/404/405                                      | 서버 응답 수신. 게시 인증·업로드 성공을 의미하지 않음                                 |
| 기존 extension 경로의 무인증 OPTIONS           | 404, Allow header 없음                                              | 허용 write method나 업로드 가능 여부를 판정할 수 없음                                 |
| Microsoft 로그인 discovery                     | curl·Node GET 200                                                   | 로그인 서버 접근·TLS 정상                                                             |
| Azure DevOps `app.vssps.visualstudio.com` HEAD | 405, TLS 검증 정상                                                  | 해당 host 응답 수신, 인증된 API 성공은 아님                                           |
| npm `@vscode/vsce` metadata HEAD               | 200, TLS 검증 정상                                                  | 해당 metadata 경로 접근 가능. 전체 dependency 설치를 테스트한 것은 아님               |
| `vsce verify-pat pydemia`                      | 25초 무응답 후 종료                                                 | PAT 유효성·publisher 역할 미확인                                                      |
| PAT 검증의 단계별 추적                         | 로컬 publisher credential 조회에서 8초 초과, permission API 진입 전 | 이 정지는 원격 게시 API 응답 대기 단계가 아님                                         |
| Mac UI 확인                                    | 화면 잠김, 자동 해제 불가                                           | Keychain/로그인 dialog를 확인할 수 없음. credential 조회 정지의 세부 OS 원인은 미확정 |
| Azure CLI 기존 계정 metadata                   | 조회 성공                                                           | 저장된 계정 존재만 확인. token 유효성은 별개                                          |
| `vsce verify-pat pydemia --azure-credential`   | 30초 무응답 후 종료                                                 | 다중 credential chain의 전체 실패 원인을 CLI 출력만으로 확인할 수 없음                |
| Azure CLI의 Marketplace용 token 취득           | `AADSTS700082`, 장기 미사용으로 refresh token 만료                  | 이 경로는 재로그인 필요. 게시 권한을 확인하기 전 인증 단계에서 실패                   |

Token 취득 명령은 만료 시각만 출력하도록 제한했으며 원문 token·PAT·계정 식별자는 이 기록에 저장하지 않았다. Microsoft는 `AADSTS700082`를 미사용으로 만료된 refresh token으로 정의한다. [공식 오류 설명](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes)

프록시 관련 환경 변수는 설정되지 않았고 `NODE_EXTRA_CA_CERTS`는 설정되어 있다. 기존 CA 설정을 사용했으며 TLS 검증 해제·네트워크 설정 변경은 하지 않았다. 이 결과는 지금의 Mac·접속망에 한정되며 다른 망에서도 같다고 보장하지 않는다.

## 남은 확인

현재 근거로는 Marketplace/로그인 서버의 기본 접근 차단은 확인되지 않았다. 게시를 진행할 수 있다고 확정하기에는 인증과 write 경로 검증이 남아 있다.

- PAT 경로: 사용자가 Mac 잠금을 해제한 뒤 `pydemia`의 credential 접근과 `vsce verify-pat`를 재시도한다. 필요한 Keychain 승인·재로그인은 본인 확인을 거친다. 저장 PAT를 평문으로 추출하거나 OS 잠금을 우회하지 않는다.
- Entra 경로: 해당 Microsoft 계정이 `pydemia` 게시용 계정인지 확인한 뒤 CLI에서 재로그인한다. 기존 Azure 로그인 metadata만으로 publisher 소속을 추정하지 않는다. 다른 Azure 작업의 계정을 임의 logout하지 않는다.
- 인증 후 현재 principal의 실제 publisher 역할·필요 scope를 확인한다. 설치된 `vsce`의 `verify-pat`는 Reader 역할의 조회 성공도 통과시킬 수 있어 그 성공만으로 쓰기 권한을 확정하지 않는다. [vsce 검증 구현](https://github.com/microsoft/vscode-vsce/blob/main/src/store.ts)
- 실제 VSIX의 authenticated PUT/POST, 크기 제한·DLP·WAF·업로드 timeout은 아직 검증하지 않았다. GET/HEAD/OPTIONS 성공 여부만으로 이 경로의 통과를 보장할 수 없다.

설치된 `vsce publish`에는 게시 서버를 대상으로 업로드까지 검증하는 dry-run 옵션이 없다. `vsce package`도 원격 게시 검증이 아니다. 잘못된 VSIX나 중복 version을 일부러 업로드하는 시험은 하지 않는다. 실제 게시 시험이 필요하면 [로컬 VS Code 검증 절차](./client-extension-release-plan.md)를 통과한 release candidate와 사용자가 지정한 게시 대상·채널을 확정한 후 별도 진행한다. Pre-release도 공개 배포이므로 비공개 dry-run으로 취급하지 않는다.

모든 진단 프로세스는 종료했다. Marketplace 업로드, publisher 권한 변경, CLI 재로그인·계정 전환, Git commit/push는 수행하지 않았다.
