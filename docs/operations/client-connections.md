# 클라이언트 중앙 연결

프로필의 **클라이언트 설정**에서 Commit Defender 또는 GCR CLI, 저장소 접근 범위, 기간 또는 **No expiration**을 선택해 API key를 발급한다. 여러 저장소나 발급 시점에 접근 가능한 모든 저장소를 선택할 수 있다. 권한은 선택한 저장소의 `knowledge:read`로 제한된다. 이후 추가된 저장소에는 새 key가 필요하다. 리뷰 실행에 사용하는 모델 계정과 별개이며 모델 실행 권한을 부여하지 않는다.

Commit Defender의 **Connect with API key…**에는 HTTPS 서버 주소와 API key만 입력한다. 서버 확인 뒤 허용된 모든 자료 출처를 연결한다. **View downloaded review knowledge**에서 내용을 읽고 **Reference sources…**에서 참고 범위를 선택적으로 줄인다. 중앙에 등록되지 않은 로컬 저장소도 참고 자료를 사용할 수 있으며 다른 저장소의 정책은 강제하지 않는다. 사설 CA가 필요하면 같은 GCR 화면의 공개 CA 인증서를 지정한다.

공개 연결 JSON은 GCR CLI와 기존 CD의 **Import connection JSON…**용 호환 절차다. 서버 주소, server/tenant/repository ID, 서명 공개키, 필요한 공개 CA 인증서를 포함하며 API key 원문은 포함하지 않는다. API key는 별도 비밀번호 입력란 또는 CLI의 `--api-key-stdin`으로 전달한다. 명령행 인수나 프로젝트 설정에 원문을 저장하지 않는다.

API key 원문은 발급 응답에서 한 번만 제공한다. 화면에서는 기본적으로 가리고, 원문 닫기·페이지 이탈 시 제거한다. 원문을 잃었거나 발급 응답을 받지 못했다면 목록을 새로 불러와 해당 key를 폐기한 후 다시 발급한다. 서버에는 원문의 SHA-256만 저장한다. 클라이언트 연결은 OS 자격 증명 저장소를 사용한다.

CLI alpha11과 공통 패키지 alpha17를 사용하는 Commit Defender는 신규 저장소의 초기 지식 동기화를 최대 60초 기다린다. 일반 HTTP 503 응답에만 간격을 늘려 재시도하며 취소할 수 있다. 인증 거부·잘못된 응답·TLS 오류는 즉시 연결을 종료한다. 시간 초과 시 서버의 지식 발행 상태를 확인한 뒤 같은 key와 설정으로 다시 연결한다. 이전 CLI alpha8은 초기 발행을 기다리지 않는다.

목록에서 key를 폐기하면 다음 온라인 인증부터 거부된다. 이미 받은 서명된 지식의 오프라인 사용은 해당 manifest의 사용 기한까지 허용될 수 있다. 단말에서도 연결을 해제하면 해당 연결의 캐시 사용이 차단된다. 계정 비활성화, 비밀번호 변경, 저장소 권한 회수도 서버 인증에 반영된다.

Commit Defender는 신뢰한 workspace에서 명시적으로 선택한 중앙 온라인 연결을 시작 시와 기본 5분 간격으로 동기화한다. 간격에는 ±25% 지터가 적용되고 절전 후 창으로 돌아오면 최근 요청과 겹치지 않게 갱신한다. 일시적인 서버·인증 서버 장애는 1초부터 최대 기준 60초까지 간격을 늘려 재시도한다. 독립형·수동 오프라인 선택, workspace 제거, profile 변경과 확장 종료에서는 해당 동기화를 취소한다. 기본 독립형 모드에는 중앙 통신이 없다.

서버가 `IDENTITY_UNAVAILABLE`을 반환하면 중앙 cache 사용과 실행 중 리뷰의 추가 중앙 context 사용을 차단한다. OS에 저장한 key와 암호화 bundle은 복구를 위해 보존하지만 다른 process나 재시작에서도 인증된 sync가 성공하기 전에는 사용할 수 없다. 일반 서버 장애는 이 상태와 구분한다. 인증된 304는 마지막 성공 시각만 갱신하며 서명된 offline lease를 연장하지 않는다. 연결 상태 화면에서 마지막 성공 시각과 cache 오류를 확인할 수 있다. 401 credential 갱신은 아직 구현하지 않았다.

