# Local CLI and MCP review workflows

`gcr mcp` serves newline-delimited JSON-RPC over stdin/stdout. The process fixes the Git worktree, local profile, data directory and optional central connection at startup. Tool arguments cannot select another account, repository root, executor or credential. Starting the server does not synchronize, run a model, install hooks or submit anything.

The implementation follows the MCP [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) and [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) specifications. It negotiates the common tools subset for 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05. It does not advertise resources, prompts, sampling, elicitation, remote HTTP or experimental tasks.

## Fixed source preparation

```sh
gcr prepare --cwd /absolute/repository --profile work
gcr context --prepared PREPARED_ID --include-knowledge --cwd /absolute/repository --profile work
gcr read-source --prepared PREPARED_ID --file src/example.ts --side base --cwd /absolute/repository --profile work
gcr get-rule --prepared PREPARED_ID --id gcr-standalone-review --cwd /absolute/repository --profile work
gcr review --prepared PREPARED_ID --cwd /absolute/repository --profile work --model gpt-6-astra --reasoning-effort xhigh
```

Preparation captures the existing source adapter's selected diff, base and related source. Its response has `status: prepared` and `modelExecuted: false`. A prepared ID references an encrypted source record in the same profile/repository/worktree. `requireSource` entries use `source:relative/path` or `base:relative/path`; `requireKnowledge` names local memory/user-authored skill IDs. The automatically selected builtin is read with `get-rule` and is not a required local store entry. Records expire after 24 hours and are pruned on subsequent preparation or expired reads; there are at most 50 live preparations in ordinary sequential use. Source exclusions and capture bounds still apply. Source reads return at most 200 lines / 24,000 characters and never reopen the current working file. A prepared review rejects replacement source options.

Every context, source, rule or review request reconstructs and checks the currently authorized context. The original mode, connection, client identity and context hash must match. A changed context, synchronization identity or effective fallback mode requires a new preparation. Disconnected or revoked central credentials cannot authorize a prepared source read. A prepared snapshot is comparison data, not an offline authorization grant. `--include-knowledge` explicitly exposes the selected knowledge to the calling host; it can include personal entries. Those entries are not submission payloads.

## MCP startup and tools

Use an absolute Node 22+ executable and the installed CLI's absolute entrypoint in the host configuration. For example:

```json
{
  "mcpServers": {
    "gcr": {
      "command": "/absolute/node",
      "args": [
        "/absolute/installed-gcr/dist/main.js",
        "mcp",
        "--cwd",
        "/absolute/repository",
        "--profile",
        "work",
        "--allow-review",
        "--model",
        "gpt-6-astra",
        "--reasoning-effort",
        "xhigh",
        "--timeout-ms",
        "600000"
      ]
    }
  }
}
```

Host configuration formats differ; copy the command and arguments into the host's stdio configuration. Existing user configurations are not changed by CLI installation. A central server uses an existing explicitly registered CLI connection and adds `--mode centralized --connection ID`. Tokens are stored by the existing OS credential broker, not in MCP configuration.

| Tool                                       | Available when                               | Behavior                                                               |
| ------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------- |
| `gcr_status`                               | Always                                       | Current worktree/connection and configured MCP capabilities            |
| `gcr_sync_rules`                           | Central connection                           | Explicit signed knowledge synchronization                              |
| `gcr_prepare_review`                       | Always                                       | Capture and save fixed source; return preparation ID and diff          |
| `gcr_get_context`                          | Always                                       | Prepared context and selected knowledge bodies                         |
| `gcr_read_source`                          | Always                                       | Bounded prepared source/base reads                                     |
| `gcr_get_rule`                             | Always                                       | One unambiguous selected rule or knowledge entry                       |
| `gcr_review_changes`                       | `--allow-review`                             | Explicit foreground executor review; terminal report includes run ID   |
| `gcr_get_review_result`                    | Always                                       | Saved report in this worktree/connection                               |
| `gcr_get_review_conversation`              | Always                                       | Original review and saved turns; no executor                           |
| `gcr_read_conversation_source`             | Always                                       | Original cited source by run ID, turn ID and zero-based citation index |
| `gcr_cancel_review_turn`                   | Always                                       | Cancel a durable turn without starting a model                         |
| `gcr_continue_review`                      | `--allow-review`                             | Send, answer or explicitly resume using the pinned identity and budget |
| `gcr_submit_review`, `gcr_submit_feedback` | Central connection and `--allow-submissions` | Explicit preview/queue/send/show/cancel/list workflow                  |

