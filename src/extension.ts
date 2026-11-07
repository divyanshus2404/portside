import * as vscode from 'vscode';
import { PortProcess, listPortProcesses, stopProcess } from './discovery';
import { formatUptime } from './parse';
import { findPortConflict, hasUnnamedPortConflict, portFromCommand, stripAnsi } from './portConflict';
import { Server, buildServers, serverDetails, urlFor } from './serverModel';
import { PortsTreeProvider } from './tree';

let servers: Server[] = [];
let refreshing: Promise<void> | undefined;
let lastError: string | undefined;
let extensionContext: vscode.ExtensionContext;

const MARKETPLACE_REVIEWS = 'https://marketplace.visualstudio.com/items?itemName=DivyanshuSingh.portside&ssr=false#review-details';
const OPEN_VSX_REVIEWS = 'https://open-vsx.org/extension/DivyanshuSingh/portside/reviews';
const REVIEW_AFTER_STOPS = 5;

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('portside');
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

function serverOnPort(port: number): Server | undefined {
  return servers.find((item) => item.port === port || item.extraPorts.includes(port));
}

function describeHolder(server: Server): string {
  if (server.container) {
    return `the Docker container ${server.container.name} (${server.container.image})`;
  }
  const where = server.project ? ` from ${server.project}` : '';
  const age = server.uptimeSeconds !== undefined ? `, running for ${formatUptime(server.uptimeSeconds)}` : '';
  return `${server.label}${where} (PID ${server.pid}${age})`;
}

/** Opens a localhost URL; in remote windows (SSH, WSL, containers) VS Code forwards the port first. */
async function openServer(server: Server): Promise<void> {
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(urlFor(server)));
  await vscode.env.openExternal(external);
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const tree = new PortsTreeProvider();
  const view = vscode.window.createTreeView('portside.ports', { treeDataProvider: tree, showCollapseAll: true });
  const statusBar = vscode.window.createStatusBarItem('portside.status', vscode.StatusBarAlignment.Left, 50);
  statusBar.name = 'Portside';
  statusBar.command = 'portside.showServers';
  context.subscriptions.push(view, statusBar);

  const refresh = (): Promise<void> => {
    refreshing ??= (async () => {
      try {
        servers = buildServers(await listPortProcesses(), workspaceFolders());
        lastError = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastError) {
          lastError = message;
          vscode.window.showWarningMessage(`Portside couldn't list ports: ${message}`);
        }
      } finally {
        refreshing = undefined;
      }
      tree.update(servers);
      updateStatusBar(statusBar);
      void vscode.commands.executeCommand(
        'setContext',
        'portside.hasProjectServers',
        servers.some((server) => server.group === 'workspace'),
      );
    })();
    return refreshing;
  };

  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) {
      clearInterval(timer);
    }
    const seconds = Math.max(2, settings().get<number>('refreshInterval', 5));
    timer = setInterval(() => {
      if (vscode.window.state.focused) {
        void refresh();
      }
    }, seconds * 1000);
  };
  schedule();
  context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => state.focused && void refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('portside')) {
        schedule();
        updateStatusBar(statusBar);
      }
    }),
    vscode.commands.registerCommand('portside.refresh', () => refresh()),
    vscode.commands.registerCommand('portside.openInBrowser', (server?: Server) => server && openServer(server)),
    vscode.commands.registerCommand('portside.copyUrl', async (server?: Server) => {
      if (server) {
        await vscode.env.clipboard.writeText(urlFor(server));
        vscode.window.setStatusBarMessage(`Copied ${urlFor(server)}`, 2500);
      }
    }),
    vscode.commands.registerCommand('portside.revealFolder', (server?: Server) => {
      if (server?.cwd) {
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(server.cwd));
      } else if (server) {
        vscode.window.showInformationMessage(`Portside can't tell which folder started ${server.label}.`);
      }
    }),
    vscode.commands.registerCommand('portside.stop', (server?: Server) => server && stop(server, false, refresh)),
    vscode.commands.registerCommand('portside.forceKill', (server?: Server) => server && stop(server, true, refresh)),
    vscode.commands.registerCommand('portside.stopPort', () => stopPortPrompt(refresh)),
    vscode.commands.registerCommand('portside.showServers', () => showServersPick(refresh)),
    vscode.commands.registerCommand('portside.stopProjectServers', () => stopMany('workspace', refresh)),
    vscode.commands.registerCommand('portside.stopAllDevServers', () => stopMany('allDev', refresh)),
  );

  watchTerminals(context, refresh);
  void refresh();
}

