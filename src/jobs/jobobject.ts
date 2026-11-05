import spawn from 'cross-spawn';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The child is assigned before it can create any descendants. The job handle is deliberately
// non-inheritable, so terminating this wrapper closes the last handle and kills the entire job.
export const JOB_WRAPPER_SOURCE = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
class JobWrap {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long processTime, jobTime; public uint flags; public UIntPtr min, max;
    public uint active; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xCount,yCount,fill,flags;
    public short show, reserved2; public IntPtr reservedPtr, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public int pid, tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  static string Quote(string s) {
    var b = new StringBuilder("\""); int slashes = 0;
    foreach (char c in s) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append(c); }
      else { b.Append('\\', slashes); b.Append(c); }
      slashes = 0;
    }
    b.Append('\\', slashes * 2); return b.Append('"').ToString();
  }
  static int Main(string[] args) {
    if (args.Length == 0) return 127;
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return 127;
    var limits = new EXTENDED_LIMIT(); limits.basic.flags = 0x2000;
    int size = Marshal.SizeOf(limits); IntPtr ptr = Marshal.AllocHGlobal(size);
    Marshal.StructureToPtr(limits, ptr, false);
    bool configured = SetInformationJobObject(job, 9, ptr, (uint)size); Marshal.FreeHGlobal(ptr);
    if (!configured) { CloseHandle(job); return 127; }
    var command = new StringBuilder(); foreach (string arg in args) { if (command.Length != 0) command.Append(' '); command.Append(Quote(arg)); }
    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.flags = 0x100;
    si.stdin = GetStdHandle(-10); si.stdout = GetStdHandle(-11); si.stderr = GetStdHandle(-12);
    PROCESS_INFORMATION pi;
    if (!CreateProcess(args[0], command, IntPtr.Zero, IntPtr.Zero, true, 4, IntPtr.Zero, null, ref si, out pi)) { CloseHandle(job); return 127; }
    if (!AssignProcessToJobObject(job, pi.process)) {
      // Preserve job execution on systems that forbid nested jobs, without claiming containment.
      Console.Error.WriteLine("agent-jobs: Job Object assignment failed; using process-tree cleanup");
    }
    if (ResumeThread(pi.thread) == 0xffffffff) { TerminateProcess(pi.process, 127); CloseHandle(pi.thread); CloseHandle(pi.process); CloseHandle(job); return 127; }
    CloseHandle(pi.thread); WaitForSingleObject(pi.process, 0xffffffff);
    uint code; if (!GetExitCodeProcess(pi.process, out code)) code = 127;
    CloseHandle(pi.process); CloseHandle(job); return unchecked((int)code);
  }
}
`;

let cached: string | null | undefined;
let warned = false;

/** The optional arguments make compiler failure testable without changing the machine. */
export function jobWrapper(options: { compiler?: string; cacheDir?: string; warn?: (message: string) => void } = {}): string | undefined {
  if (process.platform !== 'win32' || process.env.AGENT_JOBS_NO_JOBOBJECT === '1') return undefined;
  const custom = options.compiler !== undefined || options.cacheDir !== undefined;
  if (!custom && cached !== undefined && (cached === null || existsSync(cached))) return cached ?? undefined;
  const hash = createHash('sha256').update(JOB_WRAPPER_SOURCE).digest('hex').slice(0, 8);
  const dir = options.cacheDir ?? join(homedir(), '.agent-jobs', 'bin');
  const target = join(dir, `jobwrap-${hash}.exe`);
  let result: string | undefined;
  let source: string | undefined;
  let output: string | undefined;
  try {
    if (!existsSync(target)) {
      const compiler = options.compiler ?? join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      mkdirSync(dir, { recursive: true });
      const temporary = join(dir, `jobwrap-${hash}-${process.pid}-${randomBytes(8).toString('hex')}`);
      source = `${temporary}.cs`;
      output = `${temporary}.exe`;
      writeFileSync(source, JOB_WRAPPER_SOURCE);
      const compilation = spawn.sync(compiler, ['/nologo', '/target:exe', `/out:${output}`, source], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
      if (compilation.error || compilation.status !== 0) throw new Error(compilation.error?.message || compilation.stderr || compilation.stdout || 'compiler failed');
      try { renameSync(output, target); } catch (error) { if (!existsSync(target)) throw error; }
    }
    result = target;
  } catch (error) {
    if (!warned || options.warn) (options.warn ?? console.warn)(`agent-jobs: Job Object launcher unavailable; using process-tree cleanup: ${String(error)}`);
    warned = true;
  } finally {
    try { if (source) rmSync(source, { force: true }); } catch { /* Best effort. */ }
    try { if (output) rmSync(output, { force: true }); } catch { /* Best effort. */ }
  }
  if (!custom) cached = result ?? null;
  return result;
}
