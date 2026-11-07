# Background jobs and worktrees

The existing synchronous tools remain available. The `codex_*` job tools provide a persistent background queue, process-tree cancellation, timeouts, and isolated Git worktrees. The agy server exposes corresponding `agy_*` tools.

| Tool                     | Purpose                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codex_job_start`        | Start with `prompt` or `promptFile`, `cwd`, and optional mode, model, effort, worktree, label, session, and timeout. Returns a job ID immediately.                       |
| `codex_job_status`       | State, elapsed time, session ID, and recent stderr/events. Omit `jobId` for live jobs.                                                                                   |
| `codex_job_result`       | Final text and full file path. `waitSec` is 0–10; output is capped at 20,000 characters.                                                                                 |
| `codex_job_watch`        | Wait for a job to stop or pause, returning the result plus `watchedSec` and `timedOut`. `maxWaitSec` defaults to 1,800 and is capped at 7,200. |
| `codex_job_send`         | Send `message` to a stopped job's session as a new resumed job. Optional `mode`, `model`, `effort`, and `timeoutMin` override inherited settings. Returns `{ jobId, state, followUpOf }`. |
| `codex_job_steer`        | Send `{ jobId, message }` to an owned running job with interactive stdin. Returns `{ delivered: "mid-turn" \| "queued" }`. Codex requires `transport: "app-server"`. |
| `codex_job_respond`      | Answer an owned job question with `{ jobId, answer }`, or an app-server pending approval: `{ jobId, decision: "accept" \| "acceptForSession" \| "decline" \| "cancel" }`. |
| `codex_job_cancel`       | Stop an owned job's process tree and wait for termination, up to 10 seconds.                                                                                             |
| `codex_job_list`         | Recent jobs from the shared store, newest first.                                                                                                                         |
| `codex_job_read`         | Read `prompt`, `stdout`, `stderr`, `final`, `patch`, `verify`, or `notes` by character offset, at most 20,000 characters per page.                                                          |
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

## Steering and the opt-in Codex app-server transport

`codex_job_start` accepts `transport: "exec" | "app-server"`. Omission uses `AGENT_JOBS_CODEX_TRANSPORT`, then `config.json` `connectors.codex.defaultTransport`, then `exec`. The default retains its existing CLI arguments and prompt write-and-close behavior. `app-server` instead launches `codex app-server` through the same process runner, Windows Job Object, hidden-window handling, log files and process-tree cleanup. Transport and `approvalTimeoutMin` are saved in metadata and inherited by send and requeue.

```json
{
  "prompt": "Implement the parser change. Do not commit.",
  "cwd": "C:/repo",
  "mode": "write",
  "transport": "app-server",
  "approvalTimeoutMin": 30
}
```

While the job is running, call `codex_job_steer` with its `jobId` and a nonblank `message`. A successful `turn/steer` acknowledgement returns `delivered: "mid-turn"`. If completion races delivery, the process stays open while the pending steer resolves and starts a new turn with the message, returning `delivered: "queued"`. Completion normally closes stdin on the next event-loop iteration; after the process input closes, use `job_send` on the stopped job. Unrelated steer errors are returned without starting another turn. Each delivered steer appends one JSON line containing an ISO `timestamp` and `message` to `jobs/<id>/steer.log`; status reports `steers: <n>` (zero for older records).

The shared `<p>_job_steer` tool checks running state and server ownership. Its connector capability is generic: each process gets a fresh `StdinHandler` from `StdinPlan(context)`, optionally exposing `onSteer(message)` which returns (or resolves to) a stdin action plus `delivered`. `context.apply` supports asynchronous writes/EOF and `context.emit` produces job events. Optional `onInterrupt`, `onRespond` and `dispose` hooks manage interactive lifetimes; existing callable line handlers remain compatible. Connectors without `onSteer`, including default Codex exec and the current agy connector, reject with: `this job can't take mid-turn messages; use <p>_job_send after it stops, or start it with transport: app-server`. Agy can later supply its own queued stream-json user turn without depending on the Codex protocol.

For app-server, modes map to sandbox `read-only`, `workspace-write`, and `danger-full-access` (`trusted` and `full`). Read/write use approval policy `on-request`; trusted/full use `never`. Thus full bypasses sandboxing and approvals. The existing exec mode mapping is unchanged. Model, reasoning effort, cwd and worktree Git writable directory are passed as thread settings. `resumeSession` uses `thread/resume` instead of `thread/start` before starting the prompt turn. Session IDs, final agent messages, reasoning and usage-limit/error events enter the same job event pipeline as exec.

