# Job-facing symmetry audit

The eleven shared agent tools (`<p>_agent`, message, answer, follow, status, result, read, list, stop, retry, and collect) use the connector prefix with no old-name aliases. Message steers running agents or answers pending questions, and resumes stopped sessions with optional overrides. Task augmentation belongs only to `<p>_agent` and `<p>_agent_follow`. Registration, follow progress, request cancellation, channel setup, signal disposal and stdio disconnect handling use the shared module. Disconnect cancels the follow while running agents continue saving results; process signals dispose the manager. The Codex launch schema adds app-server transport and approval settings.

Fixed: conditional agy read-mode recovery in background and legacy execution; empty recovery answer retention; common usage window/snapshot/meter names and source provenance; shared ISO/duration/clock reset parsing and model-scoped pauses; missing agy health detection/configuration fields and structured failure output; stale read-turn, usage and tool-list documentation.

Intentional differences: tool prefixes and model catalogs; agy model-group quota and optional refresh/tallies/cache versus Codex account windows, live/session-log sources and reset credits; Codex executable resolution/minimum-version diagnostics; vendor CLI flags and authentication. Existing agy usage aliases remain for compatibility. No vendor-specific legacy tools were ported.

| Fork / tool | Difference and recommendation |
| --- | --- |
| Codex `do-act` | Verification/fix loop; keep vendor-specific, use shared jobs for orchestration. |
| Codex `image-gen` | Built-in Codex image tool; keep vendor-specific until agy has an equivalent capability. |
| Codex `fetch-chunk` | Pages the legacy response cache; use `*_agent_read` for shared saved outputs. |
| Codex `list-skills` | Discovers Codex workspace skills; retain Codex-specific discovery. |
| Codex `timeout-test` | Diagnostic keepalive exercise; keep local, use fake watch tests for parity. |
| agy `bg-antigravity` | Separate detached task store/lifecycle with buffered two-turn read input; prefer shared jobs for conditional recovery. |
| agy `delegate-antigravity` | Separate worktree delegation lifecycle; prefer agent(worktree:true) and agent_collect. |
| agy `digest-antigravity` | File ingestion helper; retain as a vendor convenience. |
| agy `plan-antigravity` | Structured planning helper; retain as a vendor convenience using read mode. |
| agy `metrics` | Local invocation telemetry; keep separate from account quota usage. |
| agy `list-models` | Live labels and IDs; retain vendor convenience, use health model IDs for common discovery. |

Validation uses `node --test` through each repository's `npm test`, with fake processes and temporary stores only. Shared source is edited in Codex and copied with `bash scripts/sync-jobs.sh`; the sync test checks byte identity. No real vendor CLIs are run. No dependency, package, committed build-output or legacy tool ports are needed.

Deviation: legacy detached bg/delegate read mode retains its pre-existing buffered recovery input. It bypasses the requested shared-job and synchronous execution paths and sends stdout directly to files; this compatibility adjustment prevents the builder change from removing its recovery. No legacy tool was ported.

## Acceptance results

After running the sync script from Codex, `bash -c "npm test"` passed: Codex **98/98**, agy **158/158**; zero failures, cancellations or skips. The sync test ran in both suites. No real codex/agy CLI, dependency changes, manual dist edits, commits or pushes.

## Files changed in codex-mcp-tool

- `README.md`
- `docs/agent-jobs.md`
- `src/connectors/codex.test.ts`
- `src/connectors/codex.ts`
- `src/jobs/connector.ts`
- `src/jobs/manager.ts`
- `src/jobs/proc.ts`
- `src/jobs/usage-reset.ts`
- `src/tools/health.tool.ts`
- `src/utils/codexUsage.ts`
- `docs/job-surface-audit.md`
- `src/jobs/stdin.test.ts`
- `src/jobs/stdin.ts`
- `src/jobs/usage-reset.test.ts`
- `src/jobs/usage.ts`
