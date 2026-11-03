import { z } from 'zod';
import { reviewSubmission, reviewSubmissionReceipt } from '@gcr/client-contract';
import {
  submissionIntakeDecisionSchema,
  submissionIntakeActionSchema,
  type SubmissionIntakeAction,
} from '@gcr/contracts';
import { fetchJson, mutateJson } from './api.ts';
const entry = z.object({
  receipt: z.unknown().transform((value) => reviewSubmissionReceipt(value)),
  submission: z.unknown().transform((value) => reviewSubmission(value)),
  decision: submissionIntakeDecisionSchema.nullable(),
});
const list = z.object({
  schemaVersion: z.literal(1),
  capabilities: z.object({ manage: z.boolean() }),
  items: z.array(entry),
  nextCursor: z.string().uuid().nullable(),
});
export type SubmissionIntakeEntry = z.infer<typeof entry>;
const base = (repositoryId: string) =>
  `/api/v1/repositories/${encodeURIComponent(repositoryId)}/review-submissions`;
export async function loadReviewSubmissions(
  repositoryId: string,
  signal: AbortSignal,
  cursor?: string,
) {
  return list.parse(
    await fetchJson(
      `${base(repositoryId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      signal,
    ),
  );
}
export async function reviewClientSubmission(
  repositoryId: string,
  id: string,
  input: SubmissionIntakeAction,
) {
  return z
    .object({ schemaVersion: z.literal(1), decision: submissionIntakeDecisionSchema })
    .parse(
      await mutateJson(
        `${base(repositoryId)}/${encodeURIComponent(id)}/review`,
        'POST',
        submissionIntakeActionSchema.parse(input),
      ),
    );
}
