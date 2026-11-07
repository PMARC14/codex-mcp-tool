import { appendFileSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { atomicWrite } from '../jobs/store.js';
import { claimQuestion, releaseQuestion } from '../jobs/question-claim.js';

const askSchema = z.object({ question: z.string().trim().min(1).max(20000),
  options: z.array(z.string().max(500)).max(50).optional(),
  timeoutSec: z.number().positive().max(86400).default(1800) });
const noteSchema = z.object({ note: z.string().trim().min(1).max(20000) });

export function createBridge(home: string, jobId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(jobId)) throw new Error('AGENT_JOB_ID is invalid');
  const dir = join(resolve(home), 'jobs', jobId);
  if (!statSync(dir).isDirectory()) throw new Error('AGENT_JOB_ID directory is missing');
  const server = new Server({ name: 'agent-bridge', version: '1' }, { capabilities: { tools: {} } });
  let asking = false;
  const questionPath = join(dir, 'question.json');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'ask_orchestrator', description: 'Ask the orchestrator a question and wait for its answer. It may be shown to the user.',
      inputSchema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, timeoutSec: { type: 'number', default: 1800, maximum: 86400 } }, required: ['question'] },
      annotations: { destructiveHint: false, openWorldHint: false } },
    { name: 'report_progress', description: 'Send the orchestrator a milestone note and return immediately.',
      inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
      annotations: { destructiveHint: false, openWorldHint: false } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === 'report_progress') {
      const { note } = noteSchema.parse(request.params.arguments);
      appendFileSync(join(dir, 'notes.ndjson'), JSON.stringify({ ts: Date.now(), note }) + '\n');
      return { content: [{ type: 'text', text: 'Progress reported.' }] };
    }
    if (request.params.name !== 'ask_orchestrator') throw new McpError(ErrorCode.MethodNotFound, 'Unknown bridge tool');
    const { question, options, timeoutSec } = askSchema.parse(request.params.arguments);
    if (asking) throw new McpError(ErrorCode.InvalidRequest, 'A question is already awaiting an answer');
    const id = randomUUID();
    if (!claimQuestion(dir, { owner: 'bridge', id, ts: Date.now(), timeoutMs: timeoutSec * 1000 }))
      throw new McpError(ErrorCode.InvalidRequest, 'Another question is already awaiting an answer');
    asking = true;
    const answerPath = join(dir, `answer-${id}.json`);
    try {
      atomicWrite(questionPath, JSON.stringify({ id, question, options, askedAt: Date.now() }));
      const text = await new Promise<string>((resolveAnswer, reject) => {
        let timer: NodeJS.Timeout;
        let deadline: NodeJS.Timeout;
        const cleanup = () => { clearInterval(timer); clearTimeout(deadline); extra.signal.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); reject(new McpError(ErrorCode.InvalidRequest, 'Bridge question cancelled')); };
        const check = () => {
          try {
            // stat only on each tick; read the answer once it exists.
            if (!statSync(answerPath).isFile()) return;
            const answer = JSON.parse(readFileSync(answerPath, 'utf8'));
            if (typeof answer.answer !== 'string') throw new Error('answer field must be a string');
            cleanup(); resolveAnswer(answer.answer);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            cleanup(); reject(error);
          }
        };
        timer = setInterval(check, 2000);
        deadline = setTimeout(() => { cleanup(); resolveAnswer(`no answer within ${timeoutSec} s; continue with your best judgement`); }, timeoutSec * 1000);
        extra.signal.addEventListener('abort', abort, { once: true });
        if (extra.signal.aborted) abort(); else check();
      });
      return { content: [{ type: 'text', text }] };
    } finally {
      asking = false;
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            if (JSON.parse(readFileSync(questionPath, 'utf8')).id === id) unlinkSync(questionPath);
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') break;
            if (!['EBUSY', 'EPERM'].includes(code ?? '') || attempt === 4) throw error;
            await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
          }
        }
      } catch (error) { process.stderr.write(`Bridge question cleanup: ${String(error)}\n`); }
      finally { releaseQuestion(dir, id); }
    }
  });
  return server;
}

async function main() {
  const { AGENT_JOBS_HOME: home, AGENT_JOB_ID: id } = process.env;
  if (!home || !id) throw new Error('AGENT_JOBS_HOME and AGENT_JOB_ID are required');
  const server = createBridge(home, id);
  process.stdin.once('end', () => void server.close());
  process.stdin.once('close', () => void server.close());
  process.stdout.once('error', () => void server.close());
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
