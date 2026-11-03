# Preventive review evaluation fixtures

This corpus contains twelve authored, synthetic cases: Python partial caches, TypeScript authorization, and Python/TypeScript API transitions, each with defect, fixed, normal and counterevidence variants. These are not exports of PR #953, private source or real review outcomes. The themes resemble the design examples, but actual PR source has not been verified or adopted.

`catalog.ts` defines complete before/after source views, expected judgments and the related files that must support a review. `manifest.json` pins their Git trees and definition hashes. Every case has a staged diff. Counterevidence includes an enforced caller precondition, a router guard, or a verified inactive historical consumer. A lexical match or a repeated past finding is not sufficient evidence.

The test suite runs the authored Python and compiled TypeScript fixtures to check that their behavior agrees with the labels. This establishes the fixture, not AI review quality. Real executor evaluations must separately record the executor/model, actual source reads, source/tree hashes, coverage gaps, response and judgment against the required evidence. No exact prose match or invented performance threshold is used.

Five Git scenarios cover partial staging with working-tree-only suppression markers, deletion, rename with unchanged consumers, linked worktree indexes, and multiple pushed refs including a new and deleted ref. They use temporary repositories with deterministic commit identity/date and disabled hooks. They never stage or modify the user's checkout.

```sh
pnpm exec vitest run tests/fixtures/preventive-review/catalog.test.ts
```

When intentionally editing the corpus, review the source and expected behavior, regenerate the manifest with `GCR_UPDATE_FIXTURE_MANIFEST=1` on that command, then run again without the environment variable. Updating a manifest is not evidence that a model or client passes these cases.