App-server cancellation first sends `turn/interrupt`, waits up to three seconds for the process to exit, and then performs the normal process-tree cleanup within the existing cancel deadline. Wall-clock timeouts still use normal cleanup directly.

Command, file-change and permission approval requests set `pendingApproval: { id, kind, summary, requestedAt }` in metadata; `summary` is capped at 300 characters and `requestedAt` is epoch milliseconds. Watch progress shows `awaiting approval`, task status projects to `input_required`, and the opt-in channel notifier sends one metadata-only event with `state=input_required` for each pending request. This approval event also applies to MCP-task jobs; it does not consume their terminal notification marker. Worker summaries and commands never enter channel payloads. Concurrent requests are held in arrival order and the first is exposed for response. Stall detection waits while approval is pending; the wall-clock timeout still applies.

Call `codex_job_respond` after inspecting `pendingApproval` in status. It sends the matching JSON-RPC response, clears the pending request (or exposes the next request), and returns `{ responded: true }`. `approvalTimeoutMin` is positive, defaults to 30, and automatically declines unanswered requests, persisting `approvalReason: "approval_timeout"` and `reason: "approval_timeout"` (a later cancellation, quota pause or wall-clock timeout can supersede `reason`). Permissions use a grant profile rather than a decision enum: accept grants the requested permissions for the turn, acceptForSession grants them for the session, decline/cancel grant nothing; permissions cancel also interrupts the turn. Turn completion, server-side resolution and process exit clear pending approvals and their timers.

### Locally discovered app-server wire protocol

Discovery used local **codex-cli 0.166.0** with `codex app-server --help`, `codex app-server generate-json-schema --out <temporary-directory>` and `codex app-server generate-ts --out <temporary-directory>`. The existing `readLiveCodexUsage` initialize exchange was also inspected. Discovery started no model turn; tests use a small Node JSON-RPC peer only. Messages are newline-delimited JSON on stdio, with numeric client request IDs and server request IDs echoed unchanged. The used methods/shapes are:

| Method | Request / notification shape and handling |
| --- | --- |
| `initialize` | `{ id: 1, method: "initialize", params: { clientInfo: { name: "codex-mcp-tool", title: "Codex jobs", version: "1" }, capabilities: null } }`; await result. |
| `initialized` | `{ method: "initialized" }`, a notification sent after initialize succeeds. |
| `thread/start` | `{ id, method, params: { cwd, model?, sandbox, approvalPolicy, config } }`; result contains `{ thread: { id } }`. `config` carries `model_reasoning_effort` and, for write worktrees, `"sandbox_workspace_write.writable_roots": [gitDir]`. |
| `thread/resume` | Same thread settings plus `threadId: resumeSession`; result contains `{ thread: { id } }`. |
| `turn/start` | `{ id, method, params: { threadId, input: [{ type: "text", text, text_elements: [] }], effort? } }`; result contains `{ turn: { id } }`. |
| `turn/steer` | `{ id, method, params: { threadId, expectedTurnId: currentTurnId, input: [{ type: "text", text, text_elements: [] }] } }`; result `{ turnId }`. The generated schema has **no separate `turnId` request field**. |
| `turn/interrupt` | `{ id, method, params: { threadId, turnId: currentTurnId } }`; result `{}`. |
| `thread/started` | `{ method, params: { thread: { id, ... } } }` records `sessionId`. |
| `turn/started`, `turn/completed` | `{ method, params: { threadId, turn: { id, status, error, ... } } }`; track active ID, handle errors and close stdin after completion unless control is in flight. |
| `item/completed` | `{ method, params: { threadId, turnId, item, completedAtMs } }`; `item: { type: "agentMessage", text, ... }` becomes final; `{ type: "reasoning", summary: string[], content: string[], ... }` becomes reasoning. |
| `error` | `{ method, params: { threadId, turnId, error: { message, codexErrorInfo, ... }, willRetry } }`; nonretry errors enter the existing error/quota handling, including `usageLimitExceeded` / `rateLimitExceeded`. |
| `item/commandExecution/requestApproval` | Server request `{ id, method, params: { threadId, turnId, itemId, command?, reason?, ... } }`; reply `{ id, result: { decision } }`. |
| `item/fileChange/requestApproval` | Server request with `{ threadId, turnId, itemId, reason?, ... }`; reply `{ id, result: { decision } }`. |
| `item/permissions/requestApproval` | Server request with `{ threadId, turnId, itemId, permissions: { network, fileSystem }, reason, ... }`; reply `{ id, result: { permissions: <granted non-null fields or {}>, scope: "turn" | "session" } }`. |
| `serverRequest/resolved` | `{ method, params: { threadId, requestId } }` clears a request resolved by the server. |

