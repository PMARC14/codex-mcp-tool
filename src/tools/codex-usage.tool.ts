import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import type { CodexUsage } from '../utils/codexUsage.js';
import { CodexConnector } from '../connectors/codex.js';

const connector = new CodexConnector();
export const createCodexUsageTool = (read = (): Promise<CodexUsage> => connector.usage()): UnifiedTool => ({
  name: 'codex_usage',
  description:
    'Codex plan usage: 5-hour and weekly used % with reset times, a short meter, and free reset credits. Shares a machine-wide cache (5 minutes; 15 on battery or probe failure). Refreshes through a short-lived app-server without a model turn; falls back to session logs.',
  zodSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  category: 'simple',
  execute: async () => JSON.stringify(await read(), null, 2),
});
export const codexUsageTool = createCodexUsageTool();
