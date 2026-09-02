# Backup, restore, and reconciliation

PostgreSQL은 resource identity와 참조의 정본이고 artifact PV는 immutable content를 보관한다. 두 저장소의 recovery point를 가능한 한 가깝게 맞춘다.

## Backup

1. retention CronJob을 suspend한다.
2. 새 분석 유입을 멈추거나 짧은 maintenance window를 연다.
3. PostgreSQL backup/restore point를 기록한다.
4. 그 직후 artifact PVC volume snapshot 또는 storage-native backup을 만든다.
5. image digest, Helm values, schema migration 목록을 함께 기록한다.
6. retention을 다시 활성화한다.

```bash
kubectl -n git-code-reviewer patch cronjob git-code-reviewer-retention \
  --type merge -p '{"spec":{"suspend":true}}'

pg_dump --format=custom --file=git-code-reviewer.dump "$DATABASE_URL"

kubectl -n git-code-reviewer patch cronjob git-code-reviewer-retention \
  --type merge -p '{"spec":{"suspend":false}}'
```

PV snapshot command는 cluster CSI/storage 절차를 따른다. DB dump나 artifact backup에 credential을 포함하지 않고 암호화·접근 통제를 적용한다.

## Restore

1. Server, Worker, retention을 중지한다.
2. PostgreSQL을 선택한 restore point로 복구한다.
3. 그 시점에 대응하는 artifact snapshot을 새 PVC로 복구한다.
4. Helm value의 existing PVC 또는 StorageClass를 확인한다.
5. 동일하거나 호환되는 image의 `migrate`를 실행한다.
6. `retention --reconcile`을 1회 실행한다.
7. Server와 Worker를 기동하고 health/report/deep link를 검사한다.

Reconcile은 DB artifact checksum과 PV 파일을 비교한다. 파일이 없거나 checksum이 다르면 row를 `unavailable`로 표시하고 API는 해당 artifact를 제공하지 않는다. DB가 참조하지 않는 PV 파일은 `orphanGraceHours`가 지난 뒤 bounded batch로 삭제한다. Source/report 원문은 명령 출력이나 log에 기록하지 않는다.

```bash
kubectl -n git-code-reviewer create job \
  --from=cronjob/git-code-reviewer-retention reconcile-restore \
  --dry-run=client -o json \
  | jq '.spec.template.spec.containers[0].args=["retention","--reconcile"]' \
  | kubectl apply -f -
kubectl -n git-code-reviewer logs -f job/reconcile-restore
```

`jq`가 없는 환경에서는 `helm template`의 retention CronJob pod template을 별도 Job manifest로 렌더링하고 args만 `retention --reconcile`로 설정한다.

## Retention semantics

- 오래된 Chat을 먼저 삭제한다.
- 활성 Chat이 남은 analysis는 삭제하지 않는다.
- 만료 analysis artifact는 `deleting`으로 claim하고 `deleteGraceHours` 후 제거한다.
- analysis가 없는 만료 snapshot과 source/diff artifact를 정리한다.
- event log와 orphan 파일을 각 실행의 `batchSize` 이내에서 정리한다.
- PostgreSQL advisory lock과 CronJob `Forbid`가 중복 실행을 막는다.

Backup window는 `deleteGraceHours`보다 짧게 유지하거나 retention을 suspend한다. 복구 뒤 report 1건, Chat citation 1건, exact-SHA GHES link 1건을 직접 열어 logical/physical 일관성을 확인한다.
