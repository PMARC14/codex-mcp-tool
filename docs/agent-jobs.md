# Background jobs and worktrees

The existing synchronous tools remain available. The `codex_*` job tools provide a persistent background queue, process-tree cancellation, timeouts, and isolated Git worktrees. The agy server exposes corresponding `agy_*` tools.

| Tool                     | Purpose                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codex_job_start`        | Start with `prompt` or `promptFile`, `cwd`, and optional mode, model, effort, worktree, label, session, and timeout. Returns a job ID immediately.                       |
| `codex_job_status`       | State, elapsed time, session ID, and recent stderr/events. Omit `jobId` for live jobs.                                                                                   |
| `codex_job_result`       | Final text and full file path. `waitSec` is 0–10; output is capped at 20,000 characters.                                                                                 |
| `codex_job_watch`        | Wait for a job to stop or pause, returning the result plus `watchedSec` and `timedOut`. `maxWaitSec` defaults to 1,800 and is capped at 7,200. |
| `codex_job_send`         | Send `message` to a stopped job's session as a new resumed job. Optional `mode`, `model`, `effort`, and `timeoutMin` override inherited settings. Returns `{ jobId, state, followUpOf }`. |
| `codex_job_cancel`       | Stop an owned job's process tree and wait for termination, up to 10 seconds.                                                                                             |
| `codex_job_list`         | Recent jobs from the shared store, newest first.                                                                                                                         |
| `codex_job_read`         | Read `prompt`, `stdout`, `stderr`, `final`, `patch`, or `verify` by character offset, at most 20,000 characters per page.                                                          |
| `codex_job_requeue`      | Create a new queued job from a paused, lost, or failed job's saved prompt. Optional `model` overrides the model; optional `agent: "agy"` hands it to the sibling server. |
| `codex_worktree_collect` | Save a binary patch and diff stat, then optionally remove the worktree or worktree and branch.                                                                           |
| `codex_usage`            | Read live Codex quota, with a marked session-log fallback. |

Example tool arguments:

```json
{
  "prompt": "Implement the requested parser change. Do not commit.",
  "cwd": "/absolute/path/to/repository",
  "mode": "write",
  "worktree": true,
  "label": "parser change",
  "timeoutMin": 120
}
```

The default mode is `read` (`read-only`) for inspection. `write` allows edits in the `workspace-write` sandbox. `trusted` uses `-s danger-full-access` without disabling the CLI's normal approvals; it is intended for worktree jobs on the user's own repositories. On Windows it is needed for Git Bash/MSYS2 commands because the CLI sandboxes can fail with `CreateFileMapping` Win32 error 5. `full` bypasses approvals and sandboxing and is used only when explicitly requested. Job prompts travel over stdin. On Windows, server-created processes are hidden and npm shims are resolved to JavaScript without invoking `cmd.exe`.

`codex_job_result` returns diagnostics only when a job has stopped without final text. Diagnostics are capped at 30 lines, 300 characters per line, and 4,000 characters total. A later final answer supersedes an earlier intermediate error.

`codex_job_watch` keeps its MCP call pending until the job is completed, failed, killed, paused, or lost, or the wait expires. With a client-supplied progress token it reports immediately on local state changes and at least every 20 seconds while waiting. Messages have the form `running | 42s | last event or step summary`, on one line and capped at 120 characters. The heartbeat reads only metadata and the stdout tail; it never starts a process or probes process liveness. Changes written by another server are observed on the next heartbeat. Without a progress token no notifications are sent. A wait timeout returns `timedOut: true`; cancelling the watch only cancels the wait, leaving the job running. A client disconnect also ends the watch; running jobs continue and save their results after the MCP connection closes. When called without MCP task augmentation, Claude Code can background the pending call after two minutes. Task-augmented calls return their task handle immediately, as described below.

`codex_job_send` requires a stopped job (`completed`, `failed`, `killed`, `paused`, or `lost`) with a `sessionId`. It starts a new job with the message as its prompt, resumes that native CLI session, and records `followUpOf` in its metadata. It preserves the connector, mode, model, effort, timeout, and existing worktree. If the worktree was removed or is missing, it falls back to the original working directory (older records fall back to the repository root). Follow-ups use the same queue, usage budgets, and machine-wide slot limit as `codex_job_start`; another connector's follow-up waits for that server to pick it up. Sending to a paused job atomically marks the original `killed` with `reason: "superseded"`, `supersededBy` pointing to the follow-up, and a new `finishedAt`, while preserving the connector/model quota pause. Status, result, and watch expose `supersededBy`; watching the original returns immediately. For a running or queued job, first use `codex_job_watch` and send once it stops, or call `codex_job_cancel`. A job whose process cleanup is still unconfirmed cannot receive a follow-up.

`codex_job_requeue` creates a replacement from a paused, lost, or failed job's saved prompt, optionally changing its model or handing it to another connector with `agent`. For a paused original, replacement creation and the transition to `killed`/`superseded` happen under the same lock, recording `supersededBy` and `finishedAt`. The connector/model quota pause remains in force for new jobs; a manual requeue can still attempt a retry, and a successful retry can lift that pause. Older paused originals whose retry was cleared and which have a `requeuedFrom` or `followUpOf` replacement are migrated to this terminal state when their owning server's pump next sees them.

## MCP tasks (no launch flag)

Only `codex_job_start` and `codex_job_watch` support task augmentation. Ordinary calls retain their existing responses, progress notifications, cancellation semantics, and optional channels. A task start launches the same job as an ordinary start. A task watch adopts the supplied `jobId` immediately; it tracks the job through pauses and automatic retries, independent of `maxWaitSec`. Its final payload is `job_result`, without the ordinary watch's `watchedSec` and `timedOut` fields.

Task IDs equal job IDs. State and results come from the shared job store; a small `jobs/<id>/mcp-task.json` marker records membership in `tasks/list` across reconnects. Listing includes task-augmented jobs for this connector only. Read-only `tasks/get` and `tasks/result` also accept any known job ID for this connector, without subscribing the new connection to notifications. Cancellation retains the job manager's existing ownership checks: another server process can read a job but cannot cancel it.

| Job state | Task status | Message |
| --- | --- | --- |
| queued, running | `working` | The same bounded progress line as ordinary watch |
| paused | `working` | Paused until the ISO reset time, or reset time unknown |
| completed | `completed` | Watch progress line |
| failed, lost | `failed` | Watch progress line |
| killed | `cancelled` | Watch progress line |
| killed with reason superseded | `cancelled` | Names `supersededBy`; the replacement has its own job/task ID |

Polling is suggested every 5,000 ms. Status reads use saved metadata and a bounded stdout tail; they never spawn a process or probe process liveness. The server sends `notifications/tasks/status` on local state transitions only for tasks started or adopted through the current connection. Closing the connection removes its subscription and leaves workers running. Foreign writes are visible on polling. `tasks/result` waits for a terminal state using transitions plus a 5-second metadata check, and returns exactly the same JSON text and MCP content wrapper as `codex_job_result`. Cancelling that pending request only stops the wait; `tasks/cancel` stops the job. Requested TTLs do not shorten job retention: `ttl` / `ttlMs` is `null`, with no separate task expiry timer; the existing cleanup of terminal jobs older than seven days still applies.

### Negotiation and wire shapes

The installed SDK inspected during implementation is `@modelcontextprotocol/sdk` **1.32.2**. It supports the **2025-11-25** task schemas, tool execution metadata, experimental task helpers, and raw request handlers. It does not implement 2026-07-28 discovery or result envelopes. No dependency change is needed: `src/tools/mcp-tasks.ts` provides the task handlers and a stdio envelope adapter for the newer era.

The 2025 initialize handshake advertises `tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } }`. `tools/list` includes `execution: { taskSupport: "optional" }` on just the two tools. A legacy task request is:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"codex_job_start","arguments":{"prompt":"Inspect this repository","cwd":"C:/repo"},"task":{}}}
```