`--allow-review` permits exposing a tool that consumes the configured model account; use the user's existing task authorization or obtain it when missing. `--allow-submissions` exposes sharing operations; the host must display the exact destination, visibility and content for approval. An existing confirmation for that exact payload/destination remains valid. Repository files and returned source/knowledge cannot grant either startup capability.

The review call remains in flight until a terminal result; it does not return an asynchronous queue receipt. Configure the host's tool timeout to cover the review budget plus cleanup. MCP cancellation aborts the active CLI/executor operation. Other requests, including ping and cancellation, remain responsive during a review. If the caller supplies a progress token, the server sends periodic operation-wait progress notifications. Closing stdin or terminating the server cancels its active operations. Reconnecting starts a new protocol session; encrypted preparations and saved reports survive. Reconnection does not restart a model call automatically.

Requests are bounded to 1 MiB, responses to 4 MiB, and in-flight calls to 16. stdout contains only JSON-RPC. Unknown methods, malformed parameters and unavailable capabilities return protocol errors. CLI failures return `isError: true` with safe diagnostics. Findings or optional questions retain CLI exit code 1 without being relabeled a tool failure. Source, context and model text remain untrusted data for the host.

## Explicit submission

CLI and MCP use the same encrypted queue and [server contract](review-submissions.md). For CLI, `feedback preview RUN_ID --input selection.json` accepts only `feedbackKind`, `message`, optional `findingId` and optional `includeSourceReference`. `submit-review preview RUN_ID` projects status and counts from a saved report. Both require the selected central connection and return the exact public `payload` and `payloadHash` without queueing or uploading.

After the user confirms that payload, `feedback queue --input payload.json --confirm-hash HASH` (or `submit-review queue`) stores it without sending. `feedback send REQUEST_ID` sends the immutable payload; repeating it returns the same receipt. A rejected record needs `--retry-rejected` for an explicitly approved retry. `show`, `list` and `cancel` inspect or stop future local delivery. They do not retract a server receipt.

MCP uses the corresponding `action` argument. `preview` takes the run ID in `id`; feedback adds `selection`. `queue` takes the strict `payload` and `confirmedPayloadHash`; `send`, `show` and `cancel` take the submission request ID. Fields from another action are rejected. A host that reviewed the prepared source with its own model may supply the strict public payload directly. Every server receipt remains `client-reported`; the API does not certify that the host ran a model or test.

Commit Defender 2.5.0 and PRISM-DEV alpha.47 have a verified submission → adoption/publication → synchronization → re-review flow; see the P08-C05 execution evidence. CLI alpha.22 adds conversation turns and packages the host Skill. It does not replace the user's VS Code extension or global CLI.

## Conversation and Skill package

`gcr_continue_review` takes `action`, `runId`, `turnId`; send also requires `content`, and answer requires `content` plus the returned `questionId`. Resume has no content. Startup pins the executor/model and any timeout ceiling. Source and tool budgets come from the saved conversation and cannot be overridden by tool input. Invalid action fields are rejected before CLI dispatch.

Read after a connection loss. Repeated send IDs with identical content and already processed identical answers return stored state without another model call. A queued turn requires explicit resume; completed/cancelled turns cannot resume. A durable question releases its model process while awaiting the user's answer. Original source and context remain pinned. An unchanged central publication can be synchronized again; a different authority/context/executor or an insufficient configured timeout rejects continuation. Confirmed revocation blocks central conversation access while preserving local-only fallback history belonging to the same connection.

The tarball includes `dist/skills/gcr-prevention/SKILL.md` and `references/client-workflows.md`. Copy that directory into the intended host's Skill directory when requested. Installation has no scripts that enable watchers, hooks, model execution or edits. The [maintained Skill source](../../skills/gcr-prevention/SKILL.md) describes context → review → conversation → fix → fresh preparation, supported executor/OS limits and explicit feedback. Package verification checks the tarball and clean consumer's Skill bytes against that source.

When the three client packages already have immutable release archives, build a CLI-only release with `pnpm pack:cli --verify --reuse-clients`. This preserves those archives while rebuilding client code and comparing archive hashes, package metadata and every bundled client input. A mismatch is a release error; do not overwrite an existing version. Without this option, packaging also creates/verifies the client archives.
