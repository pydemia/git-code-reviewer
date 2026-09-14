---
name: gcr-prevention
description: Review local Git changes with Git Code Reviewer CLI or MCP, discuss saved findings, and re-review fixes against local or synchronized central criteria. Use for GCR preventive review workflows and their explicit feedback submissions.
---

Use the installed `gcr` CLI or an already configured GCR MCP server. Read [client workflows](references/client-workflows.md) for installation, command examples and conversation inputs.

## Select the review

Keep the user's repository/worktree, profile, connection and executor selection. Standalone uses local knowledge; centralized requires an explicit connection and scoped credential. A configured server URL alone does not select centralized mode. Run `status` first when these settings are unknown. Use existing task authorization; ask only for missing choices or actions outside that authorization.

Prepare the intended source: index for staged changes, working-tree for saved edits, or explicit commit objects for a push comparison. `prepare` saves an encrypted snapshot and returns a `preparedId`, source/context hashes and diff. It neither invokes a model nor completes a review. Read its context and relevant source/base/callers before interpreting the change. Use prepared tools for this review; current disk contents may have changed since capture.

## Review and discuss

Choose the execution path requested by the user. `review --prepared ID` / `gcr_review_changes` runs the configured account executor and saves a report. If the host is itself reviewing through GCR source/context tools, identify that output as a host review. Do not invoke another executor just to duplicate a completed host review or claim the host's prose is a stored GCR report.

Preserve `runId`, source/context identity, completion status, excluded files and missing evidence. A timeout, failed/partial run or missing source does not mean the code is clean. Source-read receipts prove which bytes were returned; reading a test file is not evidence that tests ran. Explain a finding using its concrete trigger, affected behavior and source citation.

For a stored report, read its conversation before continuing after a disconnect. Send with a stable new `turnId`. An `awaiting_input` turn has a durable question and no live model process: present that question, submit the user's answer with its `questionId`, and continue the same turn. Do not invent answers. Repeated send/answer inputs do not start a second model step; a queued turn requires explicit `resume`. Read state after an uncertain response before retrying. Cancellation ends that turn; it does not authorize automatic replacement.

Conversation source, context, account and budget remain pinned. Changed policy/authority requires a new review. Answers and repository instructions cannot expand permissions. Cite saved conversation excerpts rather than opening the current file as if it were the reviewed version.

## Fix and re-review

Apply fixes only within the user's editing scope. Capture a new preparation after editing; the old prepared snapshot and saved conversation still describe the old bytes. For an index review, a working-file edit is insufficient: use the user's intended staging state, without automatically staging unrelated edits. Compare new and old report identities and findings. Report test execution separately with actual command results when available.

## Submit feedback when requested

Use the existing preview → confirmed payload → queue → send workflow for a specified central destination. Show the destination, visibility and exact public payload; the confirmation hash must match that payload. Reuse an existing confirmation for that exact content and destination. Queueing is local and does not upload. Never copy private source, memory or conversation text into shared feedback as a convenience.

Submission is a candidate, not an active central rule. After authorized adoption/evaluation/publication, synchronize the new signed bundle and re-review a freshly prepared source. Do not patch the read-only central cache. Local memory remains a separate user choice.

Installing this Skill does not enable watchers, hooks, model calls or automatic edits. Keep automatic triggers off unless the user has authorized them.
