# 2026-09-08 분석 실패 조사와 수정

PRISM-DEV 운영 DB와 저장 artifact를 읽어 9월 8일 19:44 KST까지의 분석 56건을 조사했다. 완료 12건, 부분 완료 36건, 실패 8건이다. 완료에는 초기 fixture·모델 비활성 profile 11건이 포함되므로 이 숫자를 AI 성공률로 해석하면 안 된다. 사용자 질문·답변과 credential 원문은 집계에 사용하지 않았다.

## 실패 원인

실패 8건 모두 최종 오류는 `Artifact integrity conflict`였다. 최초 시도의 report와 relationship artifact는 남아 있었지만 DB transaction이 rollback되어 report 조회가 불가능했다. 저장된 graph 8개 모두에서 동일 파일의 같은 이름을 가진 Python 함수·메서드가 `qualified_name`을 공유했다. 기존 `(analysis_run_id, qualified_name)` 고유 제약을 격리된 PostgreSQL에 재현하면 8건 모두 `23505`가 발생한다.

이후 재시도는 UUID·분석 시간·모델 출력이 다른 결과를 동일한 `report.v1.json` 경로에 쓰려고 했다. Artifact store의 정상적인 무결성 검사가 이를 거부하면서 최초 DB 오류가 파일 충돌로 가려졌다. 실패 8건에는 최초 시도와 재시도를 합쳐 24회 실패 시도가 있었으며, 16회는 재시도 대상이었다.

처음 사용량 점검에서 `.json`을 포함한 오류 문자열을 모델 응답 형식 오류로 분류한 것은 잘못이었다. 최종 실패 8건의 원인은 위 DB·artifact 저장 문제다.

## 부분 완료 원인

아래 건수는 같은 분석에 여러 원인이 중복될 수 있다.

| 기록                                      | 부분 완료 분석 수 |
| ----------------------------------------- | ----------------: |
| 지원하지 않는 언어의 symbol adapter       |                36 |
| 모델 호출 예산 초과, Total Summary 미완료 |                14 |
| Overall Summary 미완료                    |                13 |
| 생성 파일·lock 파일 제외                  |                 9 |
| 분석할 변경 line 없음                     |                 4 |
| 모델 비활성                               |                 2 |
| 파일 요약 모델 호출 또는 응답 검증 실패   |                 1 |
| Skill·code segment 불일치로 comment 제외  |                 1 |

고정된 80-line window별 호출과 파일별·전체 요약이 32회 예산을 공유했다. 예를 들어 OpenAPI JSON 하나가 53개 window로 나뉘어 뒤쪽 파일이나 요약에 쓸 예산이 먼저 소진됐다. 기존 generic 모델 오류 1건은 저장 기록만으로 timeout과 응답 검증 실패를 구분할 수 없다.

## 수정

- 같은 이름의 추가 심볼에는 정의 line을 붙이고 겹친 diff hunk의 동일 HEAD line은 한 번만 처리한다. 별도 선언과 관계·evidence를 삭제하지 않는다.
- Report·relationship artifact 경로에 내용의 SHA-256을 넣는다. DB rollback 후 다시 생성한 결과는 이전 파일과 충돌하지 않으며 기존 파일을 덮어쓰지 않는다.
- DB 저장 시 analysis row를 잠그고 이미 발행된 report를 다시 확인한다. 동시 발행은 먼저 저장된 결과를 유지하며 이미 완료된 분석의 진행 상태를 되돌리지 않는다.
- 기본 호출 예산을 128회로 조정한다. 기존 `ANALYSIS_MAX_MODEL_CALLS` 명시 설정은 그대로 우선한다. 파일·전체 요약 호출을 계산해 필요하면 core window를 80→160→320→500 lines로 조정한다. Core line을 누락하지 않으며 기존 revision·line evidence 검증을 유지한다.
- 예산이 여전히 부족하면 파일·전체 요약용 호출을 남기고 미검토 범위는 부분 완료로 표시한다. 초과 호출이나 검토하지 않은 범위의 성공 처리는 하지 않는다.
- 모델 호출·응답 검증 실패는 남은 예산 안에서 한 번만 재시도한다. 최종 오류에는 timeout·응답 형식·기타 호출 실패를 구별하는 안전한 코드를 남기고 provider 원문은 노출하지 않는다.
- 미지원 언어의 symbol adapter 제한은 relationship·impact coverage에 남긴다. 이 제한만으로 성공한 AI 코드 리뷰까지 부분 완료로 분류하지 않는다. Lock 파일 제외, 미검토 line, 모델 실패는 그대로 공개한다.
- `pnpm-lock.yaml`, `npm-shrinkwrap.json`, `bun.lockb`도 생성된 dependency lock으로 분류한다.

호출 예산 증가는 상한 증가이며 큰 PR의 처리 시간·모델 사용량도 늘 수 있다. 모델 인증·네트워크·용량 문제나 명시적인 분석 제한까지 성공으로 바꾸는 수정은 아니다.

## 검증

누적 실패 8건과 호출 예산 문제가 기록된 부분 완료 14건의 실제 snapshot을 격리된 local DB에서 재생했다. 기존 graph 8개의 고유 제약 오류를 재현했고 수정된 graph 22개는 모두 저장됐다. Staged model 응답은 회귀 테스트용 fixture를 사용했다. 이 재생은 실제 AI 답변의 품질 검증이 아니다.

22건 모두 model window와 파일·전체 요약이 호출 예산 안에서 끝났으며 최대 124회였다. 호출 예산 초과와 요약 누락은 0건이고 생성 파일·lock 파일의 명시적인 제외만 남았다. 운영 DB의 과거 실패 이력과 원본 artifact는 변경하지 않았다.

회귀 테스트는 DB rollback 뒤 재시도, 이전 canonical artifact 보존, 동시 report 발행의 단일 결과, 중복 심볼, window 확장 시 전체 line 포함, 요약 예산 예약, 일시적 모델 오류 재시도, YAML 리뷰와 graph coverage 분리를 포함한다.

배포 버전·digest와 live 검증 결과는 [PRISM-DEV 배포 기록](../../deploy/environments/prism-dev/README.md)에 기록한다.
