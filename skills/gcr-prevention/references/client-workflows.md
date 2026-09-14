# GCR client workflows

## Installation and execution

Install the operator-supplied versioned `@gcr/cli` tarball in an owned tools directory:

```sh
npm install --ignore-scripts --no-audit --no-fund /absolute/path/gcr-cli-VERSION.tgz
./node_modules/.bin/gcr --help
```

The package is self-contained and needs Node.js 22 or later. Its bundled Skill is at `node_modules/@gcr/cli/dist/skills/gcr-prevention`. Copy that directory into the chosen host's Skill directory when Skill installation is requested. No install script changes the host configuration or starts a review.

The account executor in this release supports the verified macOS Codex isolation path with `gpt-6-astra` / `xhigh`. It uses the currently selected local account; do not read or copy `auth.json`. `status --check-executor --executor-path /absolute/path/to/codex` checks the selected executable without a review. Unsupported executors are reported unavailable. Linux Secret Service adapter tests are not proof of a working Linux account executor; Linux model execution remains unavailable in this release. Other OS/remote host combinations need their own verification.

Private records require the platform credential store; an unavailable key store must not be replaced with plaintext. Use a stable `--profile` and `--data-dir` across CLI/MCP sessions. Do not change account or profile to bypass a failure.

## CLI review

```sh
gcr status --cwd /absolute/repo --profile default
gcr prepare --cwd /absolute/repo --profile default --source index
gcr context --cwd /absolute/repo --profile default --prepared PREPARED_ID --include-knowledge
gcr read-source --cwd /absolute/repo --profile default --prepared PREPARED_ID --file src/example.ts --side base
gcr review --cwd /absolute/repo --profile default --prepared PREPARED_ID \
  --executor-path /absolute/path/to/codex --model gpt-6-astra --reasoning-effort xhigh
gcr result RUN_ID --cwd /absolute/repo --profile default
```

For saved unstaged changes use `--source working-tree`. Include an ordinary untracked file only with explicit `--include-untracked path`. Preparation lasts 24 hours; saved reports/conversations have their own retention. Later source edits do not alter a preparation. Changed authorized context rejects its reuse.

Default review limits are 120,000 ms, 1,048,576 source bytes and 100 tool calls. CLI accepts `--timeout-ms` up to 600,000, `--source-bytes` up to 33,554,432 and `--tool-calls` up to 1,000. Raise limits only when authorized. A conversation turn inherits the original review's limits, including two model steps across question/answer checkpoints; an answer does not reset the budget.

Review exit 0 means completed with no follow-up, 1 completed with findings/questions, and 2 incomplete/error. Read JSON status rather than treating every nonzero exit as a command failure. For chat, 1 means queued/running/awaiting input; 2 includes partial/failed/interrupted/cancelled. A successful cancel command itself returns 0.

Centralized commands additionally require `--mode centralized --connection CONNECTION_ID`. Connect using `gcr central connect --input connection.json --api-key-stdin` with those mode settings and a protected stdin source; never put the key in command arguments. The configuration must provide the intended server/tenant/repository and pinned signing trust. Use `gcr central sync` with the same selection to refresh. Observe the report's effective mode and fallback reason; a local fallback is not a central-policy review.

## Saved conversation

```sh
gcr chat read RUN_ID --cwd /absolute/repo --profile default
gcr chat send RUN_ID --input question.json --cwd /absolute/repo --profile default
gcr chat answer RUN_ID --input answer.json --cwd /absolute/repo --profile default
gcr chat source RUN_ID --input citation.json --cwd /absolute/repo --profile default
```

Pass the original executor/model selection to actions that run a model; a review restricted with `--allow-path` requires the same authorized paths. Use protected JSON files or piped stdin (`--input -`). Accepted action bodies are exact:

| Action   | JSON body                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `read`   | No input                                                                                                |
| `send`   | `{"turnId":"turn-1","content":"Why does this change break integer cents?"}`                             |
| `answer` | `{"turnId":"turn-1","questionId":"RETURNED_QUESTION_ID","content":"All amounts remain integer cents."}` |
| `resume` | `{"turnId":"turn-1"}`                                                                                   |
| `cancel` | `{"turnId":"turn-1"}`                                                                                   |
| `source` | `{"turnId":"turn-1","citation":0}`                                                                      |

`citation` is a zero-based index in that turn's response. Source reads return at most 200 lines / 24,000 characters. `read`, `source` and `cancel` do not start a model. Unknown worker termination remains interrupted/uncertain until the stored state is reconciled; do not repeatedly resume an active turn.

## MCP mapping

Start the installed CLI's `mcp` command with an absolute `--cwd` and the same profile/data/connection selection. The process binds that root at startup; tool arguments cannot change it. Add `--allow-review` only for authorized executor/conversation calls and `--allow-submissions` for the explicit submission workflow. Startup does not run a review. Preserve the host's required CA/proxy environment when launching a stdio server; do not copy credentials into its configuration.

| Workflow               | Tool and key arguments                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Status / central sync  | `gcr_status`, `gcr_sync_rules` (central only)                                                                |
| Capture / inspect      | `gcr_prepare_review` (`source`, `paths`); `gcr_get_context` (`preparedId`)                                   |
| Source / rule          | `gcr_read_source` (`preparedId`, `path`, `side`); `gcr_get_rule` (`preparedId`, `id`)                        |
| Execute / result       | `gcr_review_changes` (`preparedId`); `gcr_get_review_result` (`runId`)                                       |
| Read conversation      | `gcr_get_review_conversation` (`runId`)                                                                      |
| Send / answer / resume | `gcr_continue_review` (`action`, `runId`, `turnId`, plus CLI action body fields)                             |
| Cancel / citation      | `gcr_cancel_review_turn` (`runId`, `turnId`); `gcr_read_conversation_source` (`runId`, `turnId`, `citation`) |
| Explicit submission    | `gcr_submit_review` / `gcr_submit_feedback` with `action`                                                    |

For submission, `preview` takes `id` (run ID), and feedback also takes `selection`. `queue` takes the exact `payload` and `confirmedPayloadHash`; `send` takes the queued `id`. Inspect advertised schemas for selection/payload details and optional actions. An MCP `isError` result with a failed review still contains useful terminal status; preserve it. Configure the host request timeout to allow the selected review deadline plus process cleanup. Observation timeout alone is not proof that the executor stopped.