It returns `{ "task": { "taskId": "<jobId>", "status": "working", "ttl": null, "createdAt": "<ISO>", "lastUpdatedAt": "<ISO>", "pollInterval": 5000, "statusMessage": "queued | 0s" } }`. The optional `task.ttl` request field is accepted. `tasks/get`, `tasks/result`, and `tasks/cancel` take `{ "taskId": "<jobId>" }`; get/cancel return the task fields directly, result returns the tool content. `tasks/list` takes no parameters (or `{}`) and returns `{ "tasks": [...] }`, with no pagination. Status notifications put the task fields directly in `params`.

Claude Code **2.1.318** binary inspection found that its default **v2** runtime probes `server/discover` for modern protocol support. This server offers `supportedVersions: ["2026-07-28"]` and `capabilities.extensions: { "io.modelcontextprotocol/tasks": {} }`. Claude's modern tool-call path accepts tasks only when the negotiated era is modern and its own task gates permit them (`allowTask: true`). The client declares task permission per request in its metadata envelope:

```json
{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {
    "name": "codex_job_watch", "arguments": { "jobId": "<jobId>" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": { "extensions": { "io.modelcontextprotocol/tasks": {} } }
    }
  }
}
```

There is no separate `task` parameter in that path. The response is `{ "resultType": "task", "taskId": "<jobId>", "status": "working", "ttlMs": null, "pollIntervalMs": 5000, ... }`. Modern `tasks/get` uses the same task ID params and metadata envelope: it returns a task handle while working, then `{ "resultType": "complete", "content": [...], "isError": false, ... }` containing the job result when terminal. Other modern replies include `resultType: "complete"`; list/discovery replies also carry `ttlMs: 0` and `cacheScope: "private"`. Without the client tasks extension on a modern call, start/watch keep ordinary behavior.

