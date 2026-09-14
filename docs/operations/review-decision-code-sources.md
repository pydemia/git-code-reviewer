# 코드 변경을 근거로 하는 리뷰 기준

중앙에서 새 Git snapshot을 수집하면 파일별 텍스트 diff를 기준 후보의 출처로 선택할 수 있다. PR 논의·집단 메모리·수동 검토 기록과 함께 선택하며 유지관리자가 후보를 작성하거나 기존 모델 후보 생성 기능을 사용한다. 결과는 draft로 저장된다. 결함·수정·정상·반증 평가와 명시적 승인 없이 활성 기준으로 발행하지 않는다.

출처는 snapshot ID, PR 번호, 현재/이전 파일 경로, 변경 종류, 대상 브랜치 base SHA, merge-base SHA, head SHA와 diff 원문에 고정된다. Diff의 변경 전 기준은 merge-base이며 대상 브랜치 tip인 base SHA와 다를 수 있다. PR에 새 commit이 추가돼도 과거 snapshot 출처는 유지한다. 파일 전체 문맥, 실행 검증, 결함 수정 여부를 diff 관측만으로 판정하지 않는다. 서로 다른 endpoint의 지적을 주제 유사도만으로 합치지 않도록 후보 생성 지침에 명시했다.

Migration 0048의 `snapshot_change_sources`는 snapshot file에 종속된다. Hash는 원문과 코드 metadata를 함께 포함하며 선택·생성 전후·발행 시 다시 확인한다. 다른 저장소의 파일 ID, 변경된 hash 또는 없는 출처는 사용할 수 없다. 출처가 사라진 기준은 다음 발행에서 제외하고 이전 불변 bundle은 보존한다. 삭제 즉시 재발행을 요청하는 처리와 재검토 UI는 후속 P12-C04 범위다.

원문을 잘라서 완전한 출처처럼 표시하지 않는다. Binary·빈 diff·12,000자 초과·unresolved snapshot은 기준 출처로 복사하지 않으며 기존 artifact는 그대로 보관한다. 기존 snapshot의 출처를 소급 생성하지 않는다. 화면에는 최근 snapshot의 코드 출처를 최대 100개, 기존 논의·메모리를 최대 200개 제공한다. 과거 snapshot의 범위 지정 재수집과 전체 파일 문맥을 근거로 하는 판단 연결은 후속 범위다.

발행물에는 승인한 기준과 `snapshot-change` 출처의 ID·hash만 포함한다. 중앙에 보관된 diff·코드 metadata·원문 논의를 로컬 bundle에 추가하지 않는다. 로컬 source·결과·피드백 전송 경로와 중앙 executor를 추가하지 않는다. 내려받은 기준은 로컬에 설정된 모델·계정으로 적용한다.

코드 출처 참조는 지식 계약 v3에서 지원한다. Client libraries `0.1.0-alpha.37`, CLI `0.1.0-alpha.33`, Commit Defender `2.9.4`를 함께 배포한다. 서버는 발행된 bundle의 실제 내용을 검사해 최소 버전을 서명하며 코드 출처가 있는 경우 v2 manifest 요청에 HTTP 426을 반환한다. 기존 내용만 있으면 v2·v3 모두 허용한다. 새 클라이언트는 기존 v2 발행물과 캐시를 읽으며 이전 서버가 v3 요청을 HTTP 426으로 거절할 때만 같은 서버에 v2를 한 번 요청한다. 인증 실패·네트워크 오류·redirect에서는 버전을 바꾸어 재시도하지 않는다.