function updateStatusBar(statusBar: vscode.StatusBarItem): void {
  const devServers = servers.filter((server) => server.group !== 'system');
  if (!settings().get<boolean>('showStatusBar', true) || devServers.length === 0) {
    statusBar.hide();
    return;
  }
  statusBar.text = `$(radio-tower) ${devServers.length}`;
  statusBar.tooltip = new vscode.MarkdownString(
    `**${devServers.length} dev server${devServers.length === 1 ? '' : 's'} running**\n\n` +
      devServers
        .map((server) => {
          const details = serverDetails(server, '');
          return `- \`:${server.port}\` ${server.label}${details ? ` · ${details}` : ''}`;
        })
        .join('\n'),
  );
  statusBar.show();
}

/** Stops a server, asking first for apps and system services. Returns whether the port was freed. */
async function stop(server: Server, force: boolean, refresh: () => Promise<void>, quiet = false): Promise<boolean> {
  if (server.group === 'system') {
    const choice = await vscode.window.showWarningMessage(
      `${server.label} (PID ${server.pid}) doesn't look like a dev server. Stop it anyway?`,
      { modal: true, detail: server.commandLine },
      force ? 'Force Kill' : 'Stop',
    );
    if (!choice) {
      return false;
    }
  }
  const result = await stopProcess(server, force);
  let stopped = result === 'stopped';
  if (stopped) {
    if (!quiet) {
      vscode.window.setStatusBarMessage(`$(check) Stopped ${server.label} on :${server.port}`, 3000);
    }
    void countSuccessfulStop();
  } else if (result === 'not-permitted') {
    vscode.window.showErrorMessage(
      `Portside isn't allowed to stop ${server.label} (PID ${server.pid}); it belongs to another user or the system.`,
    );
  } else if (!force) {
    const choice = await vscode.window.showWarningMessage(`${server.label} on :${server.port} is still running.`, 'Force Kill');
    if (choice) {
      stopped = await stop(server, true, refresh, quiet);
      return stopped;
    }
  } else {
    vscode.window.showErrorMessage(`Couldn't stop ${server.label} (PID ${server.pid}).`);
  }
  await refresh();
  return stopped;
}

async function stopMany(scope: 'workspace' | 'allDev', refresh: () => Promise<void>): Promise<void> {
  await refresh();
  const targets = servers.filter((server) => (scope === 'workspace' ? server.group === 'workspace' : server.group !== 'system'));
  if (targets.length === 0) {
    vscode.window.showInformationMessage(scope === 'workspace' ? 'No servers from this project are running.' : 'No dev servers are running.');
    return;
  }
  const list = targets.map((server) => `:${server.port} ${server.label}`).join(', ');
  const choice = await vscode.window.showWarningMessage(
    scope === 'workspace'
      ? `Stop ${targets.length} server${targets.length === 1 ? '' : 's'} from this project?`
      : `Stop all ${targets.length} running dev server${targets.length === 1 ? '' : 's'}?`,
    { modal: true, detail: list },
    'Stop',
  );
  if (choice !== 'Stop') {
    return;
  }
  let stoppedCount = 0;
  for (const server of targets) {
    if (await stop(server, false, refresh, true)) {
      stoppedCount++;
    }
  }
  vscode.window.setStatusBarMessage(`$(check) Stopped ${stoppedCount} of ${targets.length} servers`, 4000);
  await refresh();
}

async function stopPortPrompt(refresh: () => Promise<void>): Promise<void> {
  const input = await vscode.window.showInputBox({
    title: 'Stop whatever is using a port',
    prompt: 'Port number',
    placeHolder: '3000',
    validateInput: (value) => (/^\d{1,5}$/.test(value.trim()) && Number(value) < 65536 ? undefined : 'Enter a port number'),
  });
  if (!input) {
    return;
  }
  await refresh();
  const port = Number(input.trim());
  const server = serverOnPort(port);
  if (!server) {
    vscode.window.showInformationMessage(`Nothing you can see is listening on port ${port}.`);
    return;
  }
  await stop(server, false, refresh);
}

async function showServersPick(refresh: () => Promise<void>): Promise<void> {
  await refresh();
  type Pick = vscode.QuickPickItem & { server: Server };
  const devServers = servers.filter((server) => server.group !== 'system');
  if (devServers.length === 0) {
    vscode.window.showInformationMessage('No dev servers are running.');
    return;
  }
  const stopButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('debug-stop'), tooltip: 'Stop' };
  const pick = vscode.window.createQuickPick<Pick>();
  pick.title = 'Running dev servers';
  pick.placeholder = 'Select to open in the browser';
  pick.items = devServers.map((server) => ({
    label: `:${server.port}  ${server.label}`,
    description: serverDetails(server, formatUptime(server.uptimeSeconds)),
    detail: server.container ? `docker container ${server.container.id}` : server.commandLine,
    buttons: [stopButton],
    server,
  }));
  pick.onDidAccept(() => {
    const selected = pick.selectedItems[0];
    if (selected) {
      void openServer(selected.server);
    }
    pick.hide();
  });
  pick.onDidTriggerItemButton(async (event) => {
    pick.hide();
    await stop(event.item.server, false, refresh);
  });
  pick.onDidHide(() => pick.dispose());
  pick.show();
}

