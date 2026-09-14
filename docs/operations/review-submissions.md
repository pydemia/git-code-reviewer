# Client review results and feedback

Clients submit only after the user confirms the destination, repository visibility and exact content. API keys retain `knowledge:read` by default. The web account page can add `reviews:submit` and `feedback:submit` independently when issuing a new key; existing keys do not acquire these permissions.

| Endpoint | Credential | Purpose |
| --- | --- | --- |
| `POST /api/v1/repositories/:repoId/review-submissions/results` | `reviews:submit` | Store status and file/finding counts for a selected review |
| `POST /api/v1/repositories/:repoId/review-submissions/feedback` | `feedback:submit` | Store an explicit correction, exception proposal or judgment |
| `GET /api/v1/repositories/:repoId/review-submissions` | Authorized web session | List submissions visible to repository reviewers; UUID cursor pagination |

Writes require a bearer key and `X-GCR-Server-Id`. A browser session cannot substitute for a client credential. Each write rechecks the current user, credential, tenant and repository authorization. The payload audience and client ID must match the key. Issuing a key does not start an upload, review or watcher.

The strict wire contract is `reviewSubmission` in `@gcr/client-contract`. Common data consists of an idempotency ID, destination audience, client ID, confirmation time, repository visibility and review run/source/context/snapshot references. A result contains only status and counts. Feedback contains the selected message, optional finding/rule references and an optional source location. Report summaries, finding descriptions, source bodies, model transcripts and local or personal knowledge entries are not accepted fields. Free-text feedback is the content the user explicitly elects to share; the contract does not claim to detect every secret a user might enter.

Receipts always identify the evidence as `client-reported`. A source hash or historical manifest reference does not prove that a model or test ran. Rule references must belong to the repository and revision; retained manifests must match the owner/repository/hash. Expired manifests may already have been removed, so those references remain unverified. Submissions do not approve an exception, modify an active criterion, or create an automatic model-generation job. Maintainer review and the approval/publication UI are the following P08-C05 integration.

The same payload and ID return the same receipt across API key rotation. Server, tenant, repository, user and client ID scope the idempotency key. A changed payload returns 409. Concurrent serialization conflicts may also require retrying the same request. A disconnected client or revoked key cannot use a cached synchronization grant to submit. HTTP bodies are limited to 32 KiB; each user can submit up to 1,000 new records per day. Stored payloads and receipts expire after 30 days, disappear from listing at expiry, and are removed by the existing retention command. Confirmation older than 30 days is rejected. Idempotency is guaranteed during that retention period.

`prepareReviewSubmission` projects a stored report into the narrow public payload. `ReviewSubmissionQueue.enqueue` requires its exact confirmed payload hash and does not send. Queue records are encrypted per local profile/repository/worktree and central connection. `send` is explicit; there is no sync-loop hook or timer. Transport failures leave delivery unconfirmed and preserve the same payload/ID for retry. Definitive HTTP rejection requires an explicit retry. A 60-second local claim fences simultaneous senders; reclaiming an abandoned claim resends the same idempotency key. A local cancellation stops future retries and cannot retract a request already accepted by the server.

Queue opening and `prune` remove expired encrypted payloads even if the connection is no longer selected. Live sending claims are preserved until their lease ends. Credential and knowledge-cache state are independent of submission errors. CLI/MCP commands and the Commit Defender confirmation/submission interface consume this library in P08-C04/C05; they are not enabled by installing the library alone.
