import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { readCodexUsage, readLiveCodexUsage } from '../utils/codexUsage.js';

export const codexUsageTool: UnifiedTool = {
  name: 'codex_usage',
  description:
    'Codex plan usage: 5-hour and weekly used % with reset times, a short meter, and free reset credits. Asks a short-lived codex app-server live (no model turn, no quota spent); falls back to the newest session-log snapshot, marked source: session-log.',
  zodSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  category: 'simple',
  execute: async () => JSON.stringify((await readLiveCodexUsage()) ?? readCodexUsage(), null, 2),
};