Command/file approval decisions are exactly `accept`, `acceptForSession`, `decline`, or `cancel`. Unsupported server request methods receive JSON-RPC error `-32601` instead of hanging silently. Client request responses are bounded to 30 seconds; the overall job timeout also bounds startup and processing.

## MCP tasks (no launch flag)

Only `codex_job_start` and `codex_job_watch` support task augmentation. Ordinary calls retain their existing responses, progress notifications, cancellation semantics, and optional channels. A task start launches the same job as an ordinary start. A task watch adopts the supplied `jobId` immediately; it tracks the job through pauses and automatic retries, independent of `maxWaitSec`. Its final payload is `job_result`, without the ordinary watch's `watchedSec` and `timedOut` fields.

Task IDs equal job IDs. State and results come from the shared job store; a small `jobs/<id>/mcp-task.json` marker records membership in `tasks/list` across reconnects. Listing includes task-augmented jobs for this connector only. Read-only `tasks/get` and `tasks/result` also accept any known job ID for this connector, without subscribing the new connection to notifications. Cancellation retains the job manager's existing ownership checks: another server process can read a job but cannot cancel it.

| Job state | Task status | Message |
| --- | --- | --- |
| queued, running | `working` | The same bounded progress line as ordinary watch |
| running with pendingApproval | `input_required` | awaiting approval |
| running with awaitingInput | `input_required` | awaiting answer |
| paused | `working` | Paused until the ISO reset time, or reset time unknown |
| completed | `completed` | Watch progress line |
| failed, lost | `failed` | Watch progress line |
| killed | `cancelled` | Watch progress line |
| killed with reason superseded | `cancelled` | Names `supersededBy`; the replacement has its own job/task ID |

Polling is suggested every 15,000 ms. Status reads use saved metadata and a bounded stdout tail; they never spawn a process or probe process liveness. The server sends `notifications/tasks/status` on local state transitions only for tasks started or adopted through the current connection. Closing the connection removes its subscription and leaves workers running. Foreign writes are visible on polling. `tasks/result` waits for a terminal state using transitions plus a 5-second metadata check, and returns exactly the same JSON text and MCP content wrapper as `codex_job_result`. Cancelling that pending request only stops the wait; `tasks/cancel` stops the job. Requested TTLs do not shorten job retention: `ttl` / `ttlMs` is `null`, with no separate task expiry timer; the existing cleanup of terminal jobs older than seven days still applies.

### Negotiation and wire shapes (Claude Code 2.1.319)

Claude Code 2.1.319 discovers `2026-07-28` using `server/discover` and the `io.modelcontextprotocol/tasks` extension. Task permission is per call: `_meta["io.modelcontextprotocol/protocolVersion"]` is `"2026-07-28"`, and `_meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]` is `{}`. Without that extension, start/watch retain ordinary behavior. No channel flag is required; client feature gates still control backgrounding and wake delivery.

Create returns `{ resultType: "task", taskId, status, statusMessage, createdAt, lastUpdatedAt, ttlMs: null, pollIntervalMs: 15000, _meta }`. Modern get/cancel and each list entry/status notification use the status-discriminated task shape, without a `resultType` envelope:

- `working` for queued/running/paused jobs;
- `input_required` with `inputRequests: {}` for approvals answered via `codex_job_respond`, or a keyed `elicitation/create` form for bridge/native questions;
- `completed` with `result: { content, isError }`, identical to `codex_job_result`;
- `failed` for failed/lost jobs, with `error.message` containing failureReason and a short reason; `result` remains available for diagnostics;
- `cancelled` for killed jobs.

`tasks/result` still returns the tool content wrapper. The previous terminal `{ resultType: "complete", content, ... }` get reply lacked `status` and failed the client's union parser. Vendored Zod schemas in `src/tools/client-schemas.ts` mirror the binary's `_`, `re`, `X_a`, `se` and input-request schemas; raw stdio contract tests validate modern replies against them.

