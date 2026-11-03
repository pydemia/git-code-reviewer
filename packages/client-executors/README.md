# @gcr/client-executors

Account execution adapters shared by GCR clients and Commit Defender. Core owns
source/context approval and passes an authorized `FixedSourceToolPort`. This
package uses the client contract, core's Windows native process/storage helper,
and Node built-ins; it does not import VS Code or server code.

`prepareCodexAccountExecutor({ executablePath, model: 'gpt-6-astra', reasoningEffort: 'xhigh' })` checks the selected executable's version, binary hash and bundled model catalog. It then runs that executable against a synthetic loopback provider with an empty auth home. This probe verifies the actual outgoing model/effort/tool catalog and detects user config or AGENTS canaries. It makes no account model call. Unsupported configurations throw `ExecutorError`; no executable, provider, account or model fallback is attempted.

The executor has macOS, Windows, and Linux paths and accepts verified CLI
versions 0.153.4 or 0.154.0. The caller selects a model and effort from that CLI's
catalog. Native account-review evidence exists for macOS and Windows ARM64.
Linux ARM64 has container isolation/process tests and actual CLI synthetic
catalog checks. One authenticated Luna/high review passed in a WSL2 Ubuntu
24.04.1 ARM64 VS Code 1.137.0 Host with CLI 0.153.4, including report evidence,
encrypted history, and cleanup. Linux x64 catalog checks used Docker emulation;
native x64 hardware and non-WSL desktop execution remain unverified.
A package target is not proof of native execution on that OS/CPU.
Missing credentials fail at invocation; preparation does not claim login or
account quota availability.

The application-owned model catalog preserves the executable's model/protocol metadata while selecting a review-only tool surface. Model tools contain the three fixed source reads plus generic MCP resource queries, which return empty lists and refuse resource reads. No shell, patch, agent delegation, browser, connector, Skill loader, memory, hook or arbitrary subprocess launcher is exposed. All source tools point to one process-owned loopback server with a random bearer supplied via environment, strict host/origin checks and bounded requests. Approval applies explicitly to these three already-authorized source tools only.

Codex loads global AGENTS documents independently of its project document byte
limit. macOS denies reads of both global instruction filenames while retaining
the original authentication namespace. Windows and Linux expose only the
existing auth-file inode in a private per-invocation CODEX_HOME, without copying
token bytes. Linux requires an owner-only regular auth.json, an owner-controlled
home, and hard-link support; symlinks, unsafe modes, and keyring-only accounts
fail closed. It creates the temporary home on the account's filesystem and
removes it after the owned process group stops. The verified CLI's in-place
token refresh still updates the same inode. Global instructions/settings are
not changed and keyring credentials are never exported to plaintext.

These restrictions complement the verified tool surface; the CLI itself still
needs account/runtime filesystem access. The application creates an empty run
cwd and ephemeral state/log/catalog files, then removes them after execution.
Source bodies are never materialized in that cwd.

`executor.descriptor` binds executable/model/catalog/tool configuration and authentication namespace to the core approval. `executor.review({ prompt, source, timeoutMs, signal, responseSchema })` returns final text, selected model/effort, elapsed time and available CLI token counters. It does not infer a completed defect review merely from CLI success; the consumer must decode and validate the report, coverage, evidence and source receipts. Source receipts prove what the port returned; matching unpredictable source witnesses provide separate evidence that a real model received those bodies. Neither observation proves semantic accuracy for all code or languages.

Process execution uses stdin, no shell, bounded combined stdout/stderr, a POSIX process group and SIGTERM followed by SIGKILL. Descendants in the group are terminated on cancellation, timeout and normal leader exit. A deliberately detached child that creates another session is outside this process primitive's guarantee; the enabled adapter exposes no model/user-configured subprocess tools. Raw CLI diagnostics are not forwarded to consumers. Cancellation ends the local execution; it does not guarantee immediate backend cancellation or a billing refund.

Output token hard caps are unsupported and reported as such. A core `modelCalls` reservation counts one logical executor invocation, including its internal tool loop; it is not a cap on the CLI's internal HTTP requests or sampling retries. Duration, tool calls and bytes returned through the source port are enforceable locally. CLI aggregate token counters are observations after completion. Persistent project/cross-process quotas remain a later phase.

The account selection, stdin/ephemeral invocation and original process helper derive from Commit Defender `vscode-extension/src/ai/providers.ts` at `35575ad`, under Apache-2.0. GCR adds source isolation, authenticated MCP transport, capability probing and process-group cleanup. No other CD account adapter is enabled by this package yet.

`scripts/local-executor-smoke.mjs` runs against installed exports, an explicitly selected current Codex account and synthetic Git data. It verifies source/base/caller witnesses after removing the original repository, the partial-cache defect, cancellation during a tool call and timeout while a tool response is held. The actual package version, hashes and verification scope belong in the execution evidence; a workspace build is not an installed artifact.

### Review conversation capability

`prepareCodexAccountExecutor` also probes the real executable's isolated
conversation tool catalog against a local synthetic provider. Only the fixed
source tools and the host-owned `ask_user` tool are admitted. A prepared executor
exposes `conversationCapability: 'checkpoint-tool-v1'` and `converse`, which accepts
a `ReviewChatQuestionPort`. Ordinary `review` calls continue to expose only the
three fixed source tools. The question tool is not a permission dialog and cannot
change approved source, credentials, or executable settings. The core conversation
runner persists the question and stops the process; user answers resume a new
isolated invocation.
