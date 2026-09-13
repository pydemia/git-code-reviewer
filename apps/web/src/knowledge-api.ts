import {
  knowledgePublicationStatus,
  knowledgeMemoryList,
  knowledgeMemoryProjection,
  centralMemoryContent,
  type CentralMemoryContent,
} from '@gcr/client-contract';
import { fetchJson, mutateJson } from './api.ts';
const base = (repositoryId: string) =>
  `/api/v1/repositories/${encodeURIComponent(repositoryId)}/review-knowledge`;
export async function loadKnowledgeStatus(repositoryId: string, signal: AbortSignal) {
  return knowledgePublicationStatus(await fetchJson(`${base(repositoryId)}/status`, signal));
}
export async function loadKnowledgeMemories(
  repositoryId: string,
  signal: AbortSignal,
  cursor?: string,
) {
  return knowledgeMemoryList(
    await fetchJson(
      `${base(repositoryId)}/memories${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      signal,
    ),
  );
}
export async function loadKnowledgeProjection(
  repositoryId: string,
  memoryId: string,
  signal: AbortSignal,
) {
  return knowledgeMemoryProjection(
    await fetchJson(
      `${base(repositoryId)}/memories/${encodeURIComponent(memoryId)}/projection`,
      signal,
    ),
  );
}
export async function approveKnowledgeProjection(
  repositoryId: string,
  memoryId: string,
  expectedFingerprint: string,
  content: CentralMemoryContent,
) {
  return mutateJson(
    `${base(repositoryId)}/memories/${encodeURIComponent(memoryId)}/projection`,
    'POST',
    { expectedFingerprint, content: centralMemoryContent(content) },
  );
}
