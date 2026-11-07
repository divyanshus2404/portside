// Pure parsers for the output of the system tools Portside runs. Kept free of
// `vscode` and child processes so they can be unit tested on any platform.

export interface Listener {
  pid: number;
  /** Short process name reported by the OS, e.g. `node` or `Python`. */
  name: string;
  port: number;
  /** Address the socket is bound to, e.g. `*`, `127.0.0.1` or `[::1]`. */
  address: string;
}

export interface ProcessInfo {
  pid: number;
  /** Process group, used to stop a whole `npm run dev` job (Unix only). */
  groupId?: number;
  uptimeSeconds?: number;
  commandLine: string;
  name?: string;
}

function addUnique(result: Listener[], seen: Set<string>, listener: Listener): void {
  const key = `${listener.pid}:${listener.port}`;
  if (!seen.has(key)) {
    seen.add(key);
    result.push(listener);
  }
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` (macOS and most Linux). */
export function parseLsof(output: string): Listener[] {
  const result: Listener[] = [];
  const seen = new Set<string>();
  let pid = 0;
  let name = '';
  for (const line of output.split('\n')) {
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === 'p') {
      pid = Number(value);
      name = '';
    } else if (tag === 'c') {
      name = value;
    } else if (tag === 'n' && pid) {
      const match = /^(.*):(\d+)$/.exec(value);
      if (match) {
        addUnique(result, seen, { pid, name, port: Number(match[2]), address: match[1] });
      }
    }
  }
  return result;
}

/** Parses `ss -ltnpH` (Linux without lsof). */
export function parseSs(output: string): Listener[] {
  const result: Listener[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 6) {
      continue;
    }
    const local = /^(.*):(\d+)$/.exec(columns[3]);
    const owner = /\("([^"]+)",pid=(\d+)/.exec(columns.slice(5).join(' '));
    if (local && owner) {
      addUnique(result, seen, {
        pid: Number(owner[2]),
        name: owner[1],
        port: Number(local[2]),
        address: local[1],
      });
    }
  }
  return result;
}

/**
 * Parses `netstat -ano -p TCP` (Windows). The state column is localized on non-English
 * Windows, so listening sockets are recognized by their foreign port being 0 instead.
 */
export function parseNetstat(output: string): Listener[] {
  const result: Listener[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+:0\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (match && Number(match[3]) !== 0) {
      addUnique(result, seen, {
        pid: Number(match[3]),
        name: '',
        port: Number(match[2]),
        address: match[1],
      });
    }
  }
  return result;
}

/** Converts `ps` elapsed time (`[[dd-]hh:]mm:ss`) to seconds. */
export function parseElapsed(elapsed: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(elapsed.trim());
  if (!match) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/** Parses `ps -o pid=,pgid=,etime=,command=`. */
export function parsePs(output: string): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match) {
      result.push({
        pid: Number(match[1]),
        groupId: Number(match[2]),
        uptimeSeconds: parseElapsed(match[3]),
        commandLine: match[4].trim(),
      });
    }
  }
  return result;
}

/** Parses `lsof -a -d cwd -Fpn -p <pids>` into a pid → working directory map. */
export function parseCwd(output: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n') && pid) {
      result.set(pid, line.slice(1).trim());
    }
  }
  return result;
}

/** Parses the JSON from PowerShell's `Get-CimInstance Win32_Process` (one object or an array). */
export function parseWindowsProcesses(json: string): ProcessInfo[] {
  if (!json.trim()) {
    return [];
  }
  const parsed: unknown = JSON.parse(json);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const result: ProcessInfo[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    const pid = Number(item.ProcessId);
    if (!pid) {
      continue;
    }
    const age = Number(item.Age);
    result.push({
      pid,
      name: typeof item.Name === 'string' ? item.Name : undefined,
      commandLine: typeof item.CommandLine === 'string' ? item.CommandLine : String(item.Name ?? ''),
      uptimeSeconds: Number.isFinite(age) && age >= 0 ? age : undefined,
    });
  }
  return result;
}

export function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined) {
    return '';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}
