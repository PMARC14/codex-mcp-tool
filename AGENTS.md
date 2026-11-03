# Repository Guidelines

## Project Structure

- `src/index.ts` — MCP server entry (stdio transport, tool dispatch, 25s keepalive)
- `src/constants.ts` — CLI flags, models, sandbox modes, `ToolArguments` interface
- `src/tools/` — MCP tools (`*.tool.ts`), registered via `toolRegistry.push()` in `index.ts`
- `src/utils/` — CLI execution, version detection, session storage, output parsing
- `src/jobs/` - shared jobs module; this fork is the source of truth, synced to the agy fork with `scripts/sync-jobs.sh`
- `dist/` — compiled output (`tsc`)
- `docs/` — VitePress documentation site

## Build & Development

| Command            | Description                   |
| ------------------ | ----------------------------- |
| `npm run build`    | Compile TypeScript to `dist/` |
| `npm run lint`     | Type-check (`tsc --noEmit`)   |
| `npm test`         | Build and run the node --test suite |
| `npm run dev`      | Build + run once              |
| `npm start`        | Run compiled server           |
| `npm run docs:dev` | VitePress dev server          |

Requirements: Node `>=18`, `codex` CLI installed and authenticated.

## Coding Style

- TypeScript ESM — use `.js` extensions in imports
- 2-space indent, single quotes, kebab-case filenames
- Tools: `*.tool.ts` — export `UnifiedTool` with zod schema
- Use `cross-spawn` (not native `spawn`) for Windows compatibility

## Architecture Notes

### Request Flow

1. MCP client → `index.ts` dispatches to tool
2. Tool validates args (zod) → passes to executor
3. `CodexCommandBuilder.build()` constructs CLI args
4. `executeCodex()` spawns `codex exec ...` via `cross-spawn`
5. Output parsed → formatted → returned as MCP response

### CodexCommandBuilder Gotchas

- `--oss` / `--local-provider` must come **after** `exec` subcommand
- `exec resume` doesn't support `--oss`; use `-c model_provider=<provider>` instead
- OSS mode: model name passed as-is (skip OpenAI model validation)
- `search`, `oss`, `localProvider` auto-set `--sandbox workspace-write`

### Tools

`ask-codex`, `batch-codex`, `review-changes`, `do-act`, `image-gen`, `brainstorm`, `fetch-chunk`, `list-sessions`, `list-skills`, `health`, `ping`, `help`, `version`, `timeout-test`, `codex_usage`, and the eight job and worktree tools described in `docs/agent-jobs.md`

### Windows

- Job processes use `windowsHide`, resolve `.cmd` shims to JavaScript, and avoid `cmd.exe`; process-tree cleanup uses `taskkill /T` and a descendant sweep.
- CLI sandboxes can break Git Bash/MSYS2; use `trusted` mode for worktree jobs on the user's own repositories when needed.

## Adding a New Tool

1. Create `src/tools/your-tool.tool.ts`
2. Define zod schema, export `UnifiedTool` object
3. Register in `src/tools/index.ts`: `toolRegistry.push(yourTool)`

## Commit Style

Concise, imperative: `feat: add brainstorm tool`, `fix(utils): handle quota errors`

Keep changes scoped; update `README.md` and `docs/` when behavior changes.

## Testing

`npm test` builds and runs the `node --test` suite. Place new tests alongside sources; the jobs sync test checks the sibling copy when available.
