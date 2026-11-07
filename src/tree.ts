import * as vscode from 'vscode';
import { formatUptime } from './parse';
import { Server, ServerGroup, serverDetails, urlFor } from './serverModel';

const GROUP_TITLES: Record<ServerGroup, string> = {
  workspace: 'This project',
  otherDev: 'Other dev servers',
  system: 'Apps & system services',
};

type Node = { kind: 'group'; group: ServerGroup } | { kind: 'server'; server: Server };

export class PortsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private servers: Server[] = [];

  update(servers: Server[]): void {
    this.servers = servers;
    this.changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const groups: ServerGroup[] = ['workspace', 'otherDev', 'system'];
      return groups
        .filter((group) => this.servers.some((server) => server.group === group))
        .map((group) => ({ kind: 'group', group }));
    }
    if (node.kind === 'group') {
      return this.servers
        .filter((server) => server.group === node.group)
        .map((server) => ({ kind: 'server', server }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const count = this.servers.filter((server) => server.group === node.group).length;
      const item = new vscode.TreeItem(
        GROUP_TITLES[node.group],
        node.group === 'system' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = String(count);
      item.contextValue = 'group';
      return item;
    }
    return serverItem(node.server);
  }
}

function serverItem(server: Server): vscode.TreeItem {
  const item = new vscode.TreeItem(`:${server.port}  ${server.label}`, vscode.TreeItemCollapsibleState.None);
  item.description = serverDetails(server, formatUptime(server.uptimeSeconds));
  item.contextValue = 'server';
  item.iconPath = server.container
    ? new vscode.ThemeIcon('package', new vscode.ThemeColor('testing.iconPassed'))
    : new vscode.ThemeIcon(
        'circle-filled',
        new vscode.ThemeColor(server.group === 'system' ? 'disabledForeground' : 'testing.iconPassed'),
      );
  item.tooltip = serverTooltip(server);
  item.command = { command: 'portside.openInBrowser', title: 'Open in Browser', arguments: [server] };
  return item;
}

function serverTooltip(server: Server): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  const ports = [server.port, ...server.extraPorts].map((port) => `:${port}`).join(', ');
  tooltip.appendMarkdown(`**${server.label}** on ${ports}\n\n`);
  if (server.label === 'AirPlay Receiver (macOS)') {
    tooltip.appendMarkdown(
      'macOS uses this port for AirPlay. To free it, turn off **AirPlay Receiver** in System Settings → General → AirDrop & Handoff.\n\n',
    );
  }
  if (server.container) {
    tooltip.appendMarkdown(
      `Docker container \`${server.container.name}\` from image \`${server.container.image}\`. Stop runs \`docker stop\`.\n\n`,
    );
  } else {
    tooltip.appendCodeblock(server.commandLine, 'shell');
  }
  const rows = [
    server.cwd ? `Folder: \`${server.cwd}\`` : undefined,
    server.container ? `Container ID: ${server.container.id}` : `PID: ${server.pid}`,
    server.uptimeSeconds !== undefined ? `Running for ${formatUptime(server.uptimeSeconds)}` : undefined,
    `URL: ${urlFor(server)}`,
  ].filter(Boolean);
  tooltip.appendMarkdown(rows.join('  \n'));
  return tooltip;
}
