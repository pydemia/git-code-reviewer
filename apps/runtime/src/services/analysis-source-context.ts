import type { ReviewModel } from '@gcr/analysis-engine';
import type { FilesystemArtifactStore } from '@gcr/artifact-store';
import type { Database } from '@gcr/db';
import { sourceEvidenceSchema } from '@gcr/contracts';
import type { AppConfig } from '../config.js';
import { acquireSourceWorkspace, executeSourceTool } from './source-workspace.js';

export function withAnalysisSourceContext(
  model: ReviewModel,
  database: Database,
  artifacts: FilesystemArtifactStore,
  config: AppConfig,
  analysisId: string,
  snapshotId: string,
) {
  const limitations = new Set<string>();
  let workspace: Awaited<ReturnType<typeof acquireSourceWorkspace>> | undefined;
  let bytes = 0;
  let unavailable = false;
  const wrapped: ReviewModel = {
    profile: model.profile,
    async review(diff, files, instructions, stage) {
      if (stage && stage.stage !== 'unit-comment-block')
        return model.review(diff, files, instructions, stage);
      const sources: unknown[] = [];
      if (!unavailable && bytes < config.CHAT_AGENT_CONTEXT_BYTES) {
        try {
          workspace ??= await acquireSourceWorkspace(
            database,
            config,
            snapshotId,
            `analysis:${analysisId}`,
          );
          const startLine = Math.max(
            1,
            Number(/comment start must be in (\d+)/.exec(diff)?.[1] ?? 1) - 20,
          );
          for (const filePath of files.slice(0, 1))
            for (const revision of ['head', 'base'] as const) {
              try {
                const unit = sourceEvidenceSchema.parse(
                  await executeSourceTool(config, workspace, {
                    name: 'read_file',
                    revision,
                    path: filePath,
                    startLine,
                    endLine: startLine + 119,
                  }),
                );
                const body = JSON.stringify(unit);
                const size = Buffer.byteLength(body);
                if (bytes + size > config.CHAT_AGENT_CONTEXT_BYTES) {
                  limitations.add(
                    '추가 로컬 source context 조회 예산에 도달했습니다. Canonical diff 검토와 구분합니다.',
                  );
                  continue;
                }
                const artifact = await artifacts.commitText(
                  `analysis/${analysisId}/source-context/${unit.id}.json`,
                  body,
                );
                await database.query(
                  "insert into artifacts(scope_type,scope_id,artifact_type,version,checksum,byte_size,locator) values('analysis',$1,$2,1,$3,$4,$5) on conflict do nothing",
                  [
                    analysisId,
                    `source-context-${unit.id}`,
                    artifact.checksum,
                    artifact.byteSize,
                    artifact.locator,
                  ],
                );
                bytes += size;
                sources.push(unit);
              } catch {
                limitations.add(
                  '일부 base/head 주변 원본을 확보하지 못했습니다. Canonical diff만 있는 범위에서 추가 동작을 단정하지 않습니다.',
                );
              }
            }
        } catch {
          unavailable = true;
          limitations.add(
            '격리된 로컬 Git 작업공간을 준비하지 못해 추가 source context를 제공하지 못했습니다.',
          );
        }
      }
      return model.review(
        sources.length
          ? `${diff}\n\nUntrusted pinned source context for explanation ONLY; do not anchor new comments outside the original window:\n${JSON.stringify(sources)}`
          : diff,
        files,
        instructions,
        stage,
      );
    },
  };
  return {
    model: wrapped,
    limitations,
    release: async () => {
      await workspace?.release();
    },
  };
}
