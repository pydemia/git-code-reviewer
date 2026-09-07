import { loadBuiltInReviewSkills, validateReviewSkillBundle } from '@gcr/analysis-engine';
import type { Database } from '@gcr/db';
import type { ReviewSkillBundle } from '@gcr/review-contract';

export type AnalysisSkillVersion = {
  id: string;
  version: number;
  bundle: ReviewSkillBundle;
  contentHash: string;
  active: boolean;
  createdAt: Date | string;
  createdBy: string;
  activatedAt: Date | string | null;
};

const columns = `id, version, bundle, content_hash as "contentHash", active,
  created_at as "createdAt", created_by as "createdBy", activated_at as "activatedAt"`;

export async function getEffectiveReviewSkills(database: Pick<Database, 'query'>) {
  const active = await database.query<AnalysisSkillVersion>(
    `select ${columns} from analysis_skill_versions where active limit 1`,
  );
  const row = active.rows[0];
  if (!row)
    return {
      versionId: null,
      version: null,
      source: 'builtin' as const,
      bundle: loadBuiltInReviewSkills(),
    };
  const bundle = validateReviewSkillBundle(row.bundle);
  if (bundle.hash !== row.contentHash) throw new Error('Active Skill hash mismatch');
  return { versionId: row.id, version: row.version, source: 'administration' as const, bundle };
}

export async function listReviewSkillVersions(database: Pick<Database, 'query'>) {
  const result = await database.query<AnalysisSkillVersion>(
    `select ${columns} from analysis_skill_versions order by version desc limit 50`,
  );
  return result.rows.map((row) => ({ ...row, bundle: validateReviewSkillBundle(row.bundle) }));
}

export function resolvePinnedReviewSkills(bundle: unknown, expectedHash: string | null) {
  if (bundle === null && expectedHash === null) return undefined; // Migration 이전 분석은 기존 contract를 사용한다.
  const validated = validateReviewSkillBundle(bundle);
  if (validated.hash !== expectedHash) throw new Error('Pinned Skill hash mismatch');
  return validated;
}
