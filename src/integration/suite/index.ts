// Runs inside VS Code: Portside activates, registers every command it declares, and the
// commands that don't need a UI run without errors while a real server is listening.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('DivyanshuSingh.portside');
  assert.ok(extension, 'Portside is installed in the test window');
  await extension.activate();
  assert.equal(extension.isActive, true, 'Portside activates');
  console.log('ok - activated');

  const declared: string[] = extension.packageJSON.contributes.commands.map((command: { command: string }) => command.command);
  const registered = new Set(await vscode.commands.getCommands(true));
  for (const command of declared) {
    assert.ok(registered.has(command), `${command} is registered`);
  }
  console.log(`ok - all ${declared.length} declared commands are registered`);

  const workspace = process.env.PORTSIDE_TEST_WORKSPACE!;
  fs.writeFileSync(path.join(workspace, 'server.js'), "require('node:http').createServer((_, res) => res.end('ok')).listen(Number(process.argv[2]));\n");
  const port = await freePort();
  const server = spawn(process.execPath.includes('node') ? process.execPath : 'node', ['server.js', String(port)], {
    cwd: workspace,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await vscode.commands.executeCommand('portside.refresh');
    console.log('ok - refresh runs with a live server');
    await vscode.commands.executeCommand('portside.ports.focus');
    console.log('ok - the Portside view opens');
  } finally {
    server.kill();
  }
}
