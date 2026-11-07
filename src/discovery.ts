// Finds listening TCP ports and the processes behind them, and stops processes.

import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import {
  Listener,
  ProcessInfo,
  parseCwd,
  parseLsof,
  parseNetstat,
  parsePs,
  parseSs,
  parseWindowsProcesses,
} from './parse';

export interface PortProcess extends Listener {
  commandLine: string;
  groupId?: number;
  uptimeSeconds?: number;
  cwd?: string;
}

interface RunResult {
  stdout: string;
  missing: boolean;
}

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      // lsof exits with 1 when nothing matches, so a non-zero exit with output is still usable.
      const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
      resolve({ stdout: stdout ?? '', missing });
    });
  });
}

async function unixListeners(): Promise<Listener[]> {
  const lsof = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  if (!lsof.missing) {
    return parseLsof(lsof.stdout);
  }
  if (process.platform === 'linux') {
    const ss = await run('ss', ['-ltnpH']);
    if (!ss.missing) {
      return parseSs(ss.stdout);
    }
  }
  throw new Error('Portside needs `lsof` (or `ss` on Linux) to list ports.');
}

async function unixProcesses(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const ps = await run('ps', ['-o', 'pid=,pgid=,etime=,command=', '-p', pids.join(',')]);
  return new Map(parsePs(ps.stdout).map((info) => [info.pid, info]));
}

async function unixWorkingDirectories(pids: number[]): Promise<Map<number, string>> {
  const lsof = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]);
  if (!lsof.missing) {
    return parseCwd(lsof.stdout);
  }
  const result = new Map<number, string>();
  if (process.platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          result.set(pid, await readlink(`/proc/${pid}/cwd`));
        } catch {
          // Processes owned by other users can't be read without root; leave them without a folder.
        }
      }),
    );
  }
  return result;
}

async function windowsProcesses(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
  const script =
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    `Select-Object ProcessId,Name,CommandLine,@{n='Age';e={[int]((Get-Date)-$_.CreationDate).TotalSeconds}} | ` +
    'ConvertTo-Json -Compress';
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  try {
    return new Map(parseWindowsProcesses(result.stdout).map((info) => [info.pid, info]));
  } catch {
    return new Map();
  }
}

/** Every process listening on a TCP port that this user can see, with its command line and folder. */
export async function listPortProcesses(): Promise<PortProcess[]> {
  const isWindows = process.platform === 'win32';
  const listeners = isWindows ? parseNetstat((await run('netstat', ['-ano', '-p', 'TCP'])).stdout) : await unixListeners();
  const pids = [...new Set(listeners.map((listener) => listener.pid))];
  if (pids.length === 0) {
    return [];
  }
  const [processes, directories] = await Promise.all([
    isWindows ? windowsProcesses(pids) : unixProcesses(pids),
    isWindows ? Promise.resolve(new Map<number, string>()) : unixWorkingDirectories(pids),
  ]);
  return listeners
    .map((listener) => {
      const info = processes.get(listener.pid);
      const cwd = directories.get(listener.pid);
      return {
        ...listener,
        name: listener.name || info?.name || '',
        commandLine: info?.commandLine ?? listener.name,
        groupId: info?.groupId,
        uptimeSeconds: info?.uptimeSeconds,
        cwd: cwd && cwd !== '/' ? cwd : undefined,
      };
    })
    .sort((a, b) => a.port - b.port);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !isAlive(pid);
}

const SHELLS = /^-?(?:bash|zsh|fish|sh|dash|ksh|tcsh|csh|nu|pwsh|login|tmux|screen|launchd|systemd|init|sshd|code|electron)$/i;

/**
 * Decides whether stopping the process group is safe. A dev server started as `npm run dev`
 * runs as a group (npm → node → server); stopping only the listener can leave npm restarting
 * it. The group is used only when its leader isn't a shell, terminal or VS Code itself.
 */
async function stoppableGroup(server: PortProcess): Promise<number | undefined> {
  const groupId = server.groupId;
  if (!groupId || groupId <= 1 || process.platform === 'win32') {
    return undefined;
  }
  const ownGroup = parsePs((await run('ps', ['-o', 'pid=,pgid=,etime=,command=', '-p', String(process.pid)])).stdout)[0]?.groupId;
  if (groupId === ownGroup) {
    return undefined;
  }
  const leader = parsePs((await run('ps', ['-o', 'pid=,pgid=,etime=,command=', '-p', String(groupId)])).stdout)[0];
  if (!leader) {
    return undefined;
  }
  const leaderName = leader.commandLine.trim().split(/\s+/)[0]?.split(/[/\\]/).pop() ?? '';
  return SHELLS.test(leaderName) ? undefined : groupId;
}

export type StopResult = 'stopped' | 'still-running' | 'not-permitted';

/** Asks the server to shut down (SIGTERM), or kills it immediately when `force` is set. */
export async function stopProcess(server: PortProcess, force: boolean): Promise<StopResult> {
  if (process.platform === 'win32') {
    const args = ['/PID', String(server.pid), '/T', '/F'];
    await run('taskkill', args);
    return (await waitForExit(server.pid, 3000)) ? 'stopped' : 'still-running';
  }
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  const groupId = await stoppableGroup(server);
  try {
    if (groupId) {
      process.kill(-groupId, signal);
    } else {
      process.kill(server.pid, signal);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return 'stopped';
    }
    if (code === 'EPERM') {
      return 'not-permitted';
    }
    throw error;
  }
  return (await waitForExit(server.pid, force ? 1500 : 3000)) ? 'stopped' : 'still-running';
}
