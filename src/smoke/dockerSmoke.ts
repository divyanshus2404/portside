// End-to-end check of Docker support against a real container (runs on Linux CI, which has
// Docker):   npm run test:docker
// A published nginx container must show up by its container name and image, and Stop must
// stop the container (docker stop) and free the port.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { listPortProcesses, stopProcess } from '../discovery';
import { buildServers, serverDetails } from '../serverModel';

const NAME = 'portside-smoke-web';
const PORT = 18_080;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function main(): Promise<void> {
  try {
    docker('rm', '-f', NAME);
  } catch {
    // Not left over from an earlier run.
  }
  docker('run', '-d', '--name', NAME, '-p', `${PORT}:80`, 'nginx:alpine');
  try {
    const server = await waitFor(`the container on :${PORT}`, async () =>
      buildServers(await listPortProcesses(), []).find((item) => item.port === PORT),
    );
    assert.equal(server.container?.name, NAME, 'the port is attributed to the container');
    assert.equal(server.label, NAME);
    assert.equal(serverDetails(server, ''), 'Docker · nginx:alpine');
    assert.equal(server.group, 'otherDev');
    console.log(`ok - container ${NAME} found on :${PORT}`);

    assert.equal(await stopProcess(server, false), 'stopped');
    const running = docker('ps', '--filter', `name=${NAME}`, '--format', '{{.Names}}');
    assert.equal(running, '', 'docker stop ended the container');
    console.log(`ok - container stopped and :${PORT} freed`);
    console.log('docker smoke test passed');
  } finally {
    try {
      docker('rm', '-f', NAME);
    } catch {
      // Already removed.
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
