import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeProcess, executableName, isDevProcess, knownServer } from '../labels';
import { buildServers, isInside } from '../serverModel';

test('knownServer recognizes common frameworks from real command lines', () => {
  const cases: Array<[string, string]> = [
    ['/opt/homebrew/bin/node /Users/me/app/node_modules/.bin/next dev', 'Next.js'],
    ['next-server (v15.0.3)', 'Next.js'],
    ['node /Users/me/app/node_modules/next/dist/server/lib/start-server.js', 'Next.js'],
    ['node /Users/me/site/node_modules/.bin/vite', 'Vite'],
    ['node /Users/me/site/node_modules/.bin/astro dev', 'Astro'],
    ['node node_modules/react-scripts/scripts/start.js', 'Create React App'],
    ['/usr/bin/python3 manage.py runserver 8000', 'Django'],
    ['/Users/me/.venv/bin/python /Users/me/.venv/bin/uvicorn main:app --reload', 'Uvicorn'],
    ['/usr/bin/python3 -m http.server 8000', 'Python http.server'],
    ['/opt/homebrew/opt/postgresql@16/bin/postgres -D /opt/homebrew/var/postgresql@16', 'PostgreSQL'],
    ['/opt/homebrew/opt/redis/bin/redis-server 127.0.0.1:6379', 'Redis'],
    ['php artisan serve', 'Laravel'],
    ['puma 6.4.2 (tcp://localhost:3000) [blog]', 'Rails'],
  ];
  for (const [commandLine, label] of cases) {
    assert.equal(knownServer(commandLine), label, commandLine);
  }
});

test('knownServer leaves unrelated programs alone', () => {
  assert.equal(knownServer('/usr/libexec/rapportd'), undefined);
  assert.equal(knownServer('/Applications/Spotify.app/Contents/MacOS/Spotify'), undefined);
});

test('describeProcess falls back to the executable and its script', () => {
  assert.equal(describeProcess('/opt/homebrew/bin/node /Users/me/api/server.js', 'node', 4000), 'node server.js');
  assert.equal(describeProcess('/usr/libexec/rapportd', 'rapportd', 61456), 'rapportd');
  assert.equal(describeProcess('"C:\\Program Files\\nodejs\\node.exe" index.mjs', 'node.exe', 3000), 'node index.mjs');
});

test('describeProcess names macOS apps by their bundle, even with spaces in the path', () => {
  assert.equal(
    describeProcess('/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper --type=utility', 'Code\\x20H', 59278),
    'Visual Studio Code',
  );
  assert.equal(
    describeProcess('/opt/homebrew/Cellar/python@3.14/3.14.8/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python headforward.py', 'Python', 8787),
    'Python headforward.py',
  );
});

test('describeProcess names macOS AirPlay Receiver on 5000 and 7000', () => {
  assert.equal(describeProcess('/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter', 'ControlCe', 5000), 'AirPlay Receiver (macOS)');
});

test('executableName strips folders and .exe', () => {
  assert.equal(executableName('/usr/local/bin/node app.js'), 'node');
  assert.equal(executableName('"C:\\Program Files\\nodejs\\node.exe" app.js'), 'node');
  assert.equal(executableName('', 'fallback'), 'fallback');
});

test('isDevProcess separates dev servers from apps and system services', () => {
  assert.equal(isDevProcess('/opt/homebrew/bin/node server.js', 'node', false), true);
  assert.equal(isDevProcess('/opt/homebrew/Cellar/python@3.14/bin/Python app.py', 'Python', false), true);
  assert.equal(isDevProcess('/usr/libexec/rapportd', 'rapportd', false), false);
  assert.equal(isDevProcess('/Applications/Spotify.app/Contents/MacOS/Spotify', 'Spotify', false), false);
  assert.equal(isDevProcess('/Users/me/app/target/debug/my-api', 'my-api', true), true);
});

test('isInside only accepts folders within the workspace', () => {
  assert.equal(isInside('/Users/me/app', '/Users/me/app'), true);
  assert.equal(isInside('/Users/me/app', '/Users/me/app/packages/web'), true);
  assert.equal(isInside('/Users/me/app', '/Users/me/app-old'), false);
  assert.equal(isInside('/Users/me/app', '/Users/me'), false);
});

test('buildServers groups by project and merges extra ports of one process', () => {
  const servers = buildServers(
    [
      { pid: 10, name: 'node', port: 24678, address: '*', commandLine: 'node /w/app/node_modules/.bin/vite', cwd: '/w/app' },
      { pid: 10, name: 'node', port: 5173, address: '*', commandLine: 'node /w/app/node_modules/.bin/vite', cwd: '/w/app' },
      { pid: 20, name: 'node', port: 4000, address: '*', commandLine: 'node server.js', cwd: '/w/other' },
      { pid: 30, name: 'rapportd', port: 61456, address: '*', commandLine: '/usr/libexec/rapportd' },
      { pid: 40, name: 'ControlCe', port: 5000, address: '*', commandLine: '/System/ControlCenter' },
    ],
    ['/w/app'],
  );
  assert.deepEqual(
    servers.map((server) => [server.port, server.label, server.group, server.project, server.extraPorts]),
    [
      [4000, 'node server.js', 'otherDev', 'other', []],
      [5000, 'AirPlay Receiver (macOS)', 'system', undefined, []],
      [5173, 'Vite', 'workspace', 'app', [24678]],
      [61456, 'rapportd', 'system', undefined, []],
    ],
  );
});
