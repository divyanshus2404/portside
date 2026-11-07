// Groups discovered ports into what the sidebar shows: servers from the open project first,
// other dev servers next, and apps and system services last.

import * as path from 'node:path';
import { PortProcess } from './discovery';
import { describeProcess, isAirPlayReceiver, isDevProcess } from './labels';

export type ServerGroup = 'workspace' | 'otherDev' | 'system';

export interface Server extends PortProcess {
  label: string;
  group: ServerGroup;
  /** Folder name of the project that started the server, if known. */
  project?: string;
  /** Other ports opened by the same process (e.g. HTTP + HMR websocket). */
  extraPorts: number[];
}

export function isInside(folder: string, target: string): boolean {
  const relative = path.relative(folder, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Builds the sidebar model. One entry per process, keeping its lowest port as the main one. */
export function buildServers(processes: PortProcess[], workspaceFolders: string[]): Server[] {
  const byPid = new Map<number, Server>();
  for (const item of [...processes].sort((a, b) => a.port - b.port)) {
    const existing = byPid.get(item.pid);
    if (existing) {
      if (!existing.extraPorts.includes(item.port) && existing.port !== item.port) {
        existing.extraPorts.push(item.port);
      }
      continue;
    }
    const insideWorkspace = !!item.cwd && workspaceFolders.some((folder) => isInside(folder, item.cwd!));
    const dev = !isAirPlayReceiver(item.name, item.port) && isDevProcess(item.commandLine, item.name, insideWorkspace);
    byPid.set(item.pid, {
      ...item,
      label: describeProcess(item.commandLine, item.name, item.port),
      group: insideWorkspace ? 'workspace' : dev ? 'otherDev' : 'system',
      project: item.cwd ? path.basename(item.cwd) : undefined,
      extraPorts: [],
    });
  }
  return [...byPid.values()].sort((a, b) => a.port - b.port);
}

export function urlFor(server: Pick<Server, 'port'>): string {
  return `http://localhost:${server.port}`;
}
