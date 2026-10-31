import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { atomicWrite } from './store.js';
import { runCommand, safeSpawn, systemBinary } from './proc.js';
import type { JobLogger } from './connector.js';

export class WakeHold {
  private child?: ChildProcess;
  private generation = 0;
  constructor(
    private home: string,
    private logger: JobLogger
  ) {}

  private async modernStandby(): Promise<boolean> {
    const cache = join(this.home, 'modern-standby.json');
    try {
      const saved = JSON.parse(readFileSync(cache, 'utf8'));
      if (Date.now() - saved.time < 86400000) return saved.modern;
    } catch {
      /* Detect once a day. */
    }
    const states = await runCommand(systemBinary('powercfg.exe'), ['/a']);
    const available = states.split(/not available/i)[0];
    const modern = /S0 Low Power Idle/i.test(available) && !/Standby \(S[123]\)/i.test(available);
    atomicWrite(cache, JSON.stringify({ time: Date.now(), modern }));
    return modern;
  }

  async start(): Promise<void> {
    if (this.child) return;
    const generation = ++this.generation;
    try {
      let exe: string;
      let args: string[];
      if (process.platform === 'win32') {
        const flags = (await this.modernStandby()) ? '2147483651' : '2147483649';
        exe = systemBinary('powershell.exe');
        const script = `$ErrorActionPreference='Stop'; Add-Type -Namespace AgentJobs -Name Wake -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'; if ([AgentJobs.Wake]::SetThreadExecutionState([uint32]${flags}) -eq 0) { throw 'SetThreadExecutionState failed' }; while ([Console]::In.Read() -ne -1) { }; [void][AgentJobs.Wake]::SetThreadExecutionState([uint32]2147483648)`;
        args = ['-NoProfile', '-NonInteractive', '-Command', script];
      } else {
        exe = 'systemd-inhibit';
        args = [
          '--what=sleep:idle',
          '--who=agent-jobs',
          '--why=Agent jobs running',
          '--mode=block',
          process.execPath,
          '-e',
          'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
        ];
      }
      if (generation !== this.generation) return;
      const child = safeSpawn(exe, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      this.child = child;
      child.stdin?.on('error', () => {});
      let stderr = '';
      child.stderr?.on('data', data => {
        stderr = (stderr + data).slice(-2000);
      });
      child.on('error', error => this.logger.warn('Wake hold unavailable', error));
      child.on('close', code => {
        if (this.child === child) this.child = undefined;
        if (code) this.logger.warn(`Wake hold exited ${code}: ${stderr}`);
      });
    } catch (error) {
      this.logger.warn('Wake hold unavailable', error);
    }
  }

  stop(): void {
    this.generation++;
    this.child?.stdin?.end();
    this.child = undefined;
  }
}
