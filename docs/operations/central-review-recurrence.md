# 중앙 리뷰의 이전 관측 비교

중앙 PR 분석을 저장할 때 같은 PR의 직전 공용 completed/partial 보고서와 비교한다. 개인 분석은 비교 대상에서 제외한다. 다른 PR을 검색하거나 로컬 코드·결과·피드백을 받지 않는다. 중앙에서 로컬로 리뷰·프롬프트를 내려받는 흐름과 로컬 모델·계정은 유지한다.

새 보고서의 `findings[].occurrence`는 확인한 diff 코드 구간, 경로·side, 정확한 문제 설명, producer·kind·rule·category, 기준 ID·revision·hash·판정, 분석 versions와 공용 policy pin의 hash로 구성한다. 줄 번호는 포함하지 않아 코드가 이동해도 조건이 같으면 연결된다. 영구 rule ID나 의미적 결함 식별자가 아니다. 설명·경로·설정이 바뀌면 같은 결함이어도 연결되지 않을 수 있다. 코드 구간을 확인하지 못했거나 P0인 지적에는 부여하지 않는다. 같은 식별자가 보고서 안에서 중복되면 연결을 보류한다.

`report.recurrence`는 비교 기준 보고서와 SHA, 현재 지적별 same-head/observed-again/not-in-baseline/untracked/ambiguous, 재확인하지 못한 이전 지적을 보관한다. 현재 지적을 제거하거나 우선순위를 낮추지 않는다. 이전 지적이 사라졌다는 이유로 수정 완료를 판정하지 않는다. 직전 보고서의 artifact 상태·크기(8 MiB)·checksum·분석 ID를 검증하고 보고서당 2,000개 지적으로 제한한다. 읽기 실패나 기존 식별자 부재는 unavailable이며 더 오래된 보고서로 대체하지 않는다. 기존 보고서에 소급 기록하지 않는다.

웹의 “이전 리뷰와 비교”에서 비교 보고서와 재확인할 지적을 열 수 있다. JSON/API와 Markdown에도 결과를 유지한다. 모델 설명은 텍스트로 표시한다. 비교는 저장 시점의 이력으로 고정되며 뒤늦게 끝난 이전 분석 때문에 기존 결과를 바꾸지 않는다.

GitHub 관리 댓글은 같은 분석의 재시도로 새 댓글을 만들지 않으며 새 분석은 기존 댓글 ID를 갱신한다. PostgreSQL의 `(created_at,id)` 순서로 비교해 밀리초 미만 간격도 구분한다. 오래된 job이 더 최신 target을 덮거나 비활성화하지 않도록 제한한다. 개인 분석과 DB에서 마지막으로 관측한 PR head와 다른 분석은 게시하지 않는다. 게시 직전에 GitHub의 실제 head를 다시 조회하는 기능은 아직 없으므로 관측 이후 변경에 대한 race가 남는다. 원격 성공 직후 프로세스 중단의 복구는 기존 관리 marker와 publisher 경로를 사용한다.

추가 migration은 없으며 새 분석 key는 default v10/v7이다. 실제 PostgreSQL·분석기·API·browser와 합성 모델 및 publisher로 줄 이동, 같은 SHA 재시도, 중복 위치, 다른 PR/개인 이력 격리, artifact 오류, 댓글 갱신 순서를 검증한다. 합성 모델과 publisher 검증은 실제 모델 판단 품질이나 실제 GitHub 게시의 증거가 아니다. 실제 모델 표본, 신뢰할 수 있는 CI 근거, 게시 직전 원격 head 검증, 비용·품질 지표와 복구 검증은 남아 있다.