The isolated 2025 SDK adapter and its tests remain for clients using the installed MCP SDK's task helpers and `initialize` negotiation. They use `{ task: ... }`, `ttl`, and `pollInterval`. Claude Code 2.1.319 explicitly no longer restores that era's tasks and uses only the modern path. Keeping this compatibility adapter requires no legacy dependency or separate scheduler.

Task-start `_meta["com.anthropic/agent-task"]` contains `kind: "codex-agent"`, `taskId`, an existing valid native `sessionId` when available, and a one-line `modelImmediateResponse` naming the agent and supported controls. Binary inspection (Python mmap, no execution) found that kind/sessionId are validated and forwarded through `sdkAgentTaskMeta`; there is no use of those fields to rename the terminal `/tasks` row. Names therefore come from statusMessage: `<connector> <model> · <label> | <state> | <elapsed> | <step>`.

The binary's `boundMcpStatusMessage` replaces Unicode Cc/Cf/Cs/Zl/Zp and variation selectors with spaces, collapses spaces, trims, and truncates at 10,000 characters plus `… [truncated]`. Our one-line messages remain capped at 120 characters. Task/session IDs and input methods are at most 128 printable non-space ASCII characters (`/^[\x21-\x7e]+$/`); kind has the same regex and a 64-character cap. The immediate-response schema cap is 20,000 (the client also sanitizes and bounds its displayed note).

### Live diagnostics

`codex_selftest` exercises the real stdio transport and task handlers in-process with an isolated fake manager, through start, get/list/result, terminal states, cancellation and notifications. It validates replies against the vendored client schemas and returns per-step pass/fail plus `logPath`. It never starts a CLI or model. `codex_debug_log { lines: 50 }` returns the last 1-200 lines of this server's traffic log.

Every incoming/outgoing JSON-RPC message is summarized in `~/.agent-jobs/logs/codex-<pid>.ndjson` (`AGENT_JOBS_HOME` changes the root). Entries include timestamp, direction, method/id, original byte size, and a summary capped at 2 KB. Tool arguments have a combined 200-character preview; prompts, messages, text, reasoning and worker content are redacted. Rotation occurs at 5 MB, keeping the active file and two backups. `AGENT_JOBS_DEBUG=full` raises the summary cap to 16 KB while retaining redaction. Handler exceptions log their stack and return an MCP error naming the failing method/field; ordinary tool failures include structured error details.

## Worker-to-orchestrator bridge

Codex jobs automatically inject the built `dist/bridge/agent-bridge.js` stdio MCP server when that file exists, using per-run overrides. They add this preamble only while the bridge is active: "If you need a decision or information from the orchestrator, call `ask_orchestrator`; use `report_progress` for milestone notes." Missing bridge builds preserve the original prompt and do not inject configuration. No global Codex configuration is modified.

`ask_orchestrator { question, options?, timeoutSec? }` atomically writes `jobs/<id>/question.json` as `{ id, question, options, askedAt }`. It checks for `answer-<qid>.json` with a timer and `statSync` every two seconds, reading only when the file exists. It returns the answer text, or `no answer within N s; continue with your best judgement`. The default wait is 1,800 seconds; the maximum is 86,400. Questions are serialized per job, and cancellation/timeout clears the mailbox. Job wall-clock timeouts still apply. `report_progress { note }` appends `{ ts, note }` to `notes.ndjson` and returns immediately. The latest note supplies the progress step (at most 80 characters); `codex_job_read { jobId, name: "notes" }` reads saved notes.

The manager's existing 500 ms sampler stats the question and notes files; it reads only changed files. Pending metadata is `awaitingInput: { qid, question, options, askedAt }`, with the question capped at 500 characters. While pending, progress/task status says `awaiting answer` and stall detection waits. Answer with `codex_job_respond { jobId, answer }`. `codex_job_steer { jobId, message }` also answers a pending question (including exec jobs) and returns `delivered: "answer"`; when no question is pending, the existing app-server steering requirement applies. Answers are saved atomically and clear `awaitingInput`.

Modern tasks publish `status: "input_required"` and `inputRequests[qid] = { method: "elicitation/create", params: { mode: "form", message, requestedSchema } }`. The schema has one required string property `answer`, using `enum` when options are supplied. Claude Code 2.1.319's task driver sends `{ taskId, inputResponses: { [qid]: { action: "accept", content: { answer } } } }` to `tasks/update`. The server writes the answer and resumes polling; decline/cancel supplies a best-judgement response to the worker. Duplicate acknowledged updates are idempotent; stale keys cannot answer newer questions. This path round-trips through `TaskStdioTransport` in fake-worker tests. It does not require `requestState`: that belongs to the client's separate multi-round ordinary-call envelope, whereas the task driver keys answers by task ID and question ID. Elicitation asks the **user** when the client can show a form; the orchestrator may instead answer through respond/steer. Client sessions that cannot show elicitation can cancel such tasks, according to their own policy.

