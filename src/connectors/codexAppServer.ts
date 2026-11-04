import type { JobEvent, JobSpec } from '../jobs/connector.js';
import type { ApprovalDecision, StdinHandler, StdinPlan } from '../jobs/stdin.js';
import { usageLimit } from '../jobs/usage-reset.js';

const wire = (message: object) => JSON.stringify(message) + '\n';
const input = (text: string) => [{ type: 'text', text, text_elements: [] }];
const errorEvent = (message: string, code?: string): JobEvent => ({
  error: message,
  usageLimit: /usage limit/i.test(message) || code === 'usageLimitExceeded' || code === 'rateLimitExceeded' ? usageLimit(message) : undefined,
});

/** Protocol discovered with codex-cli 0.166.0 generate-json-schema / generate-ts. */
export function buildAppServer(job: JobSpec, exe: string) {
  const stdinPlan: StdinPlan = context => {
    let sequence = 1;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let completed = false;
    let disposed = false;
    let stopping = false;
    let controls = 0;
    let closeSoon: NodeJS.Immediate | undefined;
    const requests = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    const approvals = new Map<string | number, { kind: string; params: any; requestedAt: number; timer: NodeJS.Timeout }>();
    const initializeTimer = setTimeout(() => {
      context.emit(errorEvent('app-server initialize response timed out'));
      context.apply({ close: true });
    }, 30000);
    const request = (method: string, params: object): Promise<any> => {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          requests.delete(id);
          reject(new Error(`app-server ${method} response timed out`));
        }, 30000);
        requests.set(id, { resolve, reject, timer });
        context.apply({ write: wire({ id, method, params }) });
      });
    };
    const publishApproval = () => {
      const first = approvals.entries().next().value;
      context.emit({ pendingApproval: first ? {
        id: first[0], kind: first[1].kind,
        summary: String(first[1].params.command ?? first[1].params.reason ?? first[1].kind).slice(0, 300),
        requestedAt: first[1].requestedAt,
      } : null });
    };
    const answer = (id: string | number, decision: ApprovalDecision) => {
      const approval = approvals.get(id);
      if (!approval) throw new Error('No pending approval for this job');
      clearTimeout(approval.timer);
      approvals.delete(id);
      let result: object = { decision };
      if (approval.kind === 'permissions') {
        const permissions = Object.fromEntries(Object.entries(approval.params.permissions ?? {}).filter(([, value]) => value != null));
        result = { permissions: decision === 'accept' || decision === 'acceptForSession' ? permissions : {},
          scope: decision === 'acceptForSession' ? 'session' : 'turn' };
      }
      // Apply before publishing the cleared metadata, so synchronous listeners cannot race the reply.
      context.apply({ write: wire({ id, result }) });
      publishApproval();
      if (approval.kind === 'permissions' && decision === 'cancel') {
        if (threadId && turnId) context.apply({ write: wire({ id: ++sequence, method: 'turn/interrupt', params: { threadId, turnId } }) });
      }
    };
    const finish = () => {
      if (!completed || controls || disposed) return;
      clearImmediate(closeSoon);
      closeSoon = setImmediate(() => {
        if (completed && !controls && !disposed) context.apply({ close: true });
      });
    };
    const startTurn = async (text: string) => {
      completed = false;
      clearImmediate(closeSoon);
      const result = await request('turn/start', { threadId, input: input(text), effort: job.effort });
      if (!completed) turnId = result.turn.id;
    };
    const settings = {
      cwd: job.cwd, model: job.model,
      sandbox: { read: 'read-only', write: 'workspace-write', trusted: 'danger-full-access', full: 'danger-full-access' }[job.mode],
      approvalPolicy: job.mode === 'trusted' || job.mode === 'full' ? 'never' : 'on-request',
      config: {
        ...(job.effort ? { model_reasoning_effort: job.effort } : {}),
        ...(job.worktree && job.mode === 'write' ? { 'sandbox_workspace_write.writable_roots': [job.worktree.gitDir] } : {}),
      },
    };
    const startup = async () => {
      context.apply({ write: wire({ method: 'initialized' }) });
      const result = await request(job.resumeSession ? 'thread/resume' : 'thread/start', {
        ...settings, ...(job.resumeSession ? { threadId: job.resumeSession } : {}),
      });
      threadId = result.thread.id;
      context.emit({ sessionId: threadId });
      await startTurn(job.prompt);
    };
    const handler: StdinHandler = (line, stream) => {
      if (disposed || stream !== 'stdout') return;
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.id === 1 && !message.method) {
        clearTimeout(initializeTimer);
        if (message.error) { context.emit(errorEvent(String(message.error.message))); return { close: true }; }
        void startup().catch(error => {
          if (!disposed) { context.emit(errorEvent(String(error.message))); context.apply({ close: true }); }
        });
      } else if (message.id !== undefined && !message.method) {
        const pending = requests.get(message.id);
        if (pending) {
          requests.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(String(message.error.message)));
          else pending.resolve(message.result);
        }
      } else if (message.id !== undefined && message.method) {
        const kind = ({
          'item/commandExecution/requestApproval': 'commandExecution',
          'item/fileChange/requestApproval': 'fileChange',
          'item/permissions/requestApproval': 'permissions',
        } as Record<string, string>)[message.method];
        if (!kind) return { write: wire({ id: message.id, error: { code: -32601, message: 'Unsupported app-server request' } }) };
        if (approvals.has(message.id)) return;
        const timer = setTimeout(() => {
          context.emit({ approvalReason: 'approval_timeout' });
          answer(message.id, 'decline');
        }, (job.approvalTimeoutMin ?? 30) * 60000);
        approvals.set(message.id, { kind, params: message.params ?? {}, requestedAt: Date.now(), timer });
        publishApproval();
      } else if (message.method === 'turn/started') {
        turnId = message.params.turn.id;
        completed = false;
      } else if (message.method === 'serverRequest/resolved' && message.params.threadId === threadId) {
        const approval = approvals.get(message.params.requestId);
        if (approval) {
          clearTimeout(approval.timer);
          approvals.delete(message.params.requestId);
          publishApproval();
        }
      } else if (message.method === 'turn/completed' && message.params.threadId === threadId) {
        if (turnId && message.params.turn.id !== turnId) return;
        turnId = undefined;
        completed = true;
        for (const approval of approvals.values()) clearTimeout(approval.timer);
        approvals.clear();
        context.emit({ pendingApproval: null });
        finish();
      }
    };
    handler.onSteer = async text => {
      if (!threadId || stopping) throw new Error('Job has no active thread yet, or is stopping');
      controls++;
      clearImmediate(closeSoon);
      try {
        if (turnId) {
          try {
            await request('turn/steer', { threadId, expectedTurnId: turnId, input: input(text) });
            return { delivered: 'mid-turn' };
          } catch (error) {
            if (!completed && !/no active turn|turn.*(?:mismatch|not active|not found|completed)|expected.*turn/i.test(String(error))) throw error;
          }
        }
        await startTurn(text);
        return { delivered: 'queued' };
      } finally {
        controls--;
        finish();
      }
    };
    handler.onRespond = decision => {
      const id = approvals.keys().next().value;
      if (id === undefined) throw new Error('No pending approval for this job');
      answer(id, decision);
      return {};
    };
    handler.onInterrupt = () => {
      stopping = true;
      if (threadId && turnId) return { write: wire({ id: ++sequence, method: 'turn/interrupt', params: { threadId, turnId } }) };
      return { close: true };
    };
    handler.dispose = () => {
      disposed = true;
      clearTimeout(initializeTimer);
      clearImmediate(closeSoon);
      for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('app-server exited')); }
      requests.clear();
      for (const approval of approvals.values()) clearTimeout(approval.timer);
      approvals.clear();
    };
    return handler;
  };
  return { exe, args: ['app-server'], stdin: wire({ id: 1, method: 'initialize', params: {
    clientInfo: { name: 'codex-mcp-tool', title: 'Codex jobs', version: '1' }, capabilities: null,
  } }), stdinPlan };
}

export function parseAppServer(line: string, stream: 'stdout' | 'stderr'): JobEvent | null {
  if (stream !== 'stdout') return null;
  let message: any;
  try { message = JSON.parse(line); } catch { return null; }
  const params = message?.params;
  if (message?.method === 'thread/started' && typeof params?.thread?.id === 'string') return { sessionId: params.thread.id };
  if (message?.method === 'item/completed') {
    if (params?.item?.type === 'agentMessage' && typeof params.item.text === 'string') return { final: params.item.text };
    if (params?.item?.type === 'reasoning') return { reasoning: [...(params.item.summary ?? []), ...(params.item.content ?? [])].join('\n') };
  }
  if (message?.method === 'error' && !params?.willRetry) return errorEvent(String(params?.error?.message ?? 'app-server error'), params?.error?.codexErrorInfo);
  if (message?.method === 'turn/completed' && params?.turn?.error) return errorEvent(String(params.turn.error.message), params.turn.error.codexErrorInfo);
  return null;
}
