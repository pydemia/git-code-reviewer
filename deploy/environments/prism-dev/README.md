# PRISM-DEV 배포

이 폴더는 `~/.kube/config`의 `PRISM-DEV` context에 Git Code Reviewer를 검증하기 위한 환경별 설정을 보관한다. 공통 Kubernetes resource는 `deploy/helm/git-code-reviewer` chart를 사용한다.

## 확인된 cluster policy

| 항목                  | PRISM-DEV 값                     |
| --------------------- | -------------------------------- |
| Kubernetes API        | `https://10.250.107.193:6443`    |
| Kubernetes version    | `v1.35.1`                        |
| StorageClass          | `nfs-csi`                        |
| Provisioner           | `nfs.csi.k8s.io`                 |
| Default               | `true`                           |
| Reclaim policy        | `Delete`                         |
| Volume binding        | `Immediate`                      |
| 사용 중인 access mode | `ReadWriteMany`, `ReadWriteOnce` |
| IngressClass          | `nginx`                          |

Artifact는 Server와 Worker가 함께 사용하므로 `nfs-csi`의 `ReadWriteMany` PVC를 새로 만든다. Bundled PostgreSQL은 같은 StorageClass의 `ReadWriteOnce` PVC를 사용한다. 두 PVC 모두 release 전용 namespace에서 동적 provision하며 기존 application PVC를 재사용하지 않는다.

## Pilot 범위

- namespace: `git-code-reviewer`
- release: `git-code-reviewer`
- GitHub: `fixture`
- auth: `development`
- 분석 model: disabled
- Chat: DB credential registry 사용. 실제 account는 관리자 화면에서 등록
- Ingress: disabled
- 접근: `kubectl port-forward`
- image: `docker.io/pydemia/git-code-reviewer:0.7.0-alpha.1`의 고정 digest
- PostgreSQL image: chart 기본 `latest` 대신 PRISM-DEV의 `linux/amd64` manifest digest로 고정

Development auth는 요청자를 administrator로 취급하므로 이 profile에 Ingress나 외부 Service를 추가하지 않는다.

## 배포

```bash
kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  create namespace git-code-reviewer --dry-run=client -o yaml \
  | kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV apply -f -

kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  -n git-code-reviewer create secret generic git-code-reviewer-postgresql-auth \
  --from-literal=password="$(openssl rand -base64 36)" \
  --from-literal=postgres-password="$(openssl rand -base64 36)" \
  --dry-run=client -o yaml \
  | kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV apply -f -

# 최초 1회만 생성한다. 이미 존재하면 기존 key를 유지해야 등록 credential을 복호화할 수 있다.
openssl rand -base64 32 \
  | kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
      -n git-code-reviewer create secret generic git-code-reviewer-credential-registry \
      --from-file=CREDENTIAL_ENCRYPTION_KEY=/dev/stdin

helm dependency build deploy/helm/git-code-reviewer

helm upgrade --install git-code-reviewer deploy/helm/git-code-reviewer \
  --kubeconfig="$HOME/.kube/config" \
  --kube-context=PRISM-DEV \
  --namespace=git-code-reviewer \
  --values=deploy/environments/prism-dev/values.yaml \
  --rollback-on-failure --wait --timeout=20m
```

## 검증

```bash
kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  -n git-code-reviewer get pod,pvc,job

kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  -n git-code-reviewer rollout status deployment/git-code-reviewer-server

kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  -n git-code-reviewer rollout status deployment/git-code-reviewer-worker

helm --kubeconfig="$HOME/.kube/config" --kube-context=PRISM-DEV \
  test git-code-reviewer --namespace=git-code-reviewer --logs

kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  -n git-code-reviewer port-forward service/git-code-reviewer 8080:80
```

Port-forward를 유지한 상태에서 확인한다.

```bash
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
curl -fsS http://127.0.0.1:8080/health/dependencies
curl -fsS http://127.0.0.1:8080/api/v1/repositories
```

Browser에서는 `http://127.0.0.1:8080`과 `http://127.0.0.1:8080/admin`을 확인한다.

## 2026-09-04 검증 결과

`~/.kube/config`의 `PRISM-DEV` context와 Kubernetes API `https://10.250.107.193:6443`을 사용해 release revision 1을 설치했다.

| 검증 항목                  | 결과                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| Helm install               | `deployed`                                                                 |
| PostgreSQL, Server, Worker | 모두 `Ready`, main container restart 0회                                   |
| Artifact PVC               | `nfs-csi`, `ReadWriteMany`, 10Gi, `Bound`                                  |
| PostgreSQL PVC             | `nfs-csi`, `ReadWriteOnce`, 10Gi, `Bound`                                  |
| 동적 생성 PV               | 2개 모두 reclaim policy `Delete`, `Bound`                                  |
| Service                    | `ClusterIP`, port 80, Ingress 없음                                         |
| Helm test                  | `Succeeded`                                                                |
| Health API                 | live, ready, dependencies 모두 HTTP 200                                    |
| Fixture 수집               | repository 1개, open pull request 2개 확인                                 |
| 분석 결과                  | 2건 모두 `completed`, `published`, progress 100                            |
| 수동 refresh               | operation이 `queued`에서 `completed`로 전환되고 새 분석이 publish됨        |
| 결과 조회                  | files, diff, commits, report, findings, code objects, Markdown export 확인 |
| 관리자 API                 | development administrator, tenant, user 조회 확인                          |

PostgreSQL 최초 초기화 중 Server와 Worker의 `migrate` init container가 먼저 접속해 각각 3회 재시작했으나, database 준비 후 `Completed` 상태가 됐다. Main container 재시작과 최근 application error log는 없었다.

로컬에서는 package build 후 test 56건, lint, typecheck, application build가 모두 통과했다. Clean install 직후 `pnpm test`만 단독 실행하면 내부 package의 `dist`가 없어 import 단계에서 실패하므로 CI에서는 `pnpm build:packages`를 먼저 실행해야 한다.

자동 Browser 검증은 실행 환경에 연결된 browser instance가 없어 수행하지 못했다. 대신 `/`와 `/admin`이 HTTP 200, `text/html`, `<title>Git Code Reviewer</title>`을 반환하는 것까지 확인했다.

## 실제 GHES 및 ChatGPT account 등록

`/admin?tab=github`에서 GHES API/Web base URL과 access token을 등록한 뒤 연결 테스트를 실행하고 review 대상 repository를 등록한다. 등록된 repository는 fixture와 무관하게 해당 token으로 polling과 clone을 수행한다. 사내 CA가 필요하면 `trustedCa.existingConfigMap`을 지정한다.

`/admin?tab=chat`에서는 Codex ChatGPT login의 `auth.json`, 허용 model·effort, tenant 할당을 등록한다. 사용자는 review 화면의 오른쪽 Chat panel에서 할당된 account, model, effort를 선택한다. Access token, auth.json, 암호화 key는 Git repository나 values 파일에 저장하지 않는다.
