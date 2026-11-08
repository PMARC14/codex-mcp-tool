# Handoff: codex-mcp-tool (fork, branch `agent-standard`)

**What it is.** An MCP server that lets Claude Code run Codex CLI as background agents. Forked from trishchuk/codex-mcp-tool (base `ab1238f5`, 2026-09-30); about 60–70% of the source is now ours. `src/jobs/` is the **canonical shared jobs module**. Sync it to the agy fork with `bash scripts/sync-jobs.sh`; `src/jobs/sync.test.ts` fails until the copies match.

**Tools:**
- `codex_agent` (launch; an MCP task that shows in `/tasks` and wakes Claude);
- `_message` (steer, answer or resume);
- `_answer`, `_follow`, `_status`, `_result`, `_read`, `_list`, `_stop`, `_retry`, `_collect`;
- `codex_usage`, `codex_selftest`, `codex_debug_log`, `health`.

The legacy tools load only with `CODEX_MCP_LEGACY_TOOLS=1`.

**Key behaviour:**
- **Transport:** `app-server` by default, which is steerable; approvals are `never` unless `approvals: "on-request"`. `exec` is still selectable.
- **MCP tasks:** the 2026-07-28 shape, as used by Claude Code 2.1.319; vendored schemas live in `src/tools/client-schemas.ts`.
- **Wakes, exactly one:** MCP task, else the external multi-agent hook-wait PostToolUse hook.
- **Ask-back:** the `ask_orchestrator` bridge (`src/bridge/`), plus Codex native questions.
- **Windows:** every spawn goes through the Job Object launcher (`CREATE_NO_WINDOW`), because Windows Terminal grabs any new console as a tab.
- **Usage and version checks:** every 15 min (30 on battery), plus one before and after each job; never while idle. Configure with `~/.agent-jobs/config.json` `usage.intervalMin` / `usage.batteryIntervalMin`.

**Docs:** `docs/agent-jobs.md` (full), `docs/job-surface-audit.md`, `README.md`.

**State (2026-11-07, evening):**
- Panel round 1 (`602b3d6`), round 2 (`69cdd0a`: named-pipe OS mutex in `lock.ts`, launcher by default in `safeSpawn`, orphan-answer supervision) and the channel removal (`0dbba35`: `claude-agents` / `CLAUDE_AGENTS` / `channel.ts` gone) are in. 221/221 tests from a clean `dist`.
- **Live-tested in plain `claude`:** start, steer (`app-server`, delivered mid-turn), ask-back via `ask_orchestrator` (hook wake, answer, re-arm) and finish, one wake each.
- **Mixed versions are unsafe:** round 2's `withLock` takes the pipe mutex and overwrites the `lock` file, so an older-build server (another open session) is not excluded. Reconnect or restart every session that loads this server after updating.
- Claude Code occasionally falls back to the pre-task protocol for one server (`initialize` after `server/discover`; 24 of 433 codex sessions). Such a session gets plain jobs, which the hook covers.
- Round 2 left dead helpers in `lock.ts` (`reclaimStale`, `releaseOwned`, `tryAcquire`, `staleContent`, now unused by `withLock`) and stripped some rationale comments. Remove or restore in the next pass.

**Next project:** extract `src/jobs` + `src/tools/{mcp-tasks,traffic-log,debug-tools,client-schemas}` + `src/bridge` into one standalone `agent-jobs` package or server, with Codex and agy as connectors. That drops the fork history, the sync script and the legacy tools. Upstream PRs are no longer practical; the changes are too large.

**Reviews and research:** `~/.agent-jobs/research/panel-2026-11-07/`, and `Documents\Research\mcp-agent-servers\`.
