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
| `codex_job_read`         | Read `prompt`, `stdout`, `stderr`, `final`, or `patch` by character offset, at most 20,000 characters per page.                                                          |
| `codex_job_requeue`      | Create a new queued job from a paused, lost, or failed job's saved prompt. Optional `model` overrides the model; optional `agent: "agy"` hands it to the sibling server. |
| `codex_worktree_collect` | Save a binary patch and diff stat, then optionally remove the worktree or worktree and branch.                                                                           |
| `codex_usage`            | Read the latest Codex rate-limit snapshot from session logs. |

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

`codex_job_watch` keeps its MCP call pending until the job is completed, failed, killed, paused, or lost, or the wait expires. With a client-supplied progress token it reports immediately on local state changes and at least every 20 seconds while waiting. Messages have the form `running | 42s | last event or step summary`, on one line and capped at 120 characters. The heartbeat reads only metadata and the stdout tail; it never starts a process or probes process liveness. Changes written by another server are observed on the next heartbeat. Without a progress token no notifications are sent. A wait timeout returns `timedOut: true`; cancelling the watch only cancels the wait, leaving the job running. A client disconnect also ends the watch; running jobs continue and save their results after the MCP connection closes. In Claude Code the pending call becomes a background task after two minutes, showing the latest progress message and delivering the result when the watch settles.

`codex_job_send` requires a stopped job (`completed`, `failed`, `killed`, `paused`, or `lost`) with a `sessionId`. It starts a new job with the message as its prompt, resumes that native CLI session, and records `followUpOf` in its metadata. It preserves the connector, mode, model, effort, timeout, and existing worktree. If the worktree was removed or is missing, it falls back to the original working directory (older records fall back to the repository root). Follow-ups use the same queue, usage budgets, and machine-wide slot limit as `codex_job_start`; another connector's follow-up waits for that server to pick it up. Sending to a paused job supersedes its automatic retry while preserving the connector's quota pause. For a running or queued job, first use `codex_job_watch` and send once it stops, or call `codex_job_cancel`. A job whose process cleanup is still unconfirmed cannot receive a follow-up.

## Shared store and ownership

Both forks use `~/.agent-jobs/`, containing `config.json`, a machine lock, and `jobs/<id>/`. Each job saves `meta.json`, `prompt.txt`, `stdout`, `stderr`, `final.txt`, and `patch.diff`. Metadata and completed artifacts use atomic replacement; stdout and stderr are streamed to separate files. Metadata includes the owning server PID and process start time. Other servers can read a job but cannot run, update, or cancel it. Requeue creates a new record, so another server can retry a lost job without rewriting its history.

The machine-wide limit defaults to eight running jobs and is enforced with a lock file; stale locks are reclaimed by tombstone rename. Jobs waiting for a slot stay queued. Running and queued jobs whose owner has died become `lost`; partial output remains available. Recorded Windows descendants are checked against their saved start times before cleanup. Finished jobs older than seven days are pruned at startup. Usage-limit pauses are persisted in `pauses.json`; paused jobs retain reset times and retry after reset; without a reset they require explicit requeue. A manual requeue supersedes the source job's automatic retry.

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

The payload is metadata only. The content is `codex job <state>: call codex_job_result with this job_id` (with the reset time added for `paused`). The attributes are `job_id`, `state`, `agent`, plus `label` (sanitized to `[A-Za-z0-9_-]`, 40 characters at most), `reason`, and `reset_at` when known. Worker output (final text, stdout, stderr, patch) is never included, because it would be a prompt-injection vector; call `codex_job_result` to read it. A failed push is logged and never affects the job.

## Usage

`codex_usage` reads the latest `rate_limits` snapshot in `~/.codex/sessions` logs. The primary window is five hours and the secondary window is weekly.

## Development

`src/jobs/` is the portable source of truth in this fork. From Git Bash or Bash, `scripts/sync-jobs.sh [sibling-repository]` copies it into the agy fork (the script is identical in both repos and expects both to sit side by side). The comparison test fails on differences when the sibling copy exists. Set `AGENT_JOBS_MIRROR` to require comparison against a specific copy.

Run `npm test` for the fake-worker suite; it starts no real Codex jobs. Real CLI integration, resume behavior, orphan cleanup with CLI-created commands, Fedora wake inhibition, and a human check for window flashes require a separate opt-in integration run.
