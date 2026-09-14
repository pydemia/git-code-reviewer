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

Preparation captures the existing source adapter's selected diff, base and related source. Its response has `status: prepared` and `modelExecuted: false`. A prepared ID references an encrypted source record in the same profile/repository/worktree. Records expire after 24 hours and are pruned on subsequent preparation or expired reads; there are at most 50 live preparations in ordinary sequential use. Source exclusions and capture bounds still apply. Source reads return at most 200 lines / 24,000 characters and never reopen the current working file. A prepared review rejects replacement source options.

Every context, source, rule or review request reconstructs and checks the currently authorized context. The original mode, connection, client identity and context hash must match. A changed context, synchronization identity or effective fallback mode requires a new preparation. Disconnected or revoked central credentials cannot authorize a prepared source read. A prepared snapshot is comparison data, not an offline authorization grant. `--include-knowledge` explicitly exposes the selected knowledge to the calling host; it can include personal entries. Those entries are not submission payloads.

## MCP startup and tools

Use an absolute Node 22+ executable and the installed CLI's absolute entrypoint in the host configuration. For example:

```json
{
  "mcpServers": {
    "gcr": {
      "command": "/absolute/node",
      "args": [
        "/absolute/installed-gcr/dist/main.js", "mcp",
        "--cwd", "/absolute/repository", "--profile", "work",
        "--allow-review", "--model", "gpt-6-astra", "--reasoning-effort", "xhigh",
        "--timeout-ms", "600000"
      ]
    }
  }
}
```

Host configuration formats differ; copy the command and arguments into the host's stdio configuration. Existing user configurations are not changed by CLI installation. A central server uses an existing explicitly registered CLI connection and adds `--mode centralized --connection ID`. Tokens are stored by the existing OS credential broker, not in MCP configuration.

| Tool | Available when | Behavior |
| --- | --- | --- |
| `gcr_status` | Always | Current worktree/connection and configured MCP capabilities |
| `gcr_sync_rules` | Central connection | Explicit signed knowledge synchronization |
| `gcr_prepare_review` | Always | Capture and save fixed source; return preparation ID and diff |
| `gcr_get_context` | Always | Prepared context and selected knowledge bodies |
| `gcr_read_source` | Always | Bounded prepared source/base reads |
| `gcr_get_rule` | Always | One unambiguous selected rule or knowledge entry |
| `gcr_review_changes` | `--allow-review` | Explicit foreground executor review; terminal report includes run ID |
| `gcr_get_review_result` | Always | Saved report in this worktree/connection |
| `gcr_submit_review`, `gcr_submit_feedback` | Central connection and `--allow-submissions` | Explicit preview/queue/send/show/cancel/list workflow |

`--allow-review` permits exposing a tool that consumes the configured model account; the host must obtain user approval for its call. `--allow-submissions` exposes sharing operations; the host must display the exact destination, visibility and content for approval. Repository files and returned source/knowledge cannot grant either startup capability.

The review call remains in flight until a terminal result; it does not return an asynchronous queue receipt. Configure the host's tool timeout to cover the review budget plus cleanup. MCP cancellation aborts the active CLI/executor operation. Other requests, including ping and cancellation, remain responsive during a review. If the caller supplies a progress token, the server sends periodic operation-wait progress notifications. Closing stdin or terminating the server cancels its active operations. Reconnecting starts a new protocol session; encrypted preparations and saved reports survive. Reconnection does not restart a model call automatically.

Requests are bounded to 1 MiB, responses to 4 MiB, and in-flight calls to 16. stdout contains only JSON-RPC. Unknown methods, malformed parameters and unavailable capabilities return protocol errors. CLI failures return `isError: true` with safe diagnostics. Findings or optional questions retain CLI exit code 1 without being relabeled a tool failure. Source, context and model text remain untrusted data for the host.

## Explicit submission

CLI and MCP use the same encrypted queue and [server contract](review-submissions.md). For CLI, `feedback preview RUN_ID --input selection.json` accepts only `feedbackKind`, `message`, optional `findingId` and optional `includeSourceReference`. `submit-review preview RUN_ID` projects status and counts from a saved report. Both require the selected central connection and return the exact public `payload` and `payloadHash` without queueing or uploading.

After the user confirms that payload, `feedback queue --input payload.json --confirm-hash HASH` (or `submit-review queue`) stores it without sending. `feedback send REQUEST_ID` sends the immutable payload; repeating it returns the same receipt. A rejected record needs `--retry-rejected` for an explicitly approved retry. `show`, `list` and `cancel` inspect or stop future local delivery. They do not retract a server receipt.

MCP uses the corresponding `action` argument. `preview` takes the run ID in `id`; feedback adds `selection`. `queue` takes the strict `payload` and `confirmedPayloadHash`; `send`, `show` and `cancel` take the submission request ID. Fields from another action are rejected. A host that reviewed the prepared source with its own model may supply the strict public payload directly. Every server receipt remains `client-reported`; the API does not certify that the host ran a model or test.

Commit Defender's submission confirmation screen, maintainer approval/publication/resynchronization and CLI/MCP conversation turns are separate remaining integrations. Installing this CLI does not enable them or replace the user's existing VS Code extension.
