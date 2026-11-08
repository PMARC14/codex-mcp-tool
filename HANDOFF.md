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

**State (2026-11-07):**
- **Panel review round 1 is in** (`602b3d6`).
- **Round 2 was in flight** (Flash job `9d21e890`): an OS-level named-pipe mutex in `lock.ts`, `safeSpawn` using the launcher by default, the orphan-answer fix, and real interleaving tests. Collect, test twice, commit, then run `scripts/sync-jobs.sh` into the agy fork.
- **Not yet live-tested in the real client:** the `/mcp` reconnect, then start, steer, ask-back and finish in both launch modes. `codex_selftest` checks the protocol path.

**Next project:** extract `src/jobs` + `src/tools/{mcp-tasks,traffic-log,debug-tools,client-schemas}` + `src/bridge` into one standalone `agent-jobs` package or server, with Codex and agy as connectors. That drops the fork history, the sync script and the legacy tools. Upstream PRs are no longer practical; the changes are too large.

**Reviews and research:** `~/.agent-jobs/research/panel-2026-11-07/`, and `Documents\Research\mcp-agent-servers\`.
