# PR 상태 동기화와 Worklist 필터

## 변경 이유와 동작

기존 polling은 Open PR만 읽고 응답에 없는 기존 PR을 Closed로 추정했다. Merged 여부를 저장하지 않았으며 목록 API도 Open만 반환했다.

이번 변경은 GitHub의 명시적 `state`와 `merged_at`을 저장한다. Open, Closed, Merged, reopen 전환을 반영하며 Merged는 Closed 집합에 포함한다. `Open / Closed / All`은 상호 배타적인 목록 필터이며 기본값은 Open이다. 각 건수는 선택한 Tenant에서 접근 가능한 repository의 합계다. PR 상태와 분석 평가는 별도 표시한다.

Polling 주기에 따라 저장된 상태가 갱신된다. Worklist의 **새로고침**은 저장된 목록을 다시 읽는다. 즉시 GitHub polling이 필요하면 관리 → GHES 연결의 해당 repository에서 **지금 Poll**을 실행한다. Polling을 중지했거나 credential/네트워크 오류가 있으면 GitHub 변경이 반영되지 않으므로 관리 화면에서 원인을 확인한다.

Migration `0029_pull_request_state_sync.sql`은 `pull_requests.merged_at`을 추가하고 Open 전용 ETag를 비워 전체 상태 동기화를 예약한다. 첫 동기화에서 과거 Closed/Merged PR은 metadata만 가져온다. 과거 PR 전체 분석이나 대화 전체 backfill은 실행하지 않는다. 과거 PR이 reopen되면 해당 SHA의 snapshot request가 없는 경우에만 새 분석을 예약한다. 기존 report·Chat·Memory는 수정하지 않는다.

Closed/Merged에 저장된 분석이 있으면 기존 report를 열고 없으면 GitHub 원문을 새 tab으로 연다. 이 기능은 token의 추가 write 권한을 요구하지 않는다.

## 구현 경계