/** Watches terminal commands for "port already in use" errors and offers to stop the culprit. */
function watchTerminals(context: vscode.ExtensionContext, refresh: () => Promise<void>): void {
  const recentlyOffered = new Map<number, number>();
  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution(async (event) => {
      if (!settings().get<boolean>('detectPortConflicts', true)) {
        return;
      }
      const commandLine = event.execution.commandLine.value;
      // Keep only a tail of the output so long-running servers don't grow memory.
      let tail = '';
      try {
        for await (const chunk of event.execution.read()) {
          tail = (tail + stripAnsi(chunk)).slice(-4000);
          const port = findPortConflict(tail) ?? (hasUnnamedPortConflict(tail) ? portFromCommand(commandLine) : undefined);
          if (port !== undefined) {
            tail = '';
            const last = recentlyOffered.get(port) ?? 0;
            if (Date.now() - last > 30_000) {
              recentlyOffered.set(port, Date.now());
              void handlePortConflict(port, event.terminal, commandLine, refresh);
            }
          }
        }
      } catch {
        // The terminal closed while reading; nothing to do.
      }
    }),
  );
}

/** After freeing a port, offers to rerun the command that failed in the same terminal. */
async function offerRunAgain(message: string, terminal: vscode.Terminal, commandLine: string): Promise<void> {
  const canRerun = commandLine.trim().length > 0 && vscode.window.terminals.includes(terminal);
  const choice = await vscode.window.showInformationMessage(message, ...(canRerun ? ['Run Again'] : []));
  if (choice === 'Run Again' && vscode.window.terminals.includes(terminal)) {
    terminal.show();
    terminal.sendText(commandLine, true);
  }
}

async function handlePortConflict(
  port: number,
  terminal: vscode.Terminal,
  commandLine: string,
  refresh: () => Promise<void>,
): Promise<void> {
  await refresh();
  const server = serverOnPort(port);
  if (!server) {
    return;
  }
  if (server.label === 'AirPlay Receiver (macOS)') {
    const choice = await vscode.window.showWarningMessage(
      `Port ${port} is taken by macOS AirPlay Receiver. Turn it off in System Settings → General → AirDrop & Handoff, or use another port.`,
      'Open Settings',
    );
    if (choice) {
      void vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.AirDrop-Handoff-Settings.extension'));
    }
    return;
  }

  // Opt-in: a stale server from the open project is stopped without asking.
  if (settings().get<boolean>('autoFreePortsFromThisProject', false) && server.group === 'workspace') {
    if (await stop(server, false, refresh, true)) {
      await offerRunAgain(`Freed port ${port}: stopped the old ${server.label}${server.project ? ` from ${server.project}` : ''}.`, terminal, commandLine);
    }
    return;
  }

  const choice = await vscode.window.showWarningMessage(`Port ${port} is used by ${describeHolder(server)}.`, 'Stop It', 'Show');
  if (choice === 'Stop It') {
    if (await stop(server, false, refresh, true)) {
      await offerRunAgain(`Port ${port} is free now.`, terminal, commandLine);
    }
  } else if (choice === 'Show') {
    await vscode.commands.executeCommand('portside.ports.focus');
  }
}

/** After a few successful stops, asks once (and only once) for a rating. */
async function countSuccessfulStop(): Promise<void> {
  const state = extensionContext.globalState;
  const count = state.get<number>('portside.successfulStops', 0) + 1;
  await state.update('portside.successfulStops', count);
  if (count < REVIEW_AFTER_STOPS || state.get<boolean>('portside.reviewAsked', false)) {
    return;
  }
  await state.update('portside.reviewAsked', true);
  const choice = await vscode.window.showInformationMessage(
    `Portside has freed ${count} ports for you. If it's saving you time, a quick rating helps other developers find it.`,
    'Rate Portside',
    'No Thanks',
  );
  if (choice === 'Rate Portside') {
    const reviews = vscode.env.uriScheme.startsWith('vscode') ? MARKETPLACE_REVIEWS : OPEN_VSX_REVIEWS;
    void vscode.env.openExternal(vscode.Uri.parse(reviews));
  }
}

export function deactivate(): void {}

export type { PortProcess };