Native app-server `item/tool/requestUserInput` requests use the same question mailbox. Responses use the generated schema's `{ answers: { [nativeQuestionId]: { answers: [text] } } }`. For multiple native questions, supply a JSON object mapping native question IDs to answer strings, or a prose answer applied to each. Completion, server-side resolution and disposal clear native-question timers. The bridge is the question path for headless exec; native `request_user_input` is not enabled there.

### Exact injection and discovery

Discovery used only local `codex --help`, `codex mcp --help`, `codex mcp add --help`, `codex app-server generate-json-schema --experimental`, and `codex ... mcp get agent_bridge --json` to validate TOML config parsing. These commands do not start a model turn. The generated `ThreadStartParams`/`ThreadResumeParams` accept object-valued `config`; `ToolRequestUserInputParams`/`Response` supply the native question contract.

Exec receives these argv pairs (each override is one argv element, without shell quotes around it; JSON string encoding supplies valid TOML escaping for Windows paths):

```text
-c mcp_servers.agent_bridge.command="<absolute node executable>"
-c mcp_servers.agent_bridge.args=["<absolute path>/dist/bridge/agent-bridge.js"]
-c mcp_servers.agent_bridge.env.AGENT_JOBS_HOME="<absolute jobs home>"
-c mcp_servers.agent_bridge.env.AGENT_JOB_ID="<job id>"
-c mcp_servers.agent_bridge.enabled=true
-c mcp_servers.agent_bridge.enabled_tools=["ask_orchestrator","report_progress"]
-c mcp_servers.agent_bridge.tool_timeout_sec=86500
-c mcp_servers.agent_bridge.tools.ask_orchestrator.approval_mode="approve"
-c mcp_servers.agent_bridge.tools.report_progress.approval_mode="approve"
```

The timeout covers the maximum bridge wait plus a margin, rather than the CLI's short default. Per-tool approval overrides let these two tools run in all job modes while retaining other approval policies. App-server receives the equivalent nested object in `thread/start` or `thread/resume`: `config.mcp_servers.agent_bridge = { command, args, env, enabled, enabled_tools, tool_timeout_sec, tools: { ask_orchestrator: { approval_mode: "approve" }, report_progress: { approval_mode: "approve" } } }`.

Connectors have an optional `bridgeConfig(job)` hook returning argv and/or `{ path, content, cleanup }` file descriptions. Codex implements it with in-memory per-run config. A future agy implementation can use the file descriptions for temporary project configuration; no agy configuration files or lifecycle changes are implemented in this phase.

### Hooks and channels

Hooks should watch `meta.json.awaitingInput` (`qid`, bounded `question`, `options`, `askedAt`) and `meta.json.pendingApproval` (`id`, `kind`, `summary`, `requestedAt`), independently of the job's `running` state. A pending question needs `codex_job_respond { answer }`; a pending approval needs `{ decision }`. Cleared fields mean the response was delivered or the request ended. This repository does not modify `multi-agent/scripts/hook-wait.sh`.

With `CLAUDE_AGENTS=1`, each non-task job question emits one deduplicated metadata-only event with `state=input_required`, `kind=question`, and `job_id`. Neither question text, options, note text nor worker output enters channel payloads. Question events do not consume terminal notification markers.

## Shared store and ownership

Both forks use `~/.agent-jobs/`, containing `config.json`, a machine lock, and `jobs/<id>/`. Each job saves `meta.json`, `prompt.txt`, `stdout`, `stderr`, `final.txt`, and `patch.diff`. Metadata and completed artifacts use atomic replacement; stdout and stderr are streamed to separate files. Metadata includes the owning server PID and process start time. Other servers can read a job but cannot run, update, or cancel it. Requeue creates a new record, so another server can retry a lost job without rewriting its history.

