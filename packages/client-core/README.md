# @gcr/client-core

GCR-owned client logic for extension and headless consumers. The current local storage implementation supports user-owned memory, review-only Skills, review/chat history and retention. Source capture, context resolution, model execution and synchronization are implemented separately in the later P02/P06 commits. Chat persistence here is an archive; interactive execution and checkpoints follow in P08.

The package depends only on the pure client contract and Node built-ins. It does not import VS Code, GCR server/DB packages or Commit Defender source. It targets Node 18 or later with ES2022/ESM.

```js
import { LocalRecordStore, LocalKnowledgeStore } from '@gcr/client-core';

const records = await LocalRecordStore.open({
  scope: { kind: 'profile', profileId: 'local-profile' },
});
const knowledge = new LocalKnowledgeStore(records);
// create/edit/setState/remove/list/active/importKnowledge/exportKnowledge/exportFile
// Knowledge starts as a candidate. setState is an explicit user action.
records.close();
```

Repository scopes include profile, repository and worktree keys. `discoverLocalIdentity` uses canonical Git common/worktree directories; same-name clones and linked worktrees stay distinct. Moving a checkout to a different canonical location requires an explicit knowledge import; changing a remote URL does not change the local identity. Local keys do not contain central authorization IDs or remote credentials.

Managed records, including Skill Markdown and history, use AES-256-GCM. The master key lives in the OS credential store; only its opaque reference is stored in application data. macOS uses `/usr/bin/security` and Linux uses `/usr/bin/secret-tool` with a persistent Secret Service collection. Linux needs that helper and an available desktop/headless Secret Service. Windows has no supported key-store adapter yet. Missing/locked key stores fail explicitly and never select a plaintext or environment-key fallback. Host key-store ports are available for integration and tests. Their references must be fresh identifiers owned by the caller; they do not provide a generic credential compare-and-swap operation.

Private application directories use mode 0700 and files use 0600. Symbolic-link or shared-permission storage is rejected. Memory and Skill edits require an expected revision. Immutable encrypted bodies and exclusively linked revision markers prevent stale writers from overwriting newer edits. A `commit-unknown` error means publication may have happened: read the current revision before retrying. Cleanup failures are returned separately from a committed deletion. Old body cleanup retains revision markers to fence stale writers; interrupted private staging/orphan ciphertext can require later cleanup. This is not a secure-erasure or rollback-resistant storage claim.

`LocalHistoryStore` retains full terminal reports without changing partial/failed/cancelled status, and stores user/assistant chat archives. Retention defaults to 90 days and 1000 entries for reviews and chats separately; `configureRetention` persists changes in the same scope. Local memory/Skills are outside history pruning. Existing records may be read or explicitly deleted; new completed reviews are not fabricated to replace missing history. `exportFile` is an explicit plaintext export to a new file with mode 0600; it never overwrites an existing file.

Records are limited to 16 MiB of canonical plaintext JSON, 24 MiB of encrypted envelope and 64 nesting levels. Retention accepts 1–3650 days and 1–10000 entries. State is process-independent; keys and decrypted records are never logged. Package packing and distribution follow `docs/development/client-package-delivery.md` in GCR. `scripts/local-store-smoke.mjs` tests actual OS-key retrieval, restoration in a new process, eight concurrent writers and deletion using synthetic data and zero model calls.
