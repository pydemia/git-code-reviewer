import { generateKeyPairSync, sign } from 'node:crypto';
import type {
  CiTrustPolicy,
  CiValidationInput,
  CiValidationPayload,
  CiValidationView,
  GitHubCiCheck,
  GitHubCiRun,
} from '@gcr/contracts';
import { ciValidationSigningBytes } from '../src/services/trusted-ci-verifier.js';

export const keys = generateKeyPairSync('ed25519');
export const input: CiValidationInput = {
  apiBaseUrl: 'https://github.example/api/v3/',
  repositoryId: '42',
  repository: 'team/repo',
  ref: 'refs/pull/7/head',
  source: {
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    mergeBaseCommit: 'c'.repeat(40),
    baseTree: 'd'.repeat(40),
    headTree: 'e'.repeat(40),
    mergeBaseTree: 'f'.repeat(40),
    sourceHash: '0'.repeat(64),
  },
  contextHash: '1'.repeat(64),
  ruleHash: '2'.repeat(64),
  toolHash: '3'.repeat(64),
  profileHash: '4'.repeat(64),
  environmentHash: '5'.repeat(64),
};
export const policy: CiTrustPolicy = {
  apiBaseUrl: input.apiBaseUrl,
  issuer: 'https://ci.example/issuers/review',
  keyId: 'owned-test',
  publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  repositoryId: input.repositoryId,
  repository: input.repository,
  workflowId: '90',
  workflowPath: '.github/workflows/review.yml',
  workflowContentHash: '6'.repeat(64),
  checkAppId: '123',
  checkName: 'Signed review evidence',
  allowedRefs: ['refs/pull/*/head'],
  environmentHash: input.environmentHash,
  maxAgeSeconds: 3600,
};
export function payload(now = new Date()): CiValidationPayload {
  return {
    schemaVersion: 1,
    issuer: policy.issuer,
    keyId: policy.keyId,
    input: structuredClone(input),
    workflow: {
      runId: '101',
      attempt: 1,
      workflowId: policy.workflowId,
      path: policy.workflowPath,
      contentHash: policy.workflowContentHash,
    },
    issuedAt: new Date(now.getTime() - 60000).toISOString(),
    expiresAt: new Date(now.getTime() + 60000).toISOString(),
    checks: [
      {
        id: 'regression',
        name: 'Regression',
        outcome: 'failed',
        command: 'pnpm test',
        expected: 'exit 0',
        actual: '<script>failure</script>',
        exitCode: 1,
      },
    ],
  };
}
export function signed(value = payload()) {
  return {
    payload: value,
    signature: sign(null, ciValidationSigningBytes(value), keys.privateKey).toString('base64url'),
  };
}
export const target = {
  apiBaseUrl: input.apiBaseUrl,
  owner: 'team',
  name: 'repo',
  installationId: '1',
};
export function check(value = signed()): GitHubCiCheck {
  return {
    id: 201,
    name: policy.checkName,
    head_sha: input.source.headCommit,
    status: 'completed',
    conclusion: 'failure',
    app: { id: Number(policy.checkAppId) },
    output: { text: JSON.stringify(value) },
  };
}
export function run(now = new Date()): GitHubCiRun {
  return {
    id: 101,
    run_attempt: 1,
    workflow_id: 90,
    head_sha: input.source.headCommit,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    path: policy.workflowPath,
    created_at: new Date(now.getTime() - 120000).toISOString(),
    updated_at: now.toISOString(),
    repository: { id: 42, full_name: input.repository },
    pull_requests: [{ number: 7, head: { sha: input.source.headCommit } }],
  };
}
export function view(): CiValidationView {
  return {
    schemaVersion: 1,
    analysisId: 'd84921da-c1af-4f42-aaef-520206c46808',
    observedAt: new Date().toISOString(),
    status: 'input-unavailable',
    reason: '',
    input: structuredClone(input),
    evidence: [],
    rejected: [],
  };
}
