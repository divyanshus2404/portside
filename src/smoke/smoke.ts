// End-to-end check of discovery and stopping against real processes. Runs on every OS in CI:
//   npm run test:smoke
// 1. a plain node server is found on its port, with a readable name, then stopped
// 2. `npm run dev` (npm → node) is found and stopping it frees the port (and, on macOS and
//    Linux, ends the whole process group so npm can't restart it)

import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { listPortProcesses, stopProcess } from '../discovery';
import { buildServers } from '../serverModel';

const isWindows = process.platform === 'win32';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findServer(port: number, project: string) {
  return waitFor(`a listener on :${port}`, async () => {
    const servers = buildServers(await listPortProcesses(), [project]);
    return servers.find((server) => server.port === port || server.extraPorts.includes(port));
  });
}

async function portIsFree(port: number): Promise<void> {
  await waitFor(`:${port} to be free`, async () => {
    const listeners = await listPortProcesses();
    return listeners.some((listener) => listener.port === port) ? undefined : true;
  });
}

function makeProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'portside-smoke-'));
  fs.writeFileSync(
    path.join(project, 'server.js'),
    "require('node:http').createServer((_, res) => res.end('ok')).listen(Number(process.argv[2]), () => console.log('listening'));\n",
  );
  fs.writeFileSync(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'smoke-app', private: true, scripts: { dev: 'node server.js' } }),
  );
  return project;
}

async function plainNodeServer(project: string): Promise<void> {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js', String(port)], { cwd: project, stdio: 'ignore' });
  try {
    const server = await findServer(port, project);
    assert.equal(server.pid, child.pid, 'the listener is the node process');
    assert.equal(server.label, 'node server.js');
    if (!isWindows) {
      assert.equal(server.group, 'workspace', 'the server is recognized as part of the open project');
    }
    assert.equal(await stopProcess(server, false), 'stopped');
    await portIsFree(port);
    console.log(`ok - plain node server on :${port} found and stopped`);
  } finally {
    child.kill();
  }
}

async function npmRunDev(project: string): Promise<void> {
  const port = await freePort();
  // `detached` gives the job its own process group, as an interactive terminal does.
  const npm: ChildProcess = spawn(isWindows ? 'npm.cmd' : 'npm', ['run', 'dev', '--', String(port)], {
    cwd: project,
    stdio: 'ignore',
    detached: !isWindows,
    shell: isWindows,
  });
  try {
    const server = await findServer(port, project);
    assert.match(server.commandLine, /server\.js/);
    assert.notEqual(server.pid, npm.pid, 'npm itself does not listen; its node child does');
    assert.equal(await stopProcess(server, false), 'stopped');
    await portIsFree(port);
    if (!isWindows && npm.pid) {
      await waitFor('npm to exit with its job', async () => (isRunning(npm.pid!) ? undefined : true), 5000);
    }
    console.log(`ok - npm run dev on :${port} found and stopped${isWindows ? '' : ' (whole job ended)'}`);
  } finally {
    if (npm.pid && isRunning(npm.pid)) {
      npm.kill();
    }
  }
}

async function main(): Promise<void> {
  const project = makeProject();
  await plainNodeServer(project);
  await npmRunDev(project);
  console.log('smoke test passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
