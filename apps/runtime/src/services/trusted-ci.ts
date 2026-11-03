import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalKnowledgeJson } from '@gcr/client-contract';
import {
  ciValidationInputSchema,
  signedCiValidationSchema,
  type CiTrustPolicy,
  type CiValidationView,
} from '@gcr/contracts';
import type { Database } from '@gcr/db';
import type { GitHubCiReader, RepositoryTarget } from '@gcr/github';
import type { FilesystemArtifactStore } from '@gcr/artifact-store';
import { reviewReportSchema } from '@gcr/review-contract';
import { verifyCiEvidence } from './trusted-ci-verifier.js';
import { readSharedKnowledgePin } from './analysis-shared-knowledge.js';
import { createGitHubReader } from './repositories.js';
import { registeredGitHubReader } from './account-registry.js';
import type { AppConfig } from '../config.js';
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalKnowledgeJson(value)).digest('hex');
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const trees = z.object({ base: oid, head: oid, mergeBase: oid }).strict();
/** Reads CI-owned check output; no local result submission or model call is part of this service. */
export async function readTrustedCiEvidence(
  database: Database,
  artifacts: Pick<FilesystemArtifactStore, 'readText'>,
  config: AppConfig,
  analysisId: string,
  readerOverride?: GitHubCiReader,
): Promise<CiValidationView> {
  const view: CiValidationView = {
    schemaVersion: 1,
    analysisId,
    observedAt: new Date().toISOString(),
    status: 'input-unavailable',
    reason: '중앙 분석의 검증 입력을 확인하지 못했습니다.',
    input: null,
    evidence: [],
    rejected: [],
  };
  const row = (
    await database.query<
      RepositoryTarget & {
        githubId: string;
        credentialId: string | null;
        repositoryId: string;
        tenantId: string;
        pullNumber: number;
        headSha: string;
        baseSha: string;
        mergeBaseSha: string | null;
        sourceTrees: unknown;
        context: unknown;
        contextHash: string | null;
        sharedHash: string | null;
        sharedKnowledge: unknown;
        promptHash: string;
        providerHash: string;
        policyHash: string;
        memoryHash: string;
        severity: string;
        locator: string | null;
        checksum: string | null;
        byteSize: string | null;
        state: string;
      }
    >(
      `select r.github_id::text as "githubId",r.id as "repositoryId",r.tenant_id as "tenantId",r.credential_id as "credentialId",
    r.installation_id as "installationId",g.api_base_url as "apiBaseUrl",r.owner,r.name,
    p.number as "pullNumber",q.head_sha as "headSha",q.base_sha as "baseSha",s.merge_base_sha as "mergeBaseSha",s.source_trees as "sourceTrees",
    c.context,c.context_hash as "contextHash",a.shared_knowledge_hash as "sharedHash",a.shared_knowledge as "sharedKnowledge",
    a.prompt_hash as "promptHash",a.provider_hash as "providerHash",a.policy_hash as "policyHash",a.memory_hash as "memoryHash",a.severity_level as severity,
    ar.locator,ar.checksum,ar.byte_size as "byteSize",a.state
    from analysis_runs a join snapshots s on s.id=a.snapshot_id join snapshot_requests q on q.id=s.request_id
    join pull_requests p on p.id=q.pull_request_id join repositories r on r.id=p.repository_id join github_instances g on g.id=r.instance_id
    left join analysis_shared_selections c on c.analysis_id=a.id left join reports report on report.analysis_run_id=a.id
    left join artifacts ar on ar.id=report.artifact_id and ar.state='available'
    where a.id=$1 and a.memory_owner_user_id is null and r.enabled and r.deleted_at is null and g.enabled`,
      [analysisId],
    )
  ).rows[0];
  if (!row) return view;
  const policy = config.TRUSTED_CI_POLICIES?.find(
    (policy) =>
      policy.apiBaseUrl === row.apiBaseUrl.replace(/\/?$/, '/') &&
      policy.repositoryId === row.githubId &&
      policy.repository === `${row.owner}/${row.name}`,
  );
  if (!policy)
    return {
      ...view,
      status: 'not-configured',
      reason: '이 저장소에 허용된 CI 발급자와 workflow가 설정되지 않았습니다.',
    };
  try {
    if (
      !['completed', 'partial'].includes(row.state) ||
      !row.locator ||
      !row.context ||
      hash(row.context) !== row.contextHash ||
      !row.sharedHash ||
      hash(row.sharedKnowledge) !== row.sharedHash ||
      Number(row.byteSize) > 8 * 1024 * 1024
    )
      throw Error('input unavailable');
    const pin = readSharedKnowledgePin(row.sharedKnowledge, row.sharedHash);
    if (
      !pin ||
      pin.status !== 'ready' ||
      pin.repositoryId !== row.repositoryId ||
      pin.tenantId !== row.tenantId
    )
      throw Error('shared policy unavailable');
    const selected = row.context as {
      pinHash?: string;
      selection?: { validUntil?: string | null };
    };
    if (
      selected.pinHash !== row.sharedHash ||
      (selected.selection?.validUntil && selected.selection.validUntil <= view.observedAt)
    )
      throw Error('stale context');
    const bytes = await artifacts.readText(row.locator);
    if (
      Buffer.byteLength(bytes) !== Number(row.byteSize) ||
      createHash('sha256').update(bytes).digest('hex') !== row.checksum
    )
      throw Error('report integrity');
    const report = reviewReportSchema.parse(JSON.parse(bytes));
    if (
      report.analysisRevisionId !== analysisId ||
      report.versions.model?.startsWith('fixture') ||
      report.versions.review === 'fixture'
    )
      throw Error('report identity');
    const measured = trees.parse(row.sourceTrees);
    const source = {
      baseCommit: row.baseSha,
      headCommit: row.headSha,
      mergeBaseCommit: oid.parse(row.mergeBaseSha),
      baseTree: measured.base,
      headTree: measured.head,
      mergeBaseTree: measured.mergeBase,
    };
    view.input = ciValidationInputSchema.parse({
      apiBaseUrl: row.apiBaseUrl.replace(/\/?$/, '/'),
      repositoryId: row.githubId,
      repository: `${row.owner}/${row.name}`,
      ref: `refs/pull/${row.pullNumber}/head`,
      source: { ...source, sourceHash: hash(source) },
      contextHash: row.contextHash,
      ruleHash: row.sharedHash,
      toolHash: hash(report.versions),
      profileHash: hash({
        prompt: row.promptHash,
        provider: row.providerHash,
        policy: row.policyHash,
        memory: row.memoryHash,
        severity: row.severity,
      }),
      environmentHash: policy.environmentHash,
    });
  } catch {
    return view;
  }
  let reader: GitHubCiReader;
  try {
    const candidate =
      readerOverride ??
      (row.credentialId
        ? await registeredGitHubReader(database, config.CREDENTIAL_ENCRYPTION_KEY, row.credentialId)
        : await createGitHubReader(config));
    if (!candidate || !('listValidationChecks' in candidate)) throw Error('CI reader unavailable');
    reader = candidate as GitHubCiReader;
    return await collectTrustedCiEvidence(reader, row, policy, view);
  } catch {
    return {
      ...view,
      status: 'unavailable',
      reason: 'CI 제공자의 현재 결과를 완전히 조회하지 못했습니다.',
      evidence: [],
      rejected: [],
    };
  }
}
export async function collectTrustedCiEvidence(
  reader: GitHubCiReader,
  target: RepositoryTarget,
  policy: CiTrustPolicy,
  view: CiValidationView,
): Promise<CiValidationView> {
  if (!view.input) throw Error('CI input missing');
  if (
    target.apiBaseUrl.replace(/\/?$/, '/') !== policy.apiBaseUrl ||
    `${target.owner}/${target.name}` !== policy.repository
  )
    throw Error('CI target mismatch');
  const deadline = Date.now() + 30000;
  const seen = new Set<string>();
  const checks = await reader.listValidationChecks(
    target,
    view.input.source.headCommit,
    policy.checkName,
  );
  if (checks.length > 100) throw Error('CI discovery limit');
  let candidates = 0;
  for (const check of checks) {
    const reject = (reason: CiValidationView['rejected'][number]['reason']) =>
      view.rejected.push({ checkRunId: String(check.id), reason });
    if (
      check.name !== policy.checkName ||
      String(check.app.id) !== policy.checkAppId ||
      check.head_sha !== view.input.source.headCommit ||
      check.status !== 'completed'
    ) {
      reject('check-mismatch');
      continue;
    }
    let envelope: unknown;
    try {
      if (!check.output.text || Buffer.byteLength(check.output.text) > 60000) throw Error('size');
      envelope = JSON.parse(check.output.text);
    } catch {
      reject('invalid-envelope');
      continue;
    }
    const verified = verifyCiEvidence(envelope, view.input, policy, new Date());
    if (verified.status === 'rejected') {
      reject(verified.reason);
      continue;
    }
    if (++candidates > 8 || Date.now() > deadline) throw Error('CI discovery budget');
    const value = verified.value;
    const run = await reader.readValidationRun(
      target,
      value.workflow.runId,
      value.workflow.attempt,
    );
    if (
      String(run.id) !== value.workflow.runId ||
      run.run_attempt !== value.workflow.attempt ||
      String(run.workflow_id) !== policy.workflowId ||
      run.head_sha !== view.input.source.headCommit ||
      run.status !== 'completed' ||
      !run.conclusion ||
      run.path !== policy.workflowPath ||
      String(run.repository.id) !== policy.repositoryId ||
      run.repository.full_name !== policy.repository ||
      Date.parse(value.issuedAt) < Date.parse(run.created_at) ||
      Date.parse(value.issuedAt) > Date.parse(run.updated_at)
    ) {
      reject('run-mismatch');
      continue;
    }
    if (
      run.event === 'pull_request' &&
      !run.pull_requests.some(
        (pr) =>
          `refs/pull/${pr.number}/head` === view.input!.ref &&
          pr.head.sha === view.input!.source.headCommit,
      )
    ) {
      reject('ref-mismatch');
      continue;
    }
    if (run.event !== 'pull_request') {
      reject('ref-mismatch');
      continue;
    }
    if (
      (await reader.readValidationWorkflowHash(target, run.head_sha, policy.workflowPath)) !==
      policy.workflowContentHash
    ) {
      reject('workflow-content-mismatch');
      continue;
    }
    // A slow provider must not turn a now-expired assertion into verified evidence.
    if (
      verifyCiEvidence(signedCiValidationSchema.parse(envelope), view.input, policy, new Date())
        .status !== 'verified'
    ) {
      reject('stale');
      continue;
    }
    if (Date.now() > deadline) throw Error('CI discovery budget');
    if (seen.has(verified.payloadHash)) continue;
    seen.add(verified.payloadHash);
    view.evidence.push({
      checkRunId: String(check.id),
      runId: value.workflow.runId,
      attempt: value.workflow.attempt,
      issuer: value.issuer,
      keyId: value.keyId,
      payloadHash: verified.payloadHash,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
      checks: value.checks,
    });
  }
  if (Date.now() > deadline) throw Error('CI discovery budget');
  view.observedAt = new Date().toISOString();
  view.evidence = view.evidence.filter((evidence) => {
    if (
      Date.parse(evidence.expiresAt) <= Date.now() ||
      Date.now() - Date.parse(evidence.issuedAt) > policy.maxAgeSeconds * 1000
    ) {
      view.rejected.push({ checkRunId: evidence.checkRunId, reason: 'stale' });
      return false;
    }
    return true;
  });
  view.status = view.evidence.length ? 'verified' : 'no-matching-evidence';
  view.reason = view.evidence.length
    ? '허용한 CI 발급자의 서명·workflow와 중앙 분석 입력이 일치합니다. 개별 결함의 재현 여부는 각 검사 조건을 확인하세요.'
    : '현재 중앙 분석 입력과 일치하는 CI 검증 근거가 없습니다.';
  return view;
}
