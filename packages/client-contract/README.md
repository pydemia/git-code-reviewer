# @gcr/client-contract

Server-independent JSON contracts shared by Commit Defender and GCR clients. This package has no runtime dependencies, Node-specific types, credentials or VS Code imports. It targets ES2022/ESM on Node 18 or later.

The exported decoders accept unknown JSON data and return validated copies or throw `ContractError`. They cover standalone/centralized identity, repository/worktree keys, fixed source and context identity, local memory and review-only Skills, run/file outcomes, evidence assessments and policy references. Unknown fields and incompatible contract versions are rejected. Readers must explicitly migrate earlier incompatible persisted formats; malformed inputs are never silently repaired into successful reviews.

`clientReviewReport` checks cross-record source/evidence references, scope and audience, completion coverage, chronology and explicit policy revision references. `importLegacyAssessment` preserves the old confidence and verification while marking defect evidence `unassessed`. `projectCommitDefender` provides the terminal legacy display shape and retains the complete validated report under `gcr.report`. Its hook result is advisory; `reviewExitCode` independently returns 0 for completed/no follow-up, 1 for completed findings or questions, and 2 for unfinished/failed execution.

Decoding does not authenticate claimed provenance, recompute content hashes, check current authorization or lease validity, attest model/test execution, or enforce filesystem/network permissions. Those checks belong to the producer, store, context resolver and executor. Callers must bound incoming bytes before JSON parsing. In particular, accepting a synthetic `test-confirmed` fixture does not attest a real test run.

Build with `pnpm build:clients` from the GCR root. Produce and verify versioned artifacts with `pnpm pack:clients --verify`. Distribution is documented in `docs/development/client-package-delivery.md`. Shared synthetic report fixtures live in `tests/fixtures/client-contract`; they are consumed by the CD contract tests as well. Core and executor behavior is implemented separately in the later P02 commits.