The binary's `execution` / capabilities `tasks` stripping function belongs to the **modern server result encoder**, called by that era's `encodeResult`. It is not a legacy client filter. The adapter follows that projection: modern tool lists omit `execution`, and modern discovery advertises the extension instead of the old capability. In the embedded legacy SDK, `cacheToolMetadata` records optional/required tool support, `isToolTask` additionally checks `tasks.requests.tools.call`, and `experimental.tasks.callToolStream` then supplies `task: {}`. These embedded helpers alone do not make Claude's current v2 tool-call path use legacy tasks.

No channel environment variable or development-channel launch flag is required for tasks. Claude's own feature gates still apply: the inspected binary checks `CLAUDE_CODE_DISABLE_MCP_TASKS`, its task rollout/server policy, background-session restrictions, and a separate worker-wake gate. The server can provide immediate handles, notifications, and terminal results; it cannot override a client setting that disables `/tasks` or model wake delivery. The stdio tests use fake workers and raw JSON-RPC for both eras; they do not run Claude Code or authenticate a real Codex CLI.

## Shared store and ownership

Both forks use `~/.agent-jobs/`, containing `config.json`, a machine lock, and `jobs/<id>/`. Each job saves `meta.json`, `prompt.txt`, `stdout`, `stderr`, `final.txt`, and `patch.diff`. Metadata and completed artifacts use atomic replacement; stdout and stderr are streamed to separate files. Metadata includes the owning server PID and process start time. Other servers can read a job but cannot run, update, or cancel it. Requeue creates a new record, so another server can retry a lost job without rewriting its history.

The machine-wide limit defaults to eight running jobs and is enforced with a lock file; stale locks are reclaimed by tombstone rename. Jobs waiting for a slot stay queued. Running and queued jobs whose owner has died become `lost`; partial output remains available. Recorded Windows descendants are checked against their saved start times before cleanup. Finished jobs older than seven days are pruned at startup. Usage-limit pauses are persisted in `pauses.json`; paused jobs retain reset times and retry after reset; without a reset they require explicit requeue. For a clock-only message such as "try again at 5:37 PM", a reset less than two hours in the past is treated as now plus 60 seconds, including messages received seconds after the named minute. If the retry still hits the limit, its fresh message pauses the job again. Older clock times (two hours or more in the past) resolve to tomorrow; future times remain today. A manual requeue supersedes the source job's automatic retry without clearing the connector/model pause.

```json
{
  "maxJobs": 8,
  "wakeHold": true,
  "connectors": {
    "codex": { "enabled": true, "defaultModel": null, "reviewModel": "gpt-6-astra" }
  }
}
```

`AGENT_JOBS_HOME` overrides the store directory; tests always use temporary directories. `AGENT_JOBS_MAX` overrides `maxJobs`. Config is read at startup. Enable or disable each connector through its MCP server registration; a missing sibling server does not prevent this server from working. Cross-connector handoffs wait unowned until the target server is running.

While jobs run, a helper inhibits sleep. On Windows Modern Standby systems it also holds the display on; detection is cached for one day. On Linux it uses `systemd-inhibit`. The helper exits when the server's stdin pipe closes, and failure to acquire the hold is non-fatal. Set `wakeHold: false` to disable it.

## Worktrees and collection

Worktrees start from the recorded `HEAD` SHA, under `<root>.worktrees/<label>-<id>`, with an `<connector>/<label>-<id>` branch. If the sibling location is inaccessible, creation falls back into the repository's common Git directory under `agent-jobs-worktrees/`. Dirty main-checkout changes are excluded and produce a warning. The worktree's Git directory is added to the CLI's writable directories.

After the job stops, collect with `remove: "none"`, `"worktree"`, or `"worktree+branch"`. Collection stages all files and diffs against the recorded base with `--binary`, capturing new files, binary files, and worker commits. It saves `patch.diff` before removal, returns a capped patch and full path, and reports removal failures. Applying the patch or merging the branch remains the caller's responsibility.

## Claude Code channel notifications (opt-in)

Claude Code Channels let an MCP server push events into a running session. To enable it, set `AGENT_JOBS_CHANNEL=1` in the server's environment and launch Claude Code with `claude-agents` (which runs `claude --dangerously-load-development-channels server:codex server:agy`).