- GitHub App/PAT 공통 adapter: `state=all&sort=updated&direction=desc&per_page=100`, 첫 page에만 conditional ETag. 변경이 있으면 전체 page를 읽으며 1,000 page 안전 한도를 넘거나 중간 page가 실패하면 부분 성공으로 저장하지 않는다.
- 목록 API: `GET /api/v1/repositories/:id/pulls?state=open|closed|all&cursor=...`. 100개 단위 `nextCursor`와 전체 `counts`를 반환한다. 기존 Tenant/repository 인가 범위를 유지한다.
- Browser: 모든 page를 읽고 ID 중복을 제거한다. Filter/Tenant 변경 시 이전 요청을 취소하고 늦은 응답을 버린다. 선택은 URL query로 유지한다. Poll 실패/최초 대기를 표시하며 로딩 중 건수를 0으로 표시하지 않는다.
- GitHub 명세: [List pull requests](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#list-pull-requests).

## 로컬 검증

- PostgreSQL 17의 격리 schema에서 state/merge/reopen, 과거 PR의 자동 분석 방지, 같은 SHA 중복 분석 방지, 304·API 실패·목록 누락 시 기존 state 보존을 검증했다.
- GitHub adapter 21 page/2,001 PR, 목록 API 208 PR 및 Closed 207개 3 page, 권한 없는 사용자와 잘못된 filter/cursor를 검증했다.
- 전체 테스트 427개/69개 파일 통과(`--maxWorkers=4`), typecheck·lint·production build 통과. 제한 없는 병렬 실행은 공통 migration advisory lock 대기 중 기존 user-deletion suite의 10초 setup timeout이 발생해 동시 worker 수를 줄여 재검증했다. 테스트 timeout 값을 변경하지 않았다.
- 로컬 synthetic PR로 Open 3 / Closed 2 / All 5, Draft/Merged 표시, Closed 외부 링크, URL refresh 후 필터 유지, browser error 없음 확인. 1440×1000·390×844·2501×1257 screenshot을 확인했고 390px에서 가로 overflow가 없었다.

## 배포 검증

2026-09-09 09:23:16 KST에 PRISM-DEV `git-code-reviewer` namespace/release를 Helm revision **37**로 배포했다. Source는 `fafb3d55d32a6e68bc656ba6dff5108863ef39cc`, release pin은 `a528a1d`다. Backend commit `38bcc39`, UI commit `fafb3d5`와 release pin을 push한 뒤 적용했다.

- Application `0.8.0-alpha.26`, chart `0.10.25`.
- Image index: `sha256:5dc370f103e56978d8abcbca42729e62353fc3bce69032cb9405a87aae7dfc03`.
- Linux/amd64 manifest: `sha256:ea8d6ef34df9ac2fa0fece04fd4562289a080ff63e3390e75d9dd3f9f1088375`.
- OCI chart: `sha256:4977ee17c371d647d515333e241a6d38c48abae23f117c613ce2f55e90ea01af`.
- Clean `git archive`에서 build했고 SBOM·provenance를 게시했다. Container smoke에서 UID 1000, migration 29, 필터 contract와 실제 web bundle을 확인했다. Build CA는 secret mount로만 전달했으며 image 안에 남지 않았다.
- Helm lint·server dry-run과 09:24:42 Helm test가 성공했다. Gateway Host `pr-review.prism.ai`에서 health 4종과 system version을 확인했다. Node 25의 fetch로 직접 IP에 Host를 지정한 첫 probe는 nginx 404였고, 명시적 Host header를 보내는 curl과 실제 Browser에서 정상 응답을 재확인했다.
- Server `git-code-reviewer-server-6d4485bdbc-rdm5v` 1/1, Worker `git-code-reviewer-worker-7b784c494d-7657j` 2/2 Ready, restart 0회. 이전 Worker `git-code-reviewer-worker-8dcbb86f6-cv7p4`는 worker가 종료되고 source-sandbox 종료 유예 중(1/2 Terminating)이며 강제 삭제하지 않았다.

### 실제 GitHub 대조

Migration 직후 이전 Server의 마지막 Open poll이 먼저 완료됐다. 새 Server가 scheduler lease를 인수한 뒤 다음 정상 주기에 전체 상태를 수집했다. 두 repository의 최초 전체 수집 완료 시각은 각각 09:26:19·09:26:24 KST다. 등록 credential을 Server 내부에서만 사용해 GitHub의 전체 PR을 다시 읽고 PR number별 `state`와 merge 시각을 DB와 대조했다. Credential 원문과 PR 본문은 검증 기록에 출력하지 않았다.

| 대상               | Open | Closed(Merged 포함) | Merged |   All | 누락·불일치·초과 |
| ------------------ | ---: | ------------------: | -----: | ----: | ---------------: |
| Backend repository |    7 |                 873 |    828 |   880 |                0 |
| Helm repository    |    4 |                 209 |    198 |   213 |                0 |
| 합계               |   11 |               1,082 |  1,026 | 1,093 |                0 |

로그인한 실제 Browser에서도 All 1,093행, Closed 1,082행(일반 Closed 56·Merged 1,026), Open 11행을 확인했다. Closed의 기존 report 링크는 13개, 분석 없는 과거 PR의 GitHub 원문 링크는 1,069개다. 필터 전환 오류가 없었으며 검증용 탭만 닫고 기존 사용자 탭은 유지했다. 실제 repository의 Close/Reopen/Merge를 검증 목적으로 변경하지 않았다.

### 보존 확인

- Migration 29개 모두 파일 checksum과 DB 기록이 일치했다.
- Image 외 Helm values SHA-256은 배포 전후 `5f3eb1ed55f94d7ce9048eb9ef17e4b92400f3533ed9c8a5da1823ef66bb05c9`로 동일했다.
- 기존 Secret 3개, corporate CA와 HTTPRoute의 UID/resourceVersion을 유지했다. PostgreSQL RWO·artifact RWX의 `nfs-csi` PVC/PV UID와 바인딩을 유지했다. Artifact PVC의 resourceVersion만 정상 Helm 갱신으로 바뀌었다.
- 사용자 7명, ChatGPT account 4개, analysis 65개, report 57개의 ID 집합 hash가 배포 전후 동일했다. Jobs는 completed 171·failed 8로 동일했고 queued/running은 0개다. 이번 metadata backfill로 분석·GitHub 게시 job은 추가되지 않았다.
- 기존 PR #917의 완료/미완료 report 원문을 artifact storage에서 읽어 SHA-256 `b00b24974ecaaec01e193ae758b61a19003269b09048a313ea5bb01c754ad094` / `8fc5f68934542df5775c76a3ba6fe167a0ed6d7a0a92ecb2dc79f8231cb03c6a`가 유지됨을 확인했다.

Impeccable 검토는 기존 Worklist의 배치·색상·아이콘을 유지하는 범위로 진행했다. ExternalLink 수정 1건을 반영한 뒤 재검토는 `ship`이었다. [화면 기록](../../.impeccable/review/pr-state-design-record.md)과 synthetic screenshot을 보관했다. React Best Practices 검토에서 취소된 filter 요청의 늦은 응답을 차단했고 실제 browser 검증을 수행했다. 루트 DESIGN.md와 전역 토큰은 변경하지 않았다.
