import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { readCodexUsage } from '../utils/codexUsage.js';

export const codexUsageTool: UnifiedTool = {
  name: 'codex_usage',
  description:
    'Codex plan usage from the newest rate_limits snapshot in local session logs: 5-hour and weekly used % with reset times, snapshot age and a short meter. No network, no CLI run; the snapshot is as fresh as the last Codex session.',
  zodSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  category: 'simple',
  execute: async () => JSON.stringify(readCodexUsage(), null, 2),
};
