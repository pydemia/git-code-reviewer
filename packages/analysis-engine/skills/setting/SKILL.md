---
name: setting
title: Setting
kind: perspective
unit: code-segment
version: 2
enabled: true
---

# Setting

Environment variable, configuration file, secrets 관리와 deployment·DevOps 설정의 위험을 검토한다.

## 점검 항목

- **Environment variable hygiene**: startup에서 검증하지 않는 필수 변수, 중요한 설정의 fallback·fail-fast 누락, 검증 없이 사용하는 값을 확인한다.
- **.env file risks**: commit된 `.env`, 없거나 오래된 `.env.example`, secret을 제외하지 않는 `.gitignore`를 확인한다.
- **Configuration security**: docker-compose, Kubernetes manifest, CI config, Terraform, Ansible에 평문으로 저장된 credential을 확인한다.
- **Infrastructure migration safety**: 호환 단계를 거치지 않는 `DROP`·`ALTER COLUMN NOT NULL` 같은 파괴적인 migration, rollback 경로 누락, staging 전에 production에 적용하는 변경을 확인한다.
- **DevOps pipeline**: 일부 단계가 실패해도 조용히 통과하는 pipeline, 누락된 lint·test gate, hardcoded environment 이름·credential을 확인한다.
- **Secrets management**: AWS Secrets Manager, HashiCorp Vault, GitHub Secrets 같은 vault를 쓸 자리에 평문 env value나 build argument로 secret을 넣는지 확인한다.
- **Service configuration drift**: `DEBUG=True`, 서로 다른 DB pool size처럼 environment 간 차이로 production에서만 실패하는 설정을 확인한다.
- **Dependency pinning**: `FROM python:latest`와 같은 unpinned container image, 다음 install에서 예기치 않게 깨질 수 있는 unpinned package를 확인한다.

## 판단 어조 (Tone)

Secret 노출과 data loss 위험은 must-fix로 표시한다. Configuration 불일치는 warning으로 제시한다.

## git-code-reviewer 적용 기준

Container 권한, health/readiness, resource limit과 storage의 수명도 배포 맥락에 맞춰 확인한다.

개발 환경 fallback이 운영에서도 활성화되는 조건, 누락된 설정으로 startup이 실패하는 경로, schema 변경이 기존 데이터에 미치는 영향을 설명한다. 실제 cluster 상태나 Secret 값을 보았다고 주장하지 않는다.

직접 확인되는 인증 우회·데이터 손실은 P3, 배포 시 조건부 실패나 설정 불일치는 P2다. 편의나 naming 제안은 P1로 구분한다. Secret은 경로와 변수 이름만 참조한다.

## 출처

Commit Defender의 Setting SKILL.md를 한국어로 번역하고 위 적용 기준을 추가했다. 원문과 Apache-2.0 license 정보는 `../THIRD_PARTY_NOTICES.md`를 참조한다.
