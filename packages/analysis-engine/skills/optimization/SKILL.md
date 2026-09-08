---
name: optimization
title: Optimization
kind: perspective
unit: code-segment
version: 2
enabled: true
---

# Optimization

규모가 커질 때 throughput, latency 또는 resource 사용량을 악화시키는 performance 문제를 검토한다.

## 점검 항목

- **Algorithmic complexity**: linear 또는 log-linear 알고리즘으로 처리할 수 있는데 O(n²) 이상이 되는 연산, 불필요한 full scan을 확인한다.
- **N+1 query**: batching할 수 있는 DB query나 API 호출을 loop 안에서 항목마다 실행하는 패턴을 확인한다.
- **Memory leaks**: 계속 데이터가 쌓이는 long-lived collection, 제거하지 않은 event listener, 닫지 않은 file handle, GC를 방해하는 circular reference를 확인한다.
- **Unnecessary work**: cache할 수 있는 재계산, 바뀌지 않은 데이터의 re-render, 불필요한 network round trip을 확인한다.
- **Data structures**: O(1) lookup이 필요한 곳에서 set·dict 대신 list를 사용하는지, view로 충분한데 큰 객체를 복사하는지 확인한다.
- **Concurrency**: async event loop의 blocking I/O, 서로 독립적인 작업의 병렬 처리 누락, 병목을 만드는 과도한 synchronization을 확인한다.
- **DB**: 자주 사용하는 filter의 누락된 index, 필요한 column만 가져오지 않는 `SELECT *`, pagination 없는 무제한 결과 조회를 확인한다.
- **Resource pooling**: connection이나 client를 재사용하지 않고 request마다 새로 만드는지 확인한다.

## 판단 어조 (Tone)

현실적인 영향이 예상되는 performance 문제만 지적한다. Profiling data가 뒷받침하지 않는 `+=`와 `append` 비교 같은 micro-optimization은 피한다. 가능하면 변경 전후의 complexity나 query pattern을 구체적으로 제시한다.

## git-code-reviewer 적용 기준

반복문과 호출 관계를 근거로 증가량을 설명한다. 실제 측정 없이 latency나 비용 절감 수치를 만들지 않는다. Cache를 제안할 때 invalidation, tenant 구분과 수명에 따른 부작용도 확인한다.

현실적인 부하 조건에서 자원 문제가 발생하는 경우 P2, 확정적인 자원 고갈로 서비스가 멈추는 직접 근거가 있는 경우 P3다. 측정 근거 없는 micro-optimization은 생략한다.

## 출처

Commit Defender의 Optimization SKILL.md를 한국어로 번역하고 위 적용 기준을 추가했다. 원문과 Apache-2.0 license 정보는 `../THIRD_PARTY_NOTICES.md`를 참조한다.
