import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

function bounded(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  return Buffer.from(value).subarray(0, bytes - 4).toString('utf8') + '…';
}

/** Replaces the user's home directory (and any other Users\name profile path) so logs carry no account names. */
export function redactPaths(text: string): string {
  const home = homedir();
  let result = text;
  const slash = String.fromCharCode(92);
  for (const variant of new Set([home, home.split(slash).join('/'), home.split(slash).join(slash + slash)]))
    if (variant) result = result.split(variant).join('~');
  return result
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, '~')
    .replace(/\/(?:home|Users)\/[^/\s"']+/g, '~');
}

/**
 * A log-safe description of an error: no argument values (Zod messages quote them), home paths
 * redacted, a short single-line message and a stack of at most 2 KB.
 */
export function describeError(error: unknown): { error: string; stack?: string } {
  let message: string;
  const issues = (error as { issues?: Array<{ path?: unknown[]; code?: string }> } | undefined)?.issues;
  if (Array.isArray(issues)) message = `validation failed: ${issues.slice(0, 10).map(issue => `${(issue.path ?? []).join('.')}:${issue.code}`).join(', ')}`;
  else {
    message = error instanceof Error ? error.message : String(error);
    message = message.replace(/^(.*?Invalid arguments for [\w-]+):[\s\S]*$/, '$1');
  }
  message = redactPaths(message).replace(/\s+/g, ' ').slice(0, 500);
  // The first stack line repeats the message, which may quote argument values: keep frames only.
  const frames = error instanceof Error && error.stack ? error.stack.slice(Math.max(0, error.stack.search(/\n\s+at /))) : undefined;
  const stack = frames ? bounded(`${error instanceof Error ? error.name : 'Error'}${redactPaths(frames)}`, 2048) : undefined;
  return { error: message, stack };
}

/** Never serialize worker content into the traffic log, even at full level. */
function safeSummary(message: any, full: boolean) {
  const params = message.params;
  const result = message.result;
  const summary: Record<string, unknown> = {};
  if (params?.name) summary.tool = params.name;
  if (params?.arguments) {
    // One 200-character budget for the entire argument preview, with sensitive
    // values removed before serialization (including nested argument objects).
    const safeKeys = new Set(['jobId', 'qid', 'cwd', 'mode', 'model', 'effort', 'label', 'transport', 'name', 'limit', 'offset', 'timeoutMin', 'worktree', 'remove', 'decision']);
    const redact = (key: string, value: unknown) =>
      typeof value === 'string' ? (safeKeys.has(key) ? value.slice(0, 200) : `[redacted ${value.length} chars]`) : value;
    summary.arguments = JSON.stringify(params.arguments, redact).slice(0, 200);
  }
  const body = result ?? params;
  if (body && typeof body === 'object') {
    summary.fields = Object.keys(body).slice(0, full ? 100 : 30);
    for (const key of ['taskId', 'status', 'resultType', 'isError'])
      if (body[key] !== undefined) summary[key] = body[key];
    if (Array.isArray(body.content)) summary.contentBlocks = body.content.length;
    if (Array.isArray(body.tasks)) summary.tasks = body.tasks.map((task: any) => ({ taskId: task.taskId, status: task.status }));
    if (Array.isArray(body.tools)) summary.tools = body.tools.map((tool: any) => tool.name);
  }
  if (message.error) summary.error = { code: message.error.code, message: redactPaths(String(message.error.message ?? '').replace(/\s+/g, ' ').slice(0, 300)) };
  return summary;
}

export class TrafficLog {
  readonly path: string;
  constructor(connector: string, home = process.env.AGENT_JOBS_HOME || join(homedir(), '.agent-jobs'),
    private readonly maxBytes = 5 * 1024 * 1024, private readonly full = process.env.AGENT_JOBS_DEBUG === 'full') {
    this.path = join(home, 'logs', `${connector}-${process.pid}.ndjson`);
  }
  private append(entry: object) {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true });
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
      if (existsSync(this.path) && statSync(this.path).size + Buffer.byteLength(line) > this.maxBytes) {
        if (existsSync(this.path + '.2')) unlinkSync(this.path + '.2');
        if (existsSync(this.path + '.1')) renameSync(this.path + '.1', this.path + '.2');
        renameSync(this.path, this.path + '.1');
      }
      appendFileSync(this.path, line);
    } catch (error) {
      // Logging must never break a worker or corrupt the JSON-RPC stdout stream.
      process.stderr.write(`Traffic log write failed: ${(error as Error).message}\n`);
    }
  }
  message(dir: 'in' | 'out', message: any) {
    this.append({ dir, method: message.method, id: message.id,
      size: Buffer.byteLength(JSON.stringify(message)),
      summary: bounded(JSON.stringify(safeSummary(message, this.full)), this.full ? 16384 : 2048) });
  }
  error(step: string, error: unknown) {
    this.append({ dir: 'out', method: step, size: 0,
      summary: bounded(JSON.stringify(describeError(error)), this.full ? 16384 : 4096) });
  }
  tail(lines: number) {
    // Read at most the three bounded files, oldest first. No worker files are read.
    return ['.2', '.1', ''].filter(suffix => existsSync(this.path + suffix))
      .flatMap(suffix => readFileSync(this.path + suffix, 'utf8').trimEnd().split('\n'))
      .slice(-lines);
  }
}

export const trafficLog = new TrafficLog('codex');

/** Cover all application request handlers, including task and discovery handlers. */
export function installRequestErrorReporting(server: Server, log = trafficLog) {
  const set = server.setRequestHandler.bind(server);
  server.setRequestHandler = ((schema: any, handler: any) => set(schema, async (request: any, extra: any) => {
    try { return await handler(request, extra); }
    catch (error) {
      log.error(request.method, error);
      const code = error instanceof McpError ? error.code : ErrorCode.InternalError;
      const detail = error instanceof Error ? error.message : String(error);
      throw new McpError(code, `${request.method} handler: ${detail}`, { step: request.method });
    }
  })) as Server['setRequestHandler'];
}
