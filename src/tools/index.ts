// Tool Registry Index - Registers all tools
import { selftestTool, debugLogTool } from './debug-tools.js';
import { toolRegistry } from './registry.js';
import { askCodexTool } from './ask-codex.tool.js';
import { batchCodexTool } from './batch-codex.tool.js';
import { reviewCodexTool } from './review-codex.tool.js';
import { pingTool, helpTool, versionTool } from './simple-tools.js';
import { brainstormTool } from './brainstorm.tool.js';
import { fetchChunkTool } from './fetch-chunk.tool.js';
import { timeoutTestTool } from './timeout-test.tool.js';
import { listSessionsTool } from './list-sessions.tool.js';
import { healthTool } from './health.tool.js';
import { listSkillsTool } from './list-skills.tool.js';
import { doActTool } from './do-act.tool.js';
import { imageGenTool } from './image-gen.tool.js';
import { codexUsageTool } from './codex-usage.tool.js';
import { CodexConnector } from '../connectors/codex.js';
import { JobManager } from '../jobs/manager.js';
import { registerJobTools } from '../jobs/tools.js';
import { Logger } from '../utils/logger.js';

export const codexJobManager = new JobManager(new CodexConnector(), undefined, Logger);
registerJobTools(toolRegistry, 'codex', codexJobManager);

/** Legacy synchronous tools, hidden unless CODEX_MCP_LEGACY_TOOLS=1. */
export const legacyTools = [
  askCodexTool,
  batchCodexTool,
  reviewCodexTool,
  pingTool,
  helpTool,
  versionTool,
  brainstormTool,
  fetchChunkTool,
  timeoutTestTool,
  listSessionsTool,
  listSkillsTool,
  doActTool,
  imageGenTool,
];

export const legacyToolsEnabled = (env: NodeJS.ProcessEnv = process.env) => env.CODEX_MCP_LEGACY_TOOLS === '1';

/** health, usage, selftest and debug log always register; the legacy set only on request. */
export function registerStandaloneTools(registry: typeof toolRegistry, env: NodeJS.ProcessEnv = process.env) {
  registry.push(...(legacyToolsEnabled(env) ? legacyTools : []), healthTool, codexUsageTool, selftestTool, debugLogTool);
}

registerStandaloneTools(toolRegistry);

export * from './registry.js';
