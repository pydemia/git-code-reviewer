import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@gcr/db';
import type { FilesystemArtifactStore } from '@gcr/artifact-store';
import { loadBuiltInReviewSkills, modelReviewFromText } from '@gcr/analysis-engine';
import { loadConfig } from '../config.js';
import { withAnalysisSourceContext } from './analysis-source-context.js';

const mocks = vi.hoisted(() => ({ acquire: vi.fn(), read: vi.fn(), release: vi.fn() }));
vi.mock('./source-workspace.js', () => ({
  acquireSourceWorkspace: mocks.acquire,
  executeSourceTool: mocks.read,
}));
describe('parallel analysis source context', () => {
  it('does not report a pinned missing revision path as a source failure, but retains genuine read failures', async () => {
    mocks.acquire.mockResolvedValue({ release: mocks.release });
    mocks.read.mockImplementation(async (_config, _workspace, input) => ({
      revision: input.revision,
      sha: 'a'.repeat(40),
      path: input.path,
      exists: false,
      reason: 'path_not_present_in_revision',
    }));
    const model = {
      profile: 'synthetic',
      review: vi.fn(async () =>
        modelReviewFromText('{"summary":"검토 완료","grade":"adequate","file_comments":[]}', []),
      ),
    };
    const context = withAnalysisSourceContext(
      model,
      {} as Database,
      {} as FilesystemArtifactStore,
      loadConfig({ DATABASE_URL: 'postgresql://localhost/synthetic' }),
      'analysis',
      'snapshot',
    );
    await context.model.review('canonical diff', ['added.py']);
    expect(context.limitations.size).toBe(0);
    expect(model.review.mock.calls).toHaveLength(1);
    mocks.read.mockRejectedValue(Error('source_blob_mismatch'));
    await context.model.review('canonical diff', ['modified.py']);
    expect(context.limitations.size).toBe(1);
    await context.release();
    vi.clearAllMocks();
  });
  it('acquires one workspace and serializes source preparation without serializing inference', async () => {
    let reads = 0,
      maxReads = 0,
      models = 0,
      maxModels = 0;
    mocks.acquire.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { release: mocks.release };
    });
    mocks.read.mockImplementation(async () => {
      reads++;
      maxReads = Math.max(maxReads, reads);
      await new Promise((resolve) => setTimeout(resolve, 1));
      reads--;
      throw Error('synthetic source unavailable');
    });
    const context = withAnalysisSourceContext(
      {
        profile: 'synthetic',
        review: async () => {
          models++;
          maxModels = Math.max(maxModels, models);
          await new Promise((resolve) => setTimeout(resolve, 40));
          models--;
          return modelReviewFromText(
            '{"summary":"검토 완료","grade":"adequate","file_comments":[]}',
            [],
          );
        },
      },
      {} as Database,
      {} as FilesystemArtifactStore,
      loadConfig({ DATABASE_URL: 'postgresql://localhost/synthetic' }),
      'analysis',
      'snapshot',
    );
    await Promise.all(
      Array.from({ length: 4 }, (_, n) =>
        context.model.review('diff', [`file-${n}.ts`], '', {
          stage: 'unit-comment-block',
          skills: loadBuiltInReviewSkills(),
        }),
      ),
    );
    await context.release();
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(maxReads).toBe(1);
    expect(maxModels).toBe(4);
    expect(context.limitations.size).toBe(1);
  });
});
