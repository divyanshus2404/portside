import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDockerForwarder, parseDockerPs } from '../docker';
import { buildServers, folderInCommandLine, serverDetails } from '../serverModel';

test('parseDockerPs maps published host ports to containers', () => {
  const output = [
    'a1b2c3\tpostgres-db\tpostgres:16\t0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp',
    'd4e5f6\tcache\tredis:7\t127.0.0.1:6380->6379/tcp',
    'g7h8i9\tworker\tmy/worker:latest\t6379/tcp',
    'j1k2l3\tweb\tnginx:alpine\t0.0.0.0:8000-8002->8000-8002/tcp',
    '',
  ].join('\n');
  const ports = parseDockerPs(output);
  assert.equal(ports.get(5432)?.name, 'postgres-db');
  assert.equal(ports.get(5432)?.image, 'postgres:16');
  assert.equal(ports.get(6380)?.name, 'cache', 'the host side of the mapping is used');
  assert.equal(ports.get(6379), undefined, 'unpublished container ports are skipped');
  assert.deepEqual([8000, 8001, 8002].map((port) => ports.get(port)?.name), ['web', 'web', 'web']);
});

test('isDockerForwarder recognizes the common container runtimes', () => {
  assert.equal(isDockerForwarder('com.docke', '/Applications/Docker.app/Contents/MacOS/com.docker.backend'), true);
  assert.equal(isDockerForwarder('docker-proxy', '/usr/bin/docker-proxy -proto tcp -host-port 5432'), true);
  assert.equal(isDockerForwarder('OrbStack', '/Applications/OrbStack.app/Contents/Frameworks/OrbStack Helper'), true);
  assert.equal(isDockerForwarder('node', 'node server.js'), false);
});

test('buildServers gives each container its own entry, even behind one forwarder process', () => {
  const forwarder = { pid: 900, name: 'com.docke', address: '*', commandLine: '/Applications/Docker.app/Contents/MacOS/com.docker.backend' };
  const servers = buildServers(
    [
      { ...forwarder, port: 5432, container: { id: 'a1', name: 'postgres-db', image: 'postgres:16' } },
      { ...forwarder, port: 6380, container: { id: 'd4', name: 'cache', image: 'redis:7' } },
    ],
    [],
    '/home/nobody',
  );
  assert.deepEqual(
    servers.map((server) => [server.port, server.label, server.group, serverDetails(server, '1h')]),
    [
      [5432, 'postgres-db', 'otherDev', 'Docker · postgres:16 · 1h'],
      [6380, 'cache', 'otherDev', 'Docker · redis:7 · 1h'],
    ],
  );
});

test('folderInCommandLine matches Windows and Unix paths inside an open folder', () => {
  assert.equal(
    folderInCommandLine('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\shop\\node_modules\\.bin\\next dev', ['C:\\Users\\me\\shop']),
    'C:\\Users\\me\\shop',
  );
  assert.equal(folderInCommandLine('node /home/me/shop/server.js', ['/home/me/shop']), '/home/me/shop');
  assert.equal(folderInCommandLine('node /home/me/shop-old/server.js', ['/home/me/shop']), undefined);
  assert.equal(folderInCommandLine('node server.js', ['/home/me/shop']), undefined);
});

test('buildServers uses the command line to find the project when there is no working folder', () => {
  const [server] = buildServers(
    [{ pid: 7, name: 'node.exe', port: 3000, address: '0.0.0.0', commandLine: 'node C:\\Users\\me\\shop\\node_modules\\.bin\\next dev' }],
    ['C:\\Users\\me\\shop'],
    'C:\\Users\\me',
  );
  assert.equal(server.group, 'workspace');
  assert.equal(server.project, 'shop');
  assert.equal(server.label, 'Next.js');
});