The machine-wide limit defaults to eight running jobs and is enforced with a lock file; stale locks are reclaimed by tombstone rename. Jobs waiting for a slot stay queued. Running and queued jobs whose owner has died become `lost`; partial output remains available. Recorded Windows descendants are checked against their saved start times before cleanup. Finished jobs older than seven days are pruned at startup. Usage-limit pauses are persisted in `pauses.json`; paused jobs retain reset times and retry after reset; without a reset they require explicit requeue. For a clock-only message such as "try again at 5:37 PM", a reset less than two hours in the past is treated as now plus 60 seconds, including messages received seconds after the named minute. If the retry still hits the limit, its fresh message pauses the job again. Older clock times (two hours or more in the past) resolve to tomorrow; future times remain today. A manual requeue supersedes the source job's automatic retry without clearing the connector/model pause.

```json
{
  "maxJobs": 8,
  "wakeHold": true,
  "connectors": {
    "codex": { "enabled": true, "defaultModel": null, "reviewModel": "gpt-6-astra", "defaultTransport": "exec" }
  }
}
```

`AGENT_JOBS_HOME` overrides the store directory; tests always use temporary directories. `AGENT_JOBS_MAX` overrides `maxJobs`. Config is read at startup. Enable or disable each connector through its MCP server registration; a missing sibling server does not prevent this server from working. Cross-connector handoffs wait unowned until the target server is running.

While jobs run, a helper inhibits sleep. On Windows Modern Standby systems it also holds the display on; detection is cached for one day. On Linux it uses `systemd-inhibit`. The helper exits when the server's stdin pipe closes, and failure to acquire the hold is non-fatal. Set `wakeHold: false` to disable it.

## Worktrees and collection

Worktrees start from the recorded `HEAD` SHA, under `<root>.worktrees/<label>-<id>`, with an `<connector>/<label>-<id>` branch. If the sibling location is inaccessible, creation falls back into the repository's common Git directory under `agent-jobs-worktrees/`. Dirty main-checkout changes are excluded and produce a warning. The worktree's Git directory is added to the CLI's writable directories.

After the job stops, collect with `remove: "none"`, `"worktree"`, or `"worktree+branch"`. Collection stages all files and diffs against the recorded base with `--binary`, capturing new files, binary files, and worker commits. It saves `patch.diff` before removal, returns a capped patch and full path, and reports removal failures. Applying the patch or merging the branch remains the caller's responsibility.

Before removal, collection walks ordinary directories and unlinks junctions and symlinks, including nested and dangling links. It removes only each link, leaving its target untouched. A failed Git removal is retried with `core.longpaths=true`. Before the first removal attempt, `patch.diff.removal-attempted` saves the patch's stat summary. Later collections reuse the saved patch and summary, even after a restart, because a failed removal may have already deleted tracked files. Missing saved artifacts cause an error instead of collecting from a partially removed worktree.

## Claude Code channel notifications (opt-in)

Claude Code Channels let an MCP server push events into a running session. Launch with `claude-agents`, which exports `CLAUDE_AGENTS=1` and loads `server:codex` and `server:agy` as development channels. The launcher flag must equal `1`; otherwise the server declares no channel capability, adds no channel instructions, and sends no events or markers.

| Session or job | Wake path |
| --- | --- |
| Plain `claude` | MCP task when used; otherwise the PostToolUse `asyncRewake` hook. |
| `claude-agents` | MCP task when used; otherwise channel events. The hook stands down in launcher sessions. |
| MCP-task jobs | Task only; channel and hook skip these jobs. |

The launcher and hook must implement this convention together. `AGENT_JOBS_CHANNEL` is retained in existing configurations but is no longer required or consulted. A plain session does not receive channel events, even if `AGENT_JOBS_CHANNEL=1` is configured. The server declares `experimental: { 'claude/channel': {} }` and sends notifications for its own jobs reaching `completed`, `failed`, `killed`, `paused`, or `lost` only when the launcher flag is set. Other owners and MCP-task jobs are skipped. Claude Code can silently drop events when channels were not loaded, so the launcher must load them as well as export the flag. Claude Code's MCP environment allowlist mode does not inherit this flag; in that mode the launcher must also pass `CLAUDE_AGENTS=1` through the server configuration `env` or a launcher-specific server wrapper.

The payload is metadata only. The content is `codex job <state>: call codex_job_result with this job_id` (with the reset time added for `paused`). The attributes are `job_id`, `state`, `agent`, and `verify` (`passed` or `failed` when verification ran), plus `label` (sanitized to `[A-Za-z0-9_-]`, 40 characters at most), `reason`, and `reset_at` when known. Superseding a paused job sends one `killed` transition with `reason: "superseded"` and `superseded_by` identifying its replacement. Worker output (final text, stdout, stderr, patch) is never included, because it would be a prompt-injection vector; call `codex_job_result` to read it. A failed push is logged and never affects the job.

