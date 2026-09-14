import { describe, expect, it, vi } from 'vitest';
import { collectTrustedCiEvidence } from './trusted-ci.js';
import {
  check,
  input,
  payload,
  policy,
  run,
  signed,
  target,
  view,
} from '../../test/trusted-ci-fixtures.js';

function reader() {
  return {
    listValidationChecks: vi.fn(async () => [check()]),
    readValidationRun: vi.fn(async () => run()),
    readValidationWorkflowHash: vi.fn(async () => policy.workflowContentHash),
  };
}
describe('central read-only CI provenance', () => {
  it('preserves failed outcomes and deduplicates repeated signed payloads', async () => {
    const r = reader(),
      c = check();
    r.listValidationChecks.mockResolvedValue([c, { ...c, id: 202 }]);
    const result = await collectTrustedCiEvidence(r, target, policy, view());
    expect(result.status).toBe('verified');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.checks[0]!.outcome).toBe('failed');
    expect(r.listValidationChecks).toHaveBeenCalledWith(
      target,
      input.source.headCommit,
      policy.checkName,
    );
  });
  it.each(['app', 'name', 'head', 'pending'])(
    'rejects wrong check %s without fetching workflow evidence',
    async (field) => {
      const r = reader(),
        c = check();
      if (field === 'app') c.app.id++;
      if (field === 'name') c.name += 'other';
      if (field === 'head') c.head_sha = '9'.repeat(40);
      if (field === 'pending') c.status = 'in_progress';
      r.listValidationChecks.mockResolvedValue([c]);
      expect((await collectTrustedCiEvidence(r, target, policy, view())).rejected).toEqual([
        { checkRunId: '201', reason: 'check-mismatch' },
      ]);
      expect(r.readValidationRun).not.toHaveBeenCalled();
    },
  );
  it.each(['attempt', 'workflow', 'repository', 'head', 'time', 'status'])(
    'rejects a different run %s',
    async (field) => {
      const r = reader(),
        value = run();
      if (field === 'attempt') value.run_attempt++;
      if (field === 'workflow') value.workflow_id++;
      if (field === 'repository') value.repository.id++;
      if (field === 'head') value.head_sha = '9'.repeat(40);
      if (field === 'time') value.created_at = new Date().toISOString();
      if (field === 'status') value.status = 'in_progress';
      r.readValidationRun.mockResolvedValue(value);
      expect((await collectTrustedCiEvidence(r, target, policy, view())).rejected).toEqual([
        { checkRunId: '201', reason: 'run-mismatch' },
      ]);
      expect(r.readValidationWorkflowHash).not.toHaveBeenCalled();
    },
  );
  it('compares timestamps numerically across fractional second formatting', async () => {
    const r = reader(),
      p = payload(),
      value = run();
    p.issuedAt = p.issuedAt.replace(/\.\d{3}Z$/, '.000Z');
    value.created_at = p.issuedAt.replace('.000Z', 'Z');
    r.listValidationChecks.mockResolvedValue([check(signed(p))]);
    r.readValidationRun.mockResolvedValue(value);
    expect((await collectTrustedCiEvidence(r, target, policy, view())).status).toBe('verified');
  });
  it.each(['missing-pr', 'different-pr', 'push', 'changed-workflow'])(
    'refuses %s provenance',
    async (field) => {
      const r = reader(),
        value = run();
      if (field === 'missing-pr') value.pull_requests = [];
      if (field === 'different-pr') value.pull_requests[0]!.number++;
      if (field === 'push') value.event = 'push';
      if (field === 'changed-workflow')
        r.readValidationWorkflowHash.mockResolvedValue('9'.repeat(64));
      r.readValidationRun.mockResolvedValue(value);
      const result = await collectTrustedCiEvidence(r, target, policy, view());
      expect(result.status).toBe('no-matching-evidence');
      expect(result.rejected[0]!.reason).toBe(
        field === 'changed-workflow' ? 'workflow-content-mismatch' : 'ref-mismatch',
      );
    },
  );
  it('refuses incomplete provider discovery instead of accepting partial evidence', async () => {
    const r = reader();
    r.listValidationChecks.mockRejectedValue(Error('pagination'));
    await expect(collectTrustedCiEvidence(r, target, policy, view())).rejects.toThrow('pagination');
    expect(r.readValidationRun).not.toHaveBeenCalled();
  });
  it('rejects expiry during provider reads', async () => {
    vi.useFakeTimers();
    try {
      const expiring = payload();
      expiring.expiresAt = new Date(Date.now() + 1000).toISOString();
      const r = reader(),
        c = check(signed(expiring)),
        value = run();
      r.listValidationChecks.mockResolvedValue([c]);
      r.readValidationRun.mockResolvedValue(value);
      r.readValidationWorkflowHash.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 2000);
        return policy.workflowContentHash;
      });
      const result = await collectTrustedCiEvidence(r, target, policy, view());
      expect(result.evidence).toEqual([]);
      expect(result.rejected[0]!.reason).toBe('stale');
    } finally {
      vi.useRealTimers();
    }
  });
});
