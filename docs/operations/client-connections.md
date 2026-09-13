# 클라이언트 중앙 연결

프로필의 **클라이언트 연결**에서 Commit Defender 또는 GCR CLI, 저장소, 유효 기간(1~90일)을 선택해 API key를 발급한다. 권한은 선택한 저장소의 `knowledge:read`로 제한된다. 리뷰 실행에 사용하는 모델 계정과 별개이며 모델 실행 권한을 부여하지 않는다.

같은 화면에서 선택한 저장소의 연결 설정 JSON을 내려받는다. 이 파일은 서버 주소, server/tenant/repository ID, 서명 공개키, 필요한 공개 CA 인증서를 포함하며 API key 원문은 포함하지 않는다. 신뢰한 HTTPS 웹 화면에서 내려받고 클라이언트에 표시되는 서버 주소와 공개키를 확인한 뒤 연결한다. API key는 별도 입력란 또는 CLI의 `--api-key-stdin`으로 전달한다. 명령행 인수나 프로젝트 설정에 원문을 저장하지 않는다.

API key 원문은 발급 응답에서 한 번만 제공한다. 화면에서는 기본적으로 가리고, 원문 닫기·페이지 이탈 시 제거한다. 원문을 잃었거나 발급 응답을 받지 못했다면 목록을 새로 불러와 해당 key를 폐기한 후 다시 발급한다. 서버에는 원문의 SHA-256만 저장한다. 클라이언트 연결은 OS 자격 증명 저장소를 사용한다.

CLI alpha9와 공통 패키지 alpha15를 사용하는 Commit Defender는 신규 저장소의 초기 지식 동기화를 최대 60초 기다린다. HTTP 503 응답에만 간격을 늘려 재시도하며 취소할 수 있다. 인증 거부·잘못된 응답·TLS 오류는 즉시 연결을 종료한다. 시간 초과 시 서버의 지식 발행 상태를 확인한 뒤 같은 key와 설정으로 다시 연결한다. 이전 CLI alpha8은 초기 발행을 기다리지 않는다.

목록에서 key를 폐기하면 다음 온라인 인증부터 거부된다. 이미 받은 서명된 지식의 오프라인 사용은 해당 manifest의 사용 기한까지 허용될 수 있다. 단말에서도 연결을 해제하면 해당 연결의 캐시 사용이 차단된다. 계정 비활성화, 비밀번호 변경, 저장소 권한 회수도 서버 인증에 반영된다.

## 배포 설정

Helm `clientApiKeys.enabled=true`는 local/SAML 인증과 지식 발행·서명 배포가 구성된 서버에서 사용한다. `publicBaseUrl`은 클라이언트가 접근하는 HTTPS 주소여야 한다. 연결 설정 API는 요청 Host를 사용하지 않고 이 고정 주소를 사용한다.

사설 CA 환경은 `clientApiKeys.connectionCa.existingConfigMap`과 `key`로 웹 서버 인증서를 검증할 **공개 CA**를 명시한다. 런타임에는 `CLIENT_CONNECTION_CA_FILE`로 전달되고 서버 컨테이너에만 mount된다. 지정하지 않으면 연결 설정의 `ca`는 null이며 클라이언트의 기본 TLS 신뢰 저장소를 사용한다. DB CA 설정은 자동으로 가져오지 않는다. CA 파일에 인증서 외 내용이나 private key가 있으면 서버 시작을 거부한다.

`GET /api/v1/me/client-connection-config?repositoryId=<UUID>`는 로그인된 웹 session과 현재 저장소 권한을 확인한다. Bearer key로 이 API를 사용할 수 없으며 응답은 `private, no-store`다. 서명 private key는 서버의 기존 Secret에 유지한다.

웹 검증은 Chrome에서 테스트 API로 발급·복사·다운로드·원문 제거·응답 유실·폐기·모바일 표시를 확인한다. 실제 PostgreSQL 통합 테스트는 권한, 세션, 원문 비저장, bearer 제한, 발급·폐기 및 서명 지식 전송을 별도로 검증한다. 운영 클라이언트 연결 완료는 배포 후 별도 실행 증거로 판정한다.
