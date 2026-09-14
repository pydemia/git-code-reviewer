# 중앙 PR 분석의 공용 기준

중앙 PR 분석은 로컬에 배포하는 policy·collective 발행본과 공용 선택 함수를 사용한다. 이 경로는 중앙이 수집한 PR snapshot에만 적용한다. 로컬 코드·리뷰 결과·피드백·대화를 전송하거나 로컬 실행을 중앙 모델에 맡기는 API를 추가하지 않는다.

분석 접수 transaction에서 현재 공개된 두 bundle의 bytes·hash·tenant/repository·component를 검증하고 원문과 release ID·sequence를 분석에 고정한다. Analysis key와 policy hash에 이 고정값의 hash를 포함한다. 실행 시점의 새 발행본으로 바꾸지 않는다. 같은 입력의 운영 재시도는 고정값과 이미 기록된 선택 context도 복사한다. 새 기준을 적용하려면 새 snapshot 분석을 요청한다. 기존 분석에는 발행본을 소급 연결하지 않는다.

공용 PR 분석은 personal bundle을 조회하지 않는다. 승인된 collective projection을 사용하고 이전의 raw collective Memory recall을 모델 입력에 겹쳐 넣지 않는다. 기존 사용자별 비공개 분석의 개인 Memory 기능과 공용 PR 게시 금지는 유지한다. 발행된 Skill도 queue 당시 bundle에서 고정한다.

기준 선택 전 동일 head/merge-base Git SHA에서 전체 변경 파일을 읽는다. 삭제 파일은 merge-base를 사용한다. 200줄 단위 응답의 SHA·경로·줄 범위·내용 hash를 검사하고 합친 UTF-8 원문의 Git blob hash를 다시 계산한다. 잘린 긴 줄, 누락 페이지, 변조된 workspace 파일, 다른 SHA는 적용 범위를 판단하는 원문으로 사용하지 않는다. 최대 500개 파일·총 8 MiB·파일당 512페이지와 준비 루프 120초를 제한한다. 개별 source tool의 기존 timeout이 별도로 적용되므로 실행 중인 한 요청만큼 전체 시간이 길어질 수 있다.

로컬과 같은 resolver가 파일 경로·언어·branch·symbol/contract의 어휘상 일치, 예외 기간, 예산을 처리한다. Branch는 관측한 PR head SHA가 snapshot 요청과 같을 때만 고정한다. Symbol/contract 일치는 현재 결함을 입증하지 않는다. 변경 원문과 반증을 검토해야 한다. 선택 context는 별도 불변 이력으로 저장하고 결과의 versions에 발행본·context hash를 기록한다. 이 기록만으로 개별 finding이 특정 기준 위반임을 확정하지 않는다.

필수 발행본·전체 원문·기준 예산을 확인하지 못하면 모델 호출을 생략하고 분석을 partial로 기록한다. 예외·만료 경계에 도달하면 추가 기준 사용을 멈추며 실행 중 경계를 지난 결과도 미완료로 남긴다. 원문 조회에 실패했는데 공용 기준 상태를 ready로 표시하지 않는다. 발행 기능을 명시적으로 끈 설치는 disabled, 도입 전 분석은 legacy로 구분하며 기존 분석 경로를 유지한다.

`GET /api/v1/analyses/:analysisId/shared-knowledge`는 기존 분석 조회 권한과 개인 분석 소유자 검사를 적용한다. Summary의 공용 리뷰 기준 버전에서 고정한 release, 선택된 기준·Skill·집단 Memory의 이름/버전과 적용 파일을 확인한다. 이 API는 원문 bundle이나 개인 context를 반환하지 않는다. 선택되었다는 표시는 모델 실행이나 테스트 검증 결과와 별개다.

공용 library alpha38에 `selectSharedKnowledge`를 추가했다. 기존 centralized selector와 bundle wire 계약은 유지한다. 설치된 Commit Defender 2.9.4의 alpha37과 CLI alpha33을 바꿀 필요는 없으며 이번 배포에서 로컬 모델·계정·확장 호스트를 변경하지 않는다.

남은 범위는 실제 허용 모델·저장소 표본의 client/central 리뷰 대조, trusted CI 근거, 재발·managed comment·관측 가능한 운영 지표다. Critical 철회와 offline 정책도 별도 검증이 필요하다. 이번 checkpoint를 P13 전체 또는 전체 개발 목표의 완료로 집계하지 않는다.

개별 지적의 기준 판단 연결·검증·표시는 [중앙 지적의 공용 기준 판단](central-finding-criteria.md)을 따른다. 연결 정보는 모델 판단의 provenance이며 결함 확인을 뜻하지 않는다.
