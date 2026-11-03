import { boolean, choice, id, integer, list, object, text } from './codec.js';
import { sourcePath } from './codec.js';

/** Untrusted model data. The application supplies identities, evidence and enforcement. */
export const localReviewResponse = object({
  summary: text(100_000, 1),
  files: list(
    object({
      path: sourcePath,
      side: choice(['source', 'base']),
      complete: boolean,
      summary: text(20_000, 1),
      readIds: list(id, 1000),
    }),
    200,
  ),
  findings: list(
    object({
      title: text(4096, 1),
      problem: text(20_000, 1),
      impact: text(20_000),
      recommendation: text(20_000),
      category: text(64, 1, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
      severity: choice(['P1', 'P2', 'P3']),
      confidence: choice(['low', 'medium', 'high']),
      anchor: object({ readId: id, startLine: integer(1), endLine: integer(1) }),
      rationale: text(20_000),
      conditions: list(text(4096, 1), 100),
      readIds: list(id, 1000),
      counterEvidence: object({
        status: choice(['not-reviewed', 'reviewed', 'conflicting']),
        summary: text(20_000),
        readIds: list(id, 1000),
      }),
    }),
    200,
  ),
  questions: list(object({ prompt: text(20_000, 1), required: boolean }), 50),
});
export type LocalReviewResponse = ReturnType<typeof localReviewResponse>;

const string = { type: 'string' };
const strings = { type: 'array', items: string };
const shape = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
/** Provider output guidance; localReviewResponse remains the authoritative bounded decoder. */
export function localReviewResponseSchema(): Record<string, unknown> {
  return shape({
    summary: string,
    files: {
      type: 'array',
      items: shape({
        path: string,
        side: { type: 'string', enum: ['source', 'base'] },
        complete: { type: 'boolean' },
        summary: string,
        readIds: strings,
      }),
    },
    findings: {
      type: 'array',
      items: shape({
        title: string,
        problem: string,
        impact: string,
        recommendation: string,
        category: string,
        severity: { type: 'string', enum: ['P1', 'P2', 'P3'] },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        anchor: shape({
          readId: string,
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
        }),
        rationale: string,
        conditions: strings,
        readIds: strings,
        counterEvidence: shape({
          status: { type: 'string', enum: ['not-reviewed', 'reviewed', 'conflicting'] },
          summary: string,
          readIds: strings,
        }),
      }),
    },
    questions: { type: 'array', items: shape({ prompt: string, required: { type: 'boolean' } }) },
  });
}
