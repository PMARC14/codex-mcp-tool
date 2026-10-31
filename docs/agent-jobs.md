# Background jobs and worktrees

The existing synchronous tools remain available. The eight `codex_*` job tools add a persistent background queue, process-tree cancellation, timeouts, and isolated Git worktrees. `health` reports CLI availability and models; review defaults to `gpt-6-astra`.

| Tool                     | Purpose                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codex_job_start`        | Start with `prompt` or `promptFile`, `cwd`, and optional mode, model, effort, worktree, label, session, and timeout. Returns a job ID immediately.                       |
| `codex_job_status`       | State, elapsed time, session ID, and recent stderr/events. Omit `jobId` for live jobs.                                                                                   |
| `codex_job_result`       | Final text and full file path. `waitSec` is 0–10; output is capped at 20,000 characters.                                                                                 |
| `codex_job_cancel`       | Stop an owned job's process tree and wait for termination, up to 10 seconds.                                                                                             |
| `codex_job_list`         | Recent jobs from the shared store, newest first.                                                                                                                         |
| `codex_job_read`         | Read `prompt`, `stdout`, `stderr`, `final`, or `patch` by character offset, at most 20,000 characters per page.                                                          |
| `codex_job_requeue`      | Create a new queued job from a paused, lost, or failed job's saved prompt. Optional `model` overrides the model; optional `agent: "agy"` hands it to the sibling server. |
| `codex_worktree_collect` | Save a binary patch and diff stat, then optionally remove the worktree or worktree and branch.                                                                           |

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

The default mode is `read` (`read-only`). `write` uses `workspace-write`. `full` bypasses approvals and sandboxing and is used only when explicitly requested. Prompts always travel over stdin, including prompts to existing synchronous tools. On Windows, server-created processes are hidden and npm shims are resolved to JavaScript without invoking `cmd.exe`.

## Shared store and ownership

Both forks use `~/.agent-jobs/`, containing `config.json`, a machine lock, and `jobs/<id>/`. Each job saves `meta.json`, `prompt.txt`, `stdout`, `stderr`, `final.txt`, and `patch.diff`. Metadata and completed artifacts use atomic replacement; stdout and stderr are streamed to separate files. Metadata includes the owning server PID and process start time. Other servers can read a job but cannot run, update, or cancel it. Requeue creates a new record, so another server can retry a lost job without rewriting its history.

The shared limit defaults to eight. Jobs waiting for a slot stay queued. Running and queued jobs whose owner has died become `lost`; partial output remains available. Recorded Windows descendants are checked against their saved start times before cleanup. Finished jobs older than seven days are pruned at startup. Paused jobs retain usage-limit reset times and retry after reset; without a reset they require explicit requeue. A manual requeue supersedes the source job's automatic retry.

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

Claude Code Channels let an MCP server push events into a running session. This is a research preview feature: Claude Code asks for confirmation before loading a development channel, and the interface may change. To enable it, set `AGENT_JOBS_CHANNEL=1` in the server's environment and launch Claude Code with `claude --dangerously-load-development-channels server:<name>`, where `<name>` is the MCP server name you registered (for example `codex` in `claude mcp add codex ...`).

When the variable is unset, the server declares no extra capability and sends nothing, so other MCP clients see no change. When it is set, the server declares `experimental: { 'claude/channel': {} }`, adds one line to its instructions, and sends one notification per job when this server's own job reaches `completed`, `failed`, `killed`, `paused`, or `lost`. Jobs owned by other servers are never announced, and a job is not announced twice for the same state. If the session did not load the server as a channel, Claude Code drops the events silently.

The payload is metadata only. The content is `codex job <state>: call codex_job_result with this job_id` (with the reset time added for `paused`). The attributes are `job_id`, `state`, `agent`, plus `label` (sanitized to `[A-Za-z0-9_-]`, 40 characters at most), `reason`, and `reset_at` when known. Worker output (final text, stdout, stderr, patch) is never included, because it would be a prompt-injection vector; call `codex_job_result` to read it. A failed push is logged and never affects the job.

## Development

`src/jobs/` is the portable source of truth in this fork. From Git Bash or Bash, `scripts/sync-jobs.sh [sibling-repository]` copies it into the agy fork (the script is identical in both repos and expects both to sit side by side). The comparison test fails on differences when the sibling copy exists. Set `AGENT_JOBS_MIRROR` to require comparison against a specific copy.

Run `npm test` for the fake-worker suite; it starts no real Codex jobs. Real CLI integration, resume behavior, orphan cleanup with CLI-created commands, Fedora wake inhibition, and a human check for window flashes require a separate opt-in integration run.
