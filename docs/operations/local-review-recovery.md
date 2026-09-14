# 중단된 로컬 리뷰의 결과 복구

Client alpha.27 / CLI alpha.23은 이미 저장된 terminal 보고서를 원래 실행 요청과 서비스 receipt에 다시 연결한다. 복구 명령은 모델을 준비하거나 호출하지 않고 현재 작업 파일도 캡처하지 않는다. 보고서의 실패·부분 완료 상태를 성공으로 바꾸지 않는다.

## CLI

원래 repository/worktree, profile, data directory를 사용한다. `requests`에서 실행 key·generation·상태를 확인한다.

```sh
gcr requests --cwd /absolute/repo --profile work
gcr requests reconcile --key REQUEST_HASH --generation 1 --cwd /absolute/repo --profile work
```

중앙 요청에는 원래 `--mode centralized --connection CONNECTION_ID`가 필요하다. 확인된 권한 철회·다른 connection·다른 profile은 중앙 보고서 복구를 허용하지 않는다. 해당 연결의 standalone fallback 결과는 중앙 자료를 포함하지 않는 원래 로컬 이력에서 읽는다.

`status: reconciled`와 종료 코드 0은 저장된 보고서를 확인했다는 뜻이다. 응답에는 `request`와 원본 `report`가 포함된다. `status: unresolved`와 종료 코드 2는 아직 유효한 실행 lease, 완료 receipt 부재 또는 저장 이력 부재를 뜻한다. 명령 오류 역시 종료 코드 2이므로 JSON의 상태와 오류를 함께 확인한다.

## 백그라운드 서비스

```sh
gcr service status --profile work
gcr service job --id RECEIPT_ID --profile work
gcr service reconcile --id RECEIPT_ID --profile work
```

별도 data directory를 사용했다면 모든 명령에 같은 `--data-dir`을 전달한다. 서비스 status의 `features`에 `review-reconciliation-v1`이 있어야 한다. 이전 서비스가 실행 중이면 활성 작업이 끝난 것을 확인한 뒤 새 CLI로 서비스를 재시작한다. `service stop`은 실행 중 작업을 취소하므로 단순 버전 확인을 위해 호출하지 않는다.

서비스 재시작은 기존 running receipt를 interrupted로 바꾼다. `service reconcile`은 해당 receipt에 연결된 요청 key/generation만 검사한다. 새 source·보고서 ID·계정은 명령 인수로 받지 않는다. 등록 revision이나 trigger 권한이 바뀌면 복구를 거부한다. 복구 후 `state: finished`와 원본 report의 run ID·status·exit code를 기록하고 서비스의 고정 source payload를 삭제한다. 해결하지 못한 작업은 interrupted로 남으며 이때 명령 종료 코드는 2다.

서비스가 살아 있지만 요청 완료 기록이나 이력 저장에 실패한 경우에도 `completionUnconfirmed: true`와 interrupted 상태를 남긴다. 보고서 ID가 보인다는 이유만으로 해당 작업을 완료로 표시해서는 안 된다. 필요 없는 queued/interrupted 작업은 `service cancel --id ID`로 취소하고 payload를 삭제할 수 있다.

## 복구 근거와 제한

공통 실행기는 모델에서 terminal 보고서를 받은 뒤, 이력 저장 전에 보고서 ID·canonical hash·실행 generation을 별도 암호화 receipt에 기록한다. 요청 journal의 기존 format은 유지하므로 이전 client도 요청을 읽을 수 있다. 복구에서는 그 receipt와 저장된 보고서의 전체 hash·execution identity·현재 인가를 확인한다. 같은 소스에 대한 이전 generation의 보고서는 재사용하지 않는다.

살아 있는 lease가 남아 있으면 복구를 보류한다. Lease 만료만으로 모델의 종료를 추정하지 않으며 terminal receipt와 실제 저장 보고서가 모두 있어야 완료를 연결한다. 새 client에서 generation은 claim한 실행 시도를 나타내고, running → interrupted 전환은 owner token을 제거해 이전 소유자의 heartbeat/finish를 차단한다. 새 실행 시도가 없으므로 그 전환에서 generation을 늘리지 않는다.

이 기능 이전에 완료 receipt 없이 중단됐거나 이전 client가 별도 generation으로 fence한 기록은 자동 추정하지 않는다. 기존 hash와 비슷한 보고서를 찾거나 모델을 재호출하는 방식으로 복구하지 않는다. Receipt 저장 실패가 일반 이력 저장까지 막지는 않으며 복구 근거가 없는 경우 원래 보고서는 이력에서 직접 확인할 수 있다.

현재 단계는 공통 core와 CLI/service 경로다. Commit Defender의 복구 선택 UI와 새 service artifact 전달, 사용자 전체 예산·이력 보존 정책·나머지 P07 완료 조건은 후속 작업이다.
