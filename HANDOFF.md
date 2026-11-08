# Handoff: codex-mcp-tool (fork, branch `agent-standard`)

An MCP server that lets Claude Code run Codex CLI as background agents. `src/jobs/` is the canonical shared jobs module. Sync it to the agy fork with `bash scripts/sync-jobs.sh`; the sibling-sync check fails until the copies match.

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

**Core fixes and regression tests:**

| Fix | Implementation | Regression test |
| --- | --- | --- |
| 1. Mixed-version exclusion | `lock.ts:363`: pipe mutex plus legacy file protocol; owner-checked release of both. | `withLock excludes a live legacy file-lock holder without overwriting it` |
| 2. Canonical mutex keys | `lock.ts:30`: resolve real paths and existing ancestors; normalize Windows case/separators. | `mutex address canonicalizes Windows case and separator variants` |
| 3. Collection after reconnect | `manager.ts:1144`: same-connector terminal collection under the shared lock. | `reconnected same-connector server collects terminal jobs but refuses foreign or active jobs` |
| 4. Trusted approvals | `codexAppServer.ts:155`: only full forces never. | `trusted app-server honors requested approvals while full always bypasses them` |
| 5. Meaningful stall progress | `manager.ts:761`, `codex.ts:30`: background notifications do not reset or clear stalls. | `noise-only worker output flags a stall and only meaningful output clears it` |
| 6. Model quota pools | `connector.ts`, `manager.ts:306`: pass resolved models; cache per model. | `optional quota guard resolves models and caches each model independently` |
| 7. Resume labels | `manager.ts:378`: resumed jobs inherit the label; requeue preserves it. | `resume and requeue inherit the original job label` |
| 8a. Safe removal retry | `worktree.ts:178`: refuse changed files or legacy markers without snapshots. | `collection retry refuses removal when a reused worktree contains newer edits` |
| 8b. Orphan final recovery | `manager.ts:200`: recover final output once the preserved worker exits and cleanup succeeds. | `an answered orphan exiting zero recovers its final answer instead of becoming lost` |
| 8c. Dead question claims | `question-claim.ts:10`: a free mutex makes an old claim reclaimable immediately. | `an unexpired question claim left by a dead bridge is immediately reclaimable` |
| Additional cache fix | `usage-cache.ts:86`: preserve successful snapshots; keep failure/backoff state in a separate file. | `concurrent usage calls keep the last good disk snapshot when the active probe fails` |

All three suspected bugs, 8a–c, are confirmed. Each fix has a regression observed failing before implementation. The additional cache test confirms snapshot replacement on failure; its concurrent caller is excluded by the mutex, so duplicate live probes were not reproduced.

**Operational rules:**

- Keep the legacy lock helpers and file lock until no pre-69cdd0a server can run.
- Inspect and save newer edits before manually removing a changed worktree after a failed removal attempt. The original saved patch remains available.
- Recovered orphan completion uses nonempty `final.txt` as evidence. The exited worker's code is unavailable; verification is not rerun during recovery.
- Usage failures retain the successful `<connector>-usage.json`; `<connector>-usage.failure.json` stores failure reporting and backoff. Success clears the failure record.

**Validation:** both final `npm test` runs built successfully and reported 239 tests: 238 passed, 1 failed, 0 skipped. The only failure in each was `sibling jobs module is byte-identical when installed`; `AGENT_JOBS_MIRROR` points to the untouched main checkout. `git diff --check` passes. The Windows lock-handoff fixture waits for identity initialization and allows one second for scheduling and disk contention.

**Files changed:**

- Jobs: `connector.ts`, `core-bugs.test.ts` (new), `lock.ts`, `lock.test.ts`, `manager.ts`, `manager-review.test.ts`, `question-claim.ts`, `question-claim.test.ts`, `stability-a.test.ts`, `usage-cache.ts`, `usage-cache.test.ts`, `worktree.ts`, `worktree.test.ts`, `worktree-review.test.ts`.
- Connectors: `codex.ts`, `codexAppServer.ts`, `codexAppServer.test.ts`.
- Bridge fixture: `src/bridge/agent-bridge.test.ts`.
- Documentation: `docs/agent-jobs.md`, `HANDOFF.md`.

**Scope:** source changes are confined to the allowed jobs/connectors files. The orchestrator explicitly authorized the additional `src/bridge/agent-bridge.test.ts` fixture edit to hold a real question mutex. No commits or pushes. Main checkout unchanged; this worktree uses the authorized `node_modules` junction.

**Next project:** extract the shared jobs, task adapters, diagnostics and bridge into one `agent-jobs` server with Codex and agy connectors.

**Reviews and research:** `Documents\Research\mcp-agent-servers\` (panel reviews in `panel-2026-11-07\`, wake-hold research in `wakehold-2026-11-07\`, job reports in `job-reports\`).
