// Groups discovered ports into what the sidebar shows: servers from the open project first,
// other dev servers next, and apps and system services last.

import * as fs from 'node:fs';
import * as os from 'node:os';
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

/**
 * Resolves symlinks so folders compare equal to what `lsof` reports. On macOS `/var` and
 * `/tmp` link to `/private/...`, and project folders are often symlinked from other drives.
 */
export function realFolder(folder: string): string {
  try {
    return fs.realpathSync.native(folder);
  } catch {
    return folder;
  }
}

export function isInside(folder: string, target: string): boolean {
  const relative = path.relative(folder, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The project folder to show for a server. Servers started from the home folder (e.g. a
 * quick `npx http-server` in a new terminal) don't belong to a project, so they get none.
 */
export function projectName(cwd: string | undefined, homeDirectory: string): string | undefined {
  if (!cwd || path.resolve(cwd) === path.resolve(homeDirectory)) {
    return undefined;
  }
  return path.basename(cwd);
}

/** Builds the sidebar model. One entry per process, keeping its lowest port as the main one. */
export function buildServers(
  processes: PortProcess[],
  workspaceFolders: string[],
  homeDirectory: string = os.homedir(),
): Server[] {
  const folders = workspaceFolders.map(realFolder);
  const home = realFolder(homeDirectory);
  const byPid = new Map<number, Server>();
  for (const item of [...processes].sort((a, b) => a.port - b.port)) {
    const existing = byPid.get(item.pid);
    if (existing) {
      if (!existing.extraPorts.includes(item.port) && existing.port !== item.port) {
        existing.extraPorts.push(item.port);
      }
      continue;
    }
    const insideWorkspace = !!item.cwd && folders.some((folder) => isInside(folder, item.cwd!));
    const dev = !isAirPlayReceiver(item.name, item.port) && isDevProcess(item.commandLine, item.name, insideWorkspace);
    byPid.set(item.pid, {
      ...item,
      label: describeProcess(item.commandLine, item.name, item.port),
      group: insideWorkspace ? 'workspace' : dev ? 'otherDev' : 'system',
      project: projectName(item.cwd, home),
      extraPorts: [],
    });
  }
  return [...byPid.values()].sort((a, b) => a.port - b.port);
}

export function urlFor(server: Pick<Server, 'port'>): string {
  return `http://localhost:${server.port}`;
}
