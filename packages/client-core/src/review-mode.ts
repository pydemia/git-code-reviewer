import { clientMode, type ClientMode, type ClientReviewReport } from '@gcr/client-contract';

export type ReviewProblem = ClientReviewReport['problems'][number];
export type ModeResolution = {
  mode: ClientMode;
  supported: boolean;
  centralRequests: 'forbidden';
  problems: ReviewProblem[];
};

/** Addresses, cached sessions and credentials never select a mode or authorize a request. */
export function resolveReviewMode(
  settings: { mode?: unknown; [key: string]: unknown } = {},
): ModeResolution {
  const requested = settings.mode;
  const mode = clientMode(requested === undefined ? 'standalone' : requested);
  return {
    mode,
    supported: mode === 'standalone',
    centralRequests: 'forbidden',
    problems:
      mode === 'standalone'
        ? []
        : [
            {
              code: 'policy-unavailable',
              message: 'Centralized review is not available in this client version.',
            },
          ],
  };
}