## 장애 시 리뷰 동작

새 연결의 기본값은 `cache-then-standalone`이다. 일반 서버 장애에서는 서명·scope·호환성·offline lease가 유효한 cache로 리뷰하고, 사용할 수 없으면 built-in/local Skill과 local memory만 사용한다. `cache-only`는 cache도 사용할 수 없을 때 대기하며 `standalone`은 중앙 요청 실패 후 cache를 사용하지 않고 바로 로컬 리뷰한다. `pause`는 요청한 중앙 지식을 사용할 수 없으면 중단한다. 기존 연결에 설정이 없으면 `pause`를 유지한다.

Commit Defender는 연결 확인 창에 fallback 정책을 표시한다. **Offline and fallback behavior…**에서 해당 worktree의 정책을 변경할 수 있다. CLI는 `central connect --offline-behavior <정책>`으로 저장하고 `review`/`context`의 같은 옵션으로 이번 실행에만 적용할 수 있다. 설정은 중앙 credential·source·다른 모델 제공자에 대한 동의를 대체하지 않는다. 초기 인증을 마쳤지만 첫 snapshot 발행에 실패한 연결도 local fallback을 사용할 수 있다. 이 경우 API key는 제거되므로 중앙 리뷰를 복구하려면 재연결한다. CLI 오류 결과의 `connectionId`로 확인된 연결을 지정한다.

인증 확인 실패·철회·서명 오류를 일반 offline 상태로 바꾸어 중앙 자료를 사용하지 않는다. Local fallback을 선택한 경우에만 본인의 local 자료로 별도 리뷰한다. Busy·다른 작업에 의한 superseded·취소·저장소 손상은 자동 fallback 대상이 아니다. 모델 장애에도 다른 제공자나 계정으로 전환하지 않는다. 실행 중 연결이 복구돼도 모델을 다시 실행하거나 기존 standalone 결과를 중앙 결과로 바꾸지 않는다.

결과의 `identity.client.execution`에 configured/effective mode, knowledge source, fallback reason과 확인된 connection ID를 저장한다. Cache 실행에는 마지막 성공 시각을 기록하고 서명된 snapshot의 offline lease를 유지한다. Standalone fallback 결과는 중앙 snapshot·항목 없이 local history에 저장하며 중앙 정책 충족 결과로 재사용할 수 없다. CLI의 같은 connection `history`/`result`와 CD 이력에서도 해당 연결의 local fallback 결과를 구분해 조회한다. 중앙 접근이 철회돼도 본인의 local 결과는 보존한다.

## 배포 설정

Helm `clientApiKeys.enabled=true`는 local/SAML 인증과 지식 발행·서명 배포가 구성된 서버에서 사용한다. `publicBaseUrl`은 클라이언트가 접근하는 HTTPS 주소여야 한다. 연결 설정 API는 요청 Host를 사용하지 않고 이 고정 주소를 사용한다.

사설 CA 환경은 `clientApiKeys.connectionCa.existingConfigMap`과 `key`로 웹 서버 인증서를 검증할 **공개 CA**를 명시한다. 런타임에는 `CLIENT_CONNECTION_CA_FILE`로 전달되고 서버 컨테이너에만 mount된다. 지정하지 않으면 연결 설정의 `ca`는 null이며 클라이언트의 기본 TLS 신뢰 저장소를 사용한다. DB CA 설정은 자동으로 가져오지 않는다. CA 파일에 인증서 외 내용이나 private key가 있으면 서버 시작을 거부한다.

`GET /api/v1/me/client-connection-config?repositoryId=<UUID>`는 로그인된 웹 session과 현재 저장소 권한을 확인한다. Bearer key로 이 API를 사용할 수 없으며 응답은 `private, no-store`다. 서명 private key는 서버의 기존 Secret에 유지한다.

웹 검증은 Chrome에서 테스트 API로 발급·복사·다운로드·원문 제거·응답 유실·폐기·모바일 표시를 확인한다. 실제 PostgreSQL 통합 테스트는 권한, 세션, 원문 비저장, bearer 제한, 발급·폐기 및 서명 지식 전송을 별도로 검증한다. 운영 클라이언트 연결 완료는 배포 후 별도 실행 증거로 판정한다.