## Usage

`codex_usage` reads the machine-wide usage cache, refreshing through a short-lived `codex app-server` without a model turn when due. If unavailable, it reads the newest `rate_limits` snapshot in `~/.codex/sessions` or uses the last cached parsed value. `source` is `live` or `session-log` (also present when unavailable), with `available` and optional `reason`. Successful reports include `snapshotAt` (ISO), `snapshotAgeSec`, `meter`, and `fiveHour` / `weekly` windows. Each window has `usedPercent`, `windowMinutes`, `resetsAt` (epoch seconds), `resetAtIso`, and `resetIn`. Reset credits are reported when supplied; they are never spent automatically.

The vendor-neutral `getUsage(connector, probe, opts)` in `src/jobs/usage-cache.ts` stores `{ takenAt, ok, raw, parsed }` at `~/.agent-jobs/cache/<connector>-usage.json` (or under `AGENT_JOBS_HOME`). The default TTL is five minutes, extended to fifteen minutes on battery or after a failed probe. A failed probe retains the last parsed value, with `ok: false`. An exclusive `wx` lock allows one probe per connector across processes; other readers immediately return the last snapshot, even stale, or `undefined` when none exists. Locks become stale after two minutes; probe timeouts must be shorter. Windows power status is queried through `GetSystemPowerStatus` and its result is also shared and cached, rather than queried per reader. `opts` can supply `home`, `now`, `onBattery`, `ttlMs`, `backoffMs`, and `staleLockMs` for adapters and fake-only tests.

Codex `detect()`, `usagePercent()` and `codex_usage` share this cache. Detection derives authentication from the cached usage response and never runs `codex login status` independently. Explicit signed-out responses report unavailable; an unknown or failed usage response fails open and observes the fifteen-minute backoff. The existing live-usage reader does not distinguish every auth failure from other unavailable responses. Agy and external quota-meter readers must adopt `getUsage` in their own port to share this coordination; this patch changes the Codex consumers only.

The sibling `agy_usage` uses the same snapshot, meter and window fields, nested under vendor-specific `groups`, with `source: live | cache`. Its optional `refresh` bypasses a five-minute cache; `tallies` adds local job token totals. Compatibility aliases `takenAt`, `summary`, and window `resetAt` remain available. Quota messages in either connector share absolute ISO, relative duration / retry-delay, and clock-only reset parsing, including the just-passed-time rule above. A model named in a quota message scopes the pause to that model.

`health` includes CLI detection (`available`, `exe`, `reason` when known), version, authentication, model IDs, effective `reviewModel`, `defaultModel`, and `jobsEnabled` within `codexCli` / `agyCli`. Codex additionally reports binary resolution and minimum-version features. Failed health checks retain their structured output shape.

Agy read jobs and legacy synchronous tools send one NDJSON prompt initially. Only an empty first response or non-empty `denied_actions` triggers the recovery turn; stdin then closes. A complete first response closes stdin immediately. An empty recovery response preserves an earlier non-empty answer. Timeouts and cancellation close stdin before cleanup. Codex continues to write its prompt and close stdin immediately.

## Development

`src/jobs/` is the portable source of truth in this fork. From Git Bash or Bash, `scripts/sync-jobs.sh [sibling-repository]` copies it into the agy fork (the script is identical in both repos and expects both to sit side by side). The comparison test fails on differences when the sibling copy exists. Set `AGENT_JOBS_MIRROR` to require comparison against a specific copy.

Run `npm test` for the fake-worker suite; it starts no real Codex jobs. Real CLI integration, resume behavior, orphan cleanup with CLI-created commands, Fedora wake inhibition, and a human check for window flashes require a separate opt-in integration run.


`codex_job_start` accepts `verify`, a shell command run through Git Bash in the job directory after the CLI succeeds, and `verifyTimeoutMin` (default 10 minutes). Verification is rejected in read mode. Its command, exit code, pass status, duration and timeout status appear as `verify` in job metadata, result and watch; the output tail is available through `job_read` as `verify`. A failed verification leaves the job `completed` so its patch remains collectable. Follow-ups and requeues inherit the command and timeout.

Worktree creation and collection disable Git hooks, fsmonitor, configured clean, smudge and process filters, and skip LFS smudging for every Git command, including configuration discovery. Both patch and stat diffs disable external diff and textconv drivers. Filter names containing `=` cannot be safely overridden with Git's `-c` syntax, so creation and collection refuse such configurations with an explicit error before checkout or staging; remove or rename that filter configuration first.

