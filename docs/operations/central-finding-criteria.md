# 중앙 지적의 공용 기준 판단

중앙 분석의 모델은 공용 policy 기준을 판단한 지적에 `criterion_assessments`를 선택적으로 반환한다. 각 항목에는 발행된 기준 ID·revision·hash, `violation`/`satisfied`/`uncertain`, 현재 코드에 대한 판단 이유와 반증 검토 상태·설명이 필요하다. Skill·Memory를 policy 기준으로 인용하지 않는다. 기준의 severity와 지적의 priority는 서로 다른 척도이며 직접 복사하지 않는다.

정규화 시 runtime이 고정한 selection과 ID·revision·hash·파일 경로·side를 대조한다. 현재 diff에서 확인한 코드 위치도 필요하다. `source`는 head, `base`는 mergeBase다. 예외로 제외된 대상, 다른 파일/side, 다른 버전, 임의 ID와 hash, 위치를 확인하지 못한 지적은 연결할 수 없다. P0에는 충족 판단만 허용한다. 반증 미검토 상태에서는 `uncertain`만 연결한다. 같은 기준의 중복 판단도 제외한다.

보고서의 `findings[].criteria`는 `linked`/`not-reported`/`unavailable`, 제외 개수와 연결된 항목을 가진다. 제목·원문 hash·발행본 pin hash·selection context hash는 모델 출력 대신 고정 context에서 가져온다. `evaluator=model`, `validation=pinned-target`는 버전과 적용 대상의 연결만 뜻한다. 판단 이유와 반증 검토 내용은 모델의 보고이며 실제 결함이나 테스트 성공을 검증한 기록이 아니다. 판단이 없다는 사실을 기준 통과로 해석하지 않는다. 연결 검증에서 제외된 항목이 있으면 분석은 partial이다.

기준 연결은 report JSON artifact에 보존하며 기존 분석·지적 API와 JSON/Markdown export에서 제공한다. 웹은 지적별 펼침 영역에 판단·이유·반증·식별 정보를 표시한다. 제목과 모델 설명을 실행 가능한 HTML로 렌더링하지 않는다. 요약 단계에는 정규화 전 기준 참조를 전달하지 않는다. 기존 보고서에 새 필드를 소급 생성하지 않으며, 새 기준으로 기존 분석을 재해석하지 않는다.

추가 DB migration은 없다. 새 queue 분석의 algorithm/policy key는 default v9/v6이다. Local CD/CLI의 모델·계정·설정, 설치 버전, 중앙에서 로컬로 내려받는 bundle 계약은 유지한다. Local 코드·리뷰 결과·피드백 업로드와 중앙 대리 실행 경로를 추가하지 않는다.

18개 suite 235건이 PostgreSQL·Git·합성 모델·실제 API와 browser를 검증했다. 기준 발행 후 퇴역/재발행해도 기존 분석의 criterion identity를 유지한다. Browser는 실제 API에 연결해 1360/420px의 판단·반증·hash를 표시한다. 이전 fixture의 lean 설정이 P2 지적을 제거하므로 해당 fixture에 별도 rigorous prompt version을 만들었다. 이 검증에는 실제 외부 GitHub나 유료 모델 호출이 없다. 실제 모델의 판단 품질·client/central 표본 대조, trusted CI와 재발·게시·운영 지표는 후속 범위다.
