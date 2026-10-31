#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  SetLevelRequestSchema,
  CompleteRequestSchema,
  CallToolRequest,
  ListToolsRequest,
  ListPromptsRequest,
  GetPromptRequest,
  SetLevelRequest,
  CompleteRequest,
  Tool,
  Prompt,
  GetPromptResult,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger } from './utils/logger.js';
import { PROTOCOL, ToolArguments } from './constants.js';

import {
  getToolDefinitions,
  getPromptDefinitions,
  executeTool,
  toolExists,
  getPromptMessage,
  codexJobManager,
} from './tools/index.js';
import { getCompletionValues } from './utils/completions.js';
import { ProgressReporter } from './utils/progress.js';

const server = new Server(
  {
    name: 'codex-cli-mcp',
    version: '2.6.0',
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      logging: {},
      completions: {},
    },
  }
);

// Removed global state - using per-request state instead

function startProgressUpdates(operationName: string, progressToken?: string | number) {
  // Per-request state
  const state = {
    isProcessing: true,
    currentOperationName: operationName,
    latestOutput: '',
  };

  const progressMessages = [
    `🧠 ${operationName} - Codex is analyzing your request...`,
    `📊 ${operationName} - Processing files and generating insights...`,
    `✨ ${operationName} - Creating structured response for your review...`,
    `⏱️ ${operationName} - Large analysis in progress (this is normal for big requests)...`,
    `🔍 ${operationName} - Still working... hang tight for quality results...`,
  ];

  const reporter = new ProgressReporter(progressToken, async params => {
    try {
      await server.notification({ method: PROTOCOL.NOTIFICATIONS.PROGRESS, params });
    } catch (error) {
      Logger.error('Failed to send progress notification:', error);
    }
  });
  let messageIndex = 0;

  void reporter.send(`Starting ${operationName}`);

  // Keep client alive with periodic updates
  const progressInterval = setInterval(async () => {
    if (state.isProcessing && progressToken !== undefined) {
      // Include latest output if available
      const baseMessage = progressMessages[messageIndex % progressMessages.length];
      const outputPreview = state.latestOutput.slice(-150).trim(); // Last 150 chars
      const message = outputPreview
        ? `${baseMessage}\n📝 Output: ...${outputPreview}`
        : baseMessage;

      await reporter.send(message);
      messageIndex++;
    } else if (!state.isProcessing) {
      clearInterval(progressInterval);
    }
  }, PROTOCOL.KEEPALIVE_INTERVAL); // Every 25 seconds

  return { interval: progressInterval, progressToken, state, reporter };
}

function stopProgressUpdates(
  progressData: {
    interval: NodeJS.Timeout;
    reporter: ProgressReporter;
    progressToken?: string | number;
    state?: any;
  },
  success: boolean = true
) {
  const operationName = progressData.state?.currentOperationName || ''; // Get from state
  if (progressData.state) {
    progressData.state.isProcessing = false;
  }
  clearInterval(progressData.interval);

  void progressData.reporter.send(
    success ? `${operationName} completed successfully` : `${operationName} failed`
  );
}
// logging/setLevel
server.setRequestHandler(
  SetLevelRequestSchema,
  async (request: SetLevelRequest): Promise<Record<string, never>> => {
    Logger.setLevel(request.params.level);
    Logger.debug(`Log level updated to '${request.params.level}' via client request.`);
    return {};
  }
);

// tools/list
server.setRequestHandler(
  ListToolsRequestSchema,
  async (_request: ListToolsRequest): Promise<{ tools: Tool[] }> => {
    return { tools: getToolDefinitions() as unknown as Tool[] };
  }
);

// tools/get
server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest): Promise<CallToolResult> => {
    const toolName: string = request.params.name;

    if (toolExists(toolName)) {
      // Check if client requested progress updates
      const progressToken = (request.params as any)._meta?.progressToken;

      // Start progress updates if client requested them
      const progressData = startProgressUpdates(toolName, progressToken);

      try {
        // Get prompt and other parameters from arguments with proper typing
        const args: ToolArguments = (request.params.arguments as ToolArguments) || {};

        Logger.toolInvocation(toolName, request.params.arguments);

        // Execute the tool using the unified registry with progress callback
        const result = await executeTool(toolName, args, newOutput => {
          if (progressData.state) {
            progressData.state.latestOutput = newOutput;
          }
        });

        // Stop progress updates
        stopProgressUpdates(progressData, true);

        if (typeof result === 'string') {
          return {
            content: [
              {
                type: 'text',
                text: result,
              },
            ],
            isError: false,
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: result.text,
              },
            ],
            structuredContent: result.structuredContent,
            isError: false,
          } as CallToolResult;
        }
      } catch (error) {
        // Stop progress updates on error
        stopProgressUpdates(progressData, false);

        Logger.error(`Error in tool '${toolName}':`, error);

        const errorMessage = error instanceof Error ? error.message : String(error);

        return {
          content: [
            {
              type: 'text',
              text: `Error executing ${toolName}: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    } else {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
  }
);

// prompts/list
server.setRequestHandler(
  ListPromptsRequestSchema,
  async (
    _request: ListPromptsRequest
  ): Promise<{
    prompts: Prompt[];
  }> => {
    return { prompts: getPromptDefinitions() as unknown as Prompt[] };
  }
);

// prompts/get
server.setRequestHandler(
  GetPromptRequestSchema,
  async (request: GetPromptRequest): Promise<GetPromptResult> => {
    const promptName = request.params.name;
    const args = request.params.arguments || {};

    const promptMessage = getPromptMessage(promptName, args);

    if (!promptMessage) {
      throw new Error(`Unknown prompt: ${promptName}`);
    }

    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: promptMessage,
          },
        },
      ],
    };
  }
);

// completion/complete
server.setRequestHandler(CompleteRequestSchema, async (request: CompleteRequest) => {
  const { argument } = request.params;
  const completion = getCompletionValues(argument.name, argument.value);
  return { completion };
});

// Start the server
async function main() {
  Logger.debug('init codex-mcp-tool');
  await codexJobManager.initialize();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  server.onclose = () => {
    void codexJobManager.dispose();
  };
  Logger.debug('codex-mcp-tool listening on stdio');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void codexJobManager.dispose().finally(() => process.exit(0));
  });
}

main().catch(error => {
  Logger.error('Fatal error:', error);
  process.exit(1);
});
