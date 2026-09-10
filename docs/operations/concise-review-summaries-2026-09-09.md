# 지적 사항 없는 파일 요약 문구 변경

## 적용 범위

사용자가 요청한 표시 문구는 `검토한 변경 범위에서 문제가 발견되지 않았습니다.`다. AI/hybrid 분석에서 파일 상태가 `reviewed`, `unitIds`가 빈 배열, priority가 null이고 실제 finding도 없는 경우에만 적용한다. 실패·미수행·demo 분석과 Legacy 파일에는 적용하지 않는다. 일부 파일이 미완료인 PR에서도 완료 조건을 충족한 개별 파일은 짧게 표시하되 전체 분석 상태·제한 안내를 유지한다.

`presentReviewReport`의 표시 결과만 바꾸므로 저장된 report와 Raw JSON은 수정하지 않는다. Browser Summary, Markdown export와 향후 정상 PR 게시가 같은 규칙을 사용한다. 기존 GitHub 댓글은 일괄 갱신하지 않는다. 전체 Summary가 파일 요약을 이어 붙인 Legacy fallback이면 원문 기준으로 중복을 판별해 PR 전체 요약 영역에 다시 노출하지 않는다.

Impeccable의 copy 검토 기준에 따라 성공으로 단정할 수 있는 조건을 먼저 확인했다. 별도 재분석·모델 호출이나 UI layout 변경은 필요하지 않다.

## 검증

- PostgreSQL integration을 포함한 66개 파일·414개 테스트 통과. 첫 전체 실행은 임시 PostgreSQL 초기화 중 연결이 끊겨 실패했으며 readiness 확인 후 전체 재실행으로 통과했다.
- Typecheck·lint·production build·Helm lint·server-side dry-run 통과. 기존 Zod annotation·500 kB bundle warning은 유지된다.
- 단위 테스트에서 원본 보존, PR 전체 요약·제한 유지, Legacy rollup 중복 방지, partial/not-reviewed·failed/unavailable/demo 및 finding·unit·priority가 있는 경우를 검증했다. React SSR도 실제 Summary 문구를 확인한다.
- 게시 image의 read-only·network-none 실행에서 UID 1000, 새 문구·원본 보존, build CA 미포함을 확인했다. SPDX SBOM·SLSA provenance를 함께 게시했다.
- 로그인 Browser의 기존 PR #917 Revision 2에서 새 JS asset `index-6gEauHtP.js`, 짧은 파일 요약 11개, PR 전체 요약·분석 제한 2건과 기존 Comments를 확인했다. Desktop 2501×1257 screenshot에서 새 문구를 판독했다. Browser error log는 없었다.
- Mobile 390×844 DOM에서 새 문구 11개와 가로 overflow 없음, 본문 14px·문단 폭 336px를 확인했다. Screenshot은 축소된 capture와 CDP timeout으로 시각 검증에 쓰지 못했다. 200% zoom은 미검증이다. Viewport override를 해제하고 검증 탭을 닫았다.

범위 밖 관찰: 의견 없는 파일의 제목 버튼을 클릭하면 Summary 탭에 머무르는 기존 동작이 보였다. 이번 변경은 표시 문자열만 다루며 해당 navigation handler는 수정하지 않았다. 파일 선택과 Code 탭 전환은 후속 UI 점검 대상으로 남긴다.

## PRISM-DEV 배포

Source `06104794cb2ed1e59c05bc1b57d9d119fc8dc4c5`, release pin `783e5db`를 push했다. 2026-09-09 08:37:15 KST에 `0.8.0-alpha.25` / chart `0.10.24` / Helm revision 36으로 upgrade했다. Digest는 [배포 문서](../../deploy/environments/prism-dev/README.md)에 있다.

Server `git-code-reviewer-server-7bd7bd9df8-md4kh` 1/1, Worker `git-code-reviewer-worker-8dcbb86f6-cv7p4` 2/2 Ready이며 restart 0회다. Health 4종 HTTP 200·ok, system alpha.25, 08:38:53 Helm test 성공과 migration 28개 checksum 일치를 확인했다. 새 Server·Worker의 확인한 log에 warning/error가 없었고 활성 job은 0건이었다.

Image 외 Helm values SHA-256은 `5f3eb1ed55f94d7ce9048eb9ef17e4b92400f3533ed9c8a5da1823ef66bb05c9`로 동일하다. Auth·credential registry·PostgreSQL Secret, corporate CA, HTTPRoute UID/resourceVersion이 유지됐다. 두 PVC의 UID·PV를 보존했으며 artifact PVC의 resourceVersion만 upgrade 중 갱신됐다. Users 7명·Chat accounts 4개·analyses 65건·reports 57건을 유지했다.

기존 report의 표시 결과를 read-only로 검증했다.

| 기존 분석 | 새 짧은 문구(UI/Markdown) | 미검토 파일 | 유지한 제한 | 원본 SHA-256 |
| --- | --- | --- | --- | --- |
| #917 Revision 2 `3a0a9c85-63df-4afa-8f69-45d2f5168136` | 11개 | 0개 | 2건 | `b00b24974ecaaec01e193ae758b61a19003269b09048a313ea5bb01c754ad094` |
| 이전 미완료 `c3dfc29c-b34e-4214-b3a1-e8375179d30f` | 2개 | 21개 | 27건 | `8fc5f68934542df5775c76a3ba6fe167a0ed6d7a0a92ecb2dc79f8231cb03c6a` |

재분석·Chat·GitHub 댓글 게시를 실행하지 않았다. 임시 테스트 DB는 종료·삭제했다. 이전 alpha.22 Terminating Pod는 배포 전 이미 사라져 있었다. alpha.24 Worker `git-code-reviewer-worker-65db587cd7-h27zs`는 Worker container 종료 후 source-sandbox의 기존 종료 유예 중이며 강제 삭제하지 않았다.
