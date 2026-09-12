# @gcr/client-core

GCR-owned client logic for extension and headless consumers. The current local storage implementation supports user-owned memory, review-only Skills, review/chat history and retention. The package also captures immutable local Git/source views. Context resolution, model execution and synchronization follow in later P02/P06 commits. Chat persistence here is an archive; interactive execution and checkpoints follow in P08.

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

## Fixed local source

`captureLocalSource({ cwd, kind: 'index' | 'working-tree', baseRef?, paths?, includeUntracked?, excludePatterns?, limits? })` returns a `LocalSourceSnapshot` read port. `paths` selects exact files; omitted means changes against base. An explicit `baseRef` is resolved once and compared using its merge-base with HEAD. Index capture supports SHA-1/SHA-256, initial commits, intent-to-add, split/version-4/sparse indexes, linked worktrees and explicit or environment-supplied alternate indexes. Captures never stash/reset/check out files, fetch, or write the user's index or object storage. Generated trees, objects and indexes live in a private temporary directory removed before return.

Working-tree capture reads saved bytes of tracked files and explicitly included untracked files. It does not read editor buffers or run clean/smudge filters, so CRLF/BOM and filter-transformed working bytes remain distinct from Git base bytes. Index removal is a deletion unless the remaining untracked file is explicitly included. Missing sparse working files are unavailable; index mode can read their fixed Git objects. This is a bounded observation of files during capture, not a filesystem-wide atomic transaction. Changed opened files, HEAD or evaluated ignore decisions make capture fail. Each returned body is independently SHA-256/Git-blob verified, and no later query accesses Git or the original filesystem.

`identity`, `headCommit`, `selected`, `sourceFiles`, `limitations` and `diff` describe the actual captured input. Deleted files retain their base side; rename patches retain the old path. `readFile`, `readLines` and literal `search` only return captured bodies. Absent means absent from this authorized snapshot, not proof that an arbitrary file does not exist on disk. Metadata getters return copies. `close` releases retained bodies; this is not a secure-memory-erasure claim. Snapshots are currently in memory. Historical Git IDs alone do not guarantee reconstruction after the temporary objects are removed; a consumer must retain an authorized source view or report unavailable.

Defaults are 1 MiB per file, 32 MiB/10,000 bodies across both sides, 50,000 enumerated paths and a 30-second capture deadline. Callers can select smaller limits; hard maxima are 4 MiB/file, 128 MiB total, 10,000 bodies, 50,000 paths and 120 seconds. Git command output/time is bounded separately. Index input is a regular, non-symlink file limited to 64 MiB; bounded nonblocking reads refuse FIFOs and growth during the copy. Source omission is explicit: binary/invalid UTF-8, LFS pointers, submodules, unsafe paths/modes, ignored/private/generated files and size limits never become empty successful source. An unavailable opposite side is excluded from diff comparison, preventing false additions/deletions. Broken/unmerged Git metadata fails capture without working-tree fallback.

Repository `.gitignore` and `.git/info/exclude` decisions are checked at capture. Global/system Git configuration is disabled. Explicit `excludePatterns` use a deny-only subset: `*`, `?`, whole-component `**`, root-relative paths and directory prefixes. A matching path also excludes descendants; a trailing slash is a prefix spelling. Negation, character classes and escaping are rejected, not silently reinterpreted as Git ignore syntax. Private defaults cannot be overridden. A working-tree parent symlink also makes ignore evaluation for that path unavailable, including index capture; it is recorded rather than traversed.

Git filesystem monitors, hooks, external diff/textconv, lazy fetch and protocols are disabled. Index writes and diff commands see an empty working tree because even a temporary index write can otherwise consult working files and invoke a clean filter. This does not sandbox a model CLI: C05 must enforce executor isolation separately. Capture is synchronous; extension/UI consumers should run it outside the UI event loop. `scripts/local-source-smoke.mjs` verifies installed artifacts with synthetic Git data and zero model calls.

The source implementation adapts safe Git environment/path/blob verification from GCR `packages/git-engine/src/{workspace,local-tools}.ts` and temporary-index/exact-tree filtering from Commit Defender `vscode-extension/src/{gitSnapshot,sourcePolicy}.ts` at `35575ad`. Commit Defender is Apache-2.0 licensed. These files were modified for independent client packaging, private object storage, bounded eager capture, source hashes, explicit limitations and a read port with no mutable checkout fallback; no upstream NOTICE file was present.