Windows child start-time inspection retries once if the child handle is still alive. If both attempts fail, cancellation uses the live child handle and PID-based `taskkill /T`; a persisted PID without a verified start time alone does not authorize termination. Empty-start owners whose PIDs remain alive retain their slots. Cached Job Object launchers are checked for existence before reuse and rebuilt or replaced by process-tree cleanup when missing. Without Job Object containment, snapshots follow recorded parents even after they exit, while rejecting observed PID reuse. Descendants whose entire intermediate parent lifetime falls between snapshots and was never recorded remain a limitation of this fallback.

Cooperative cancellation gets a three-second interrupt grace followed by a separate ten-second process-tree cleanup budget. A process that closes during the grace needs no further termination. Worker and verification close callbacks wait for settlement before releasing a failed-cleanup reservation. A server recovering its connector's orphan becomes the recorder of the `lost` state and can retry cleanup with `job_cancel`. Lost notifications recovered before transport connection are replayed on notifier startup; the shared exclusive `channel-sent` marker prevents duplicate channel attempts.


### Reasoning, stalls, and notification markers

Codex reasoning is saved in the `reasoning` job file, retaining the most recent 256 KiB. It is omitted from results by default: set `includeReasoning` on `job_result` for its last 4,000 characters, or `showReasoning` on `job_watch` to use the latest sentence for progress. `job_read` can page through the file.

`job_start` accepts `stallTimeoutMin` (default 10, zero disables detection) and `onStall` (`report`, the default, or `kill`). A stall means neither output file grew within the interval. Status and results expose `stalled` and `stalledSince`; output clears the flag. The kill option stops the worker with reason `stalled`, allowing requeue. Follow-ups and requeues inherit these settings.

Waiting for approval resets the stall clock on every sample, and an approval response starts a fresh interval. MCP task status notifications track the derived status, including `working` to `input_required` and back. Modern (`2026-07-28`) cancellation returns a task projection with `ttlMs` and `pollIntervalMs`; a terminal `tasks/get` returns the completed result payload. Explicit failure reasons and `lost` take precedence over authentication text, whose fallback matching uses whole words.

A channel notification exclusively creates its own `jobs/<id>/channel-sent` marker to deduplicate channel attempts. Question and approval events use `channel-sent-<hash>`. Channels never create `woken`: that marker belongs to the PostToolUse wake hook. Returning a stopped job from `job_result` or `job_watch` creates `jobs/<id>/collected`, which lets the hook skip results already collected. The launcher hook stands down in channel sessions, so the separate markers do not cause a second wake.


Jobs started or adopted as MCP tasks do not send channel notifications: the task provides its own wake. Returning to queued or running clears the per-attempt `woken`, `channel-sent`, and `collected` markers.

`job_start` accepts an optional `idempotencyKey`; a matching connector and key created within 24 hours returns the existing job. `priority` defaults to `normal`; `optional` starts are rejected when either the five-hour or weekly usage window reaches `usageCeiling` (default 90 percent). The optional-start guard reads the shared usage cache; unknown usage permits the start. Codex uses the same live snapshot as detection and `codex_usage`, with a session-log fallback when live usage is unavailable.

Stopped jobs expose `failureReason` for quota exhaustion, timeout, cancellation, stalls, authentication, CLI errors, failed cleanup, lost ownership, superseding, and failed verification. `partial: true` indicates output without a final answer or an interrupted run. A completed job with failed verification can be requeued. Verification uses Git Bash on Windows, selected by `AGENT_JOBS_BASH`, then `CLAUDE_CODE_GIT_BASH_PATH`, Git's installation, or Program Files; POSIX uses bash. Git worktree operations allow ten minutes per command and failed creation cleans up its partial worktree and branch.

For `codex_job_respond`, pass the `qid` shown in `awaitingInput` or the watch status to reject answers intended for an older question. Omitting it answers the current question; the response includes the `qid` answered, even if the question arrived after the last status read. Bridge questions can be answered by another server; app-server approvals require the owning server.

Native and bridge questions share a per-job claim. A second question receives an "already awaiting an answer" error; it can be retried after the first clears. Claims expire at the question timeout. If a server disappears while a matching file-based question remains unanswered, orphan recovery waits until an answer is written or the question expires, then resumes its usual cleanup; answering does not transfer ownership of the worker.
