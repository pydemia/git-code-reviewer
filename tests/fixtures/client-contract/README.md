# 공통 client report fixture

P02-C01의 JSON 계약과 CD projection 호환성을 검사하는 합성 표본이다. 실제 모델·runner를 호출하지 않았다. `test-evidence-claim`의 `test-confirmed`도 형식 검증용 client claim이며 실행·정확도 증거가 아니다.

`reports.json`은 source·base 본문, 12개 report와 수작업으로 정한 CD status·CLI exit code·comment 수를 포함한다. GCR의 contract test와 CD의 설치된 contract package test가 같은 파일을 소비한다. CD 복사본의 SHA-256은 소비 기록에서 고정한다.

- Source는 `load()`가 number 대신 undefined를 반환하는 TypeScript 파일과 별도 caller다. 본문 SHA-256·byte length·line count·Git blob SHA-1을 테스트에서 대조한다.
- Base commit/tree와 변경 tree는 임시 Git repository에서 생성한 값이다. 작성자/committer는 `Contract Fixture <fixture@example.invalid>`, 시각은 `2026-01-01T00:00:00Z`, commit message는 `synthetic base`다. 실제 사용자 저장소와 관계없다.
- Profile·repository·worktree·model·runner·환경 식별자는 합성 값이다. Source/context hash는 이 fixture의 고정 식별자이며 향후 core의 canonical hash 구현을 이미 검증했다는 의미가 아니다.
- `clean`, legacy verified, partial, failed, cancelled, needs-context, 후속 질문, accepted exception, source evidence, test evidence claim, executor unavailable, working tree를 구분한다. 실패·취소·필수 context 누락은 성공 exit code가 되지 않는다.
- Legacy `verified`와 confidence는 그대로 두고 evidence는 unassessed로 시작한다. 예외가 허용된 위반은 violation과 exception ID를 보존한다. P3와 rule의 block 설정은 CD display projection에서 자동 hook 차단을 만들지 않는다.

설치 artifact는 별도 version과 hash로 전달하며 이 JSON은 package의 runtime 파일에 포함하지 않는다.
