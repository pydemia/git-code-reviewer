import type { Database } from '@gcr/db';
import type { FilesystemArtifactStore } from '@gcr/artifact-store';
import { centralKnowledgeBundle, type CentralKnowledgeBundle } from '@gcr/client-contract';
import type { RemoteReviewContextAuthority } from '@gcr/client-core';
import { downloadKnowledgeBundle, observeApprovedKnowledgeManifest } from './knowledge-manifest.js';

export function remoteReviewContextAuthority(
  database: Database,
  store: FilesystemArtifactStore,
  serverId: string,
): RemoteReviewContextAuthority {
  return {
    observe: (manifest) => observeApprovedKnowledgeManifest(database, serverId, manifest),
    async load(manifest) {
      await observeApprovedKnowledgeManifest(database, serverId, manifest);
      const { repositoryId, userId } = manifest.payload.audience;
      const bundles = {} as Record<'policy' | 'collective' | 'personal', CentralKnowledgeBundle>;
      for (const part of ['policy', 'collective', 'personal'] as const) {
        const result = await downloadKnowledgeBundle(
          database,
          store,
          repositoryId,
          userId,
          manifest.payload.snapshotId,
          manifest.payload.components[part].bundleId,
        );
        bundles[part] = centralKnowledgeBundle(JSON.parse(result.bytes));
      }
      await observeApprovedKnowledgeManifest(database, serverId, manifest);
      return bundles;
    },
  };
}
