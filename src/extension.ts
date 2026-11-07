import * as vscode from 'vscode';
import { PortProcess, listPortProcesses, stopProcess } from './discovery';
import { formatUptime } from './parse';
import { findPortConflict, hasUnnamedPortConflict, portFromCommand, stripAnsi } from './portConflict';
import { Server, buildServers, urlFor } from './serverModel';
import { PortsTreeProvider } from './tree';

let servers: Server[] = [];
let refreshing: Promise<void> | undefined;
let lastError: string | undefined;

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('portside');
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

export function activate(context: vscode.ExtensionContext): void {
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
      view.badge = undefined;
      updateStatusBar(statusBar);
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
    vscode.commands.registerCommand('portside.openInBrowser', (server?: Server) => {
      if (server) {
        void vscode.env.openExternal(vscode.Uri.parse(urlFor(server)));
      }
    }),
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
  const tooltip = new vscode.MarkdownString(
    `**${devServers.length} dev server${devServers.length === 1 ? '' : 's'} running**\n\n` +
      devServers
        .map((server) => `- \`:${server.port}\` ${server.label}${server.project ? ` · ${server.project}` : ''}`)
        .join('\n'),
  );
  statusBar.tooltip = tooltip;
  statusBar.show();
}

async function stop(server: Server, force: boolean, refresh: () => Promise<void>): Promise<void> {
  if (server.group === 'system') {
    const choice = await vscode.window.showWarningMessage(
      `${server.label} (PID ${server.pid}) doesn't look like a dev server. Stop it anyway?`,
      { modal: true, detail: server.commandLine },
      force ? 'Force Kill' : 'Stop',
    );
    if (!choice) {
      return;
    }
  }
  const result = await stopProcess(server, force);
  if (result === 'stopped') {
    vscode.window.setStatusBarMessage(`$(check) Stopped ${server.label} on :${server.port}`, 3000);
  } else if (result === 'not-permitted') {
    vscode.window.showErrorMessage(
      `Portside isn't allowed to stop ${server.label} (PID ${server.pid}); it belongs to another user or the system.`,
    );
  } else if (!force) {
    const choice = await vscode.window.showWarningMessage(
      `${server.label} on :${server.port} is still running.`,
      'Force Kill',
    );
    if (choice) {
      await stop(server, true, refresh);
      return;
    }
  } else {
    vscode.window.showErrorMessage(`Couldn't stop ${server.label} (PID ${server.pid}).`);
  }
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
  const server = servers.find((item) => item.port === port || item.extraPorts.includes(port));
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
    description: [server.project, formatUptime(server.uptimeSeconds)].filter(Boolean).join(' · '),
    detail: server.commandLine,
    buttons: [stopButton],
    server,
  }));
  pick.onDidAccept(() => {
    const selected = pick.selectedItems[0];
    if (selected) {
      void vscode.env.openExternal(vscode.Uri.parse(urlFor(selected.server)));
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
              void offerToFreePort(port, refresh);
            }
          }
        }
      } catch {
        // The terminal closed while reading; nothing to do.
      }
    }),
  );
}

async function offerToFreePort(port: number, refresh: () => Promise<void>): Promise<void> {
  await refresh();
  const server = servers.find((item) => item.port === port || item.extraPorts.includes(port));
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
  const where = server.project ? ` from ${server.project}` : '';
  const age = server.uptimeSeconds !== undefined ? `, running for ${formatUptime(server.uptimeSeconds)}` : '';
  const choice = await vscode.window.showWarningMessage(
    `Port ${port} is used by ${server.label}${where} (PID ${server.pid}${age}).`,
    'Stop It',
    'Show',
  );
  if (choice === 'Stop It') {
    await stop(server, false, refresh);
  } else if (choice === 'Show') {
    await vscode.commands.executeCommand('portside.ports.focus');
  }
}

export function deactivate(): void {}

export type { PortProcess };