When the variable is unset, the server declares no extra capability and sends nothing, so other MCP clients see no change. When it is set, the server declares `experimental: { 'claude/channel': {} }`, adds one line to its instructions, and sends one notification per job when this server's own job reaches `completed`, `failed`, `killed`, `paused`, or `lost`. Jobs owned by other servers are never announced, and a job is not announced twice for the same state. If the session did not load the server as a channel, Claude Code drops the events silently.

The payload is metadata only. The content is `codex job <state>: call codex_job_result with this job_id` (with the reset time added for `paused`). The attributes are `job_id`, `state`, `agent`, and `verify` (`passed` or `failed` when verification ran), plus `label` (sanitized to `[A-Za-z0-9_-]`, 40 characters at most), `reason`, and `reset_at` when known. Superseding a paused job sends one `killed` transition with `reason: "superseded"` and `superseded_by` identifying its replacement. Worker output (final text, stdout, stderr, patch) is never included, because it would be a prompt-injection vector; call `codex_job_result` to read it. A failed push is logged and never affects the job.

## Usage

`codex_usage` first asks a short-lived `codex app-server` for live quota without a model turn. If unavailable, it reads the newest `rate_limits` snapshot in `~/.codex/sessions`. `source` is `live` or `session-log` (also present when unavailable), with `available` and optional `reason`. Successful reports include `snapshotAt` (ISO), `snapshotAgeSec`, `meter`, and `fiveHour` / `weekly` windows. Each window has `usedPercent`, `windowMinutes`, `resetsAt` (epoch seconds), `resetAtIso`, and `resetIn`. Reset credits are reported when supplied; they are never spent automatically.

The sibling `agy_usage` uses the same snapshot, meter and window fields, nested under vendor-specific `groups`, with `source: live | cache`. Its optional `refresh` bypasses a five-minute cache; `tallies` adds local job token totals. Compatibility aliases `takenAt`, `summary`, and window `resetAt` remain available. Quota messages in either connector share absolute ISO, relative duration / retry-delay, and clock-only reset parsing, including the just-passed-time rule above. A model named in a quota message scopes the pause to that model.

`health` includes CLI detection (`available`, `exe`, `reason` when known), version, authentication, model IDs, effective `reviewModel`, `defaultModel`, and `jobsEnabled` within `codexCli` / `agyCli`. Codex additionally reports binary resolution and minimum-version features. Failed health checks retain their structured output shape.

Agy read jobs and legacy synchronous tools send one NDJSON prompt initially. Only an empty first response or non-empty `denied_actions` triggers the recovery turn; stdin then closes. A complete first response closes stdin immediately. An empty recovery response preserves an earlier non-empty answer. Timeouts and cancellation close stdin before cleanup. Codex continues to write its prompt and close stdin immediately.

## Development

`src/jobs/` is the portable source of truth in this fork. From Git Bash or Bash, `scripts/sync-jobs.sh [sibling-repository]` copies it into the agy fork (the script is identical in both repos and expects both to sit side by side). The comparison test fails on differences when the sibling copy exists. Set `AGENT_JOBS_MIRROR` to require comparison against a specific copy.

Run `npm test` for the fake-worker suite; it starts no real Codex jobs. Real CLI integration, resume behavior, orphan cleanup with CLI-created commands, Fedora wake inhibition, and a human check for window flashes require a separate opt-in integration run.


`codex_job_start` accepts `verify`, a shell command run through Git Bash in the job directory after the CLI succeeds, and `verifyTimeoutMin` (default 10 minutes). Verification is rejected in read mode. Its command, exit code, pass status, duration and timeout status appear as `verify` in job metadata, result and watch; the output tail is available through `job_read` as `verify`. A failed verification leaves the job `completed` so its patch remains collectable. Follow-ups and requeues inherit the command and timeout.

Worktree creation and collection disable Git hooks and configured clean, smudge and process filters and skip LFS smudging for their Git commands.


### Reasoning, stalls, and notification markers

Codex reasoning is saved in the `reasoning` job file, retaining the most recent 256 KiB. It is omitted from results by default: set `includeReasoning` on `job_result` for its last 4,000 characters, or `showReasoning` on `job_watch` to use the latest sentence for progress. `job_read` can page through the file.

`job_start` accepts `stallTimeoutMin` (default 10, zero disables detection) and `onStall` (`report`, the default, or `kill`). A stall means neither output file grew within the interval. Status and results expose `stalled` and `stalledSince`; output clears the flag. The kill option stops the worker with reason `stalled`, allowing requeue. Follow-ups and requeues inherit these settings.

A channel notification creates `jobs/<id>/woken` atomically before sending; an existing marker suppresses subsequent notifications. Returning a stopped job from `job_result` or `job_watch` creates `jobs/<id>/collected`. Hooks can use these markers to avoid duplicate wakeups and delivery.
