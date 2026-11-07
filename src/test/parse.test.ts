import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatUptime,
  parseCwd,
  parseElapsed,
  parseLsof,
  parseNetstat,
  parsePs,
  parseSs,
  parseWindowsProcesses,
} from '../parse';

test('parseLsof reads pid, name and port, and drops IPv4/IPv6 duplicates', () => {
  const output = ['p650', 'crapportd', 'f10', 'n*:61456', 'f11', 'n*:61456', 'p2188', 'cnode', 'f3', 'n127.0.0.1:3000', 'f4', 'n[::1]:24678', ''].join('\n');
  assert.deepEqual(parseLsof(output), [
    { pid: 650, name: 'rapportd', port: 61456, address: '*' },
    { pid: 2188, name: 'node', port: 3000, address: '127.0.0.1' },
    { pid: 2188, name: 'node', port: 24678, address: '[::1]' },
  ]);
});

test('parseLsof returns nothing for empty output', () => {
  assert.deepEqual(parseLsof(''), []);
});

test('parseSs reads the owning process from the users column', () => {
  const output = [
    'LISTEN 0      511          *:3000        *:*    users:(("node",pid=4242,fd=21))',
    'LISTEN 0      4096   127.0.0.53%lo:53    0.0.0.0:*',
    'LISTEN 0      128    [::1]:5432     [::]:*    users:(("postgres",pid=900,fd=7))',
  ].join('\n');
  assert.deepEqual(parseSs(output), [
    { pid: 4242, name: 'node', port: 3000, address: '*' },
    { pid: 900, name: 'postgres', port: 5432, address: '[::1]' },
  ]);
});

test('parseNetstat keeps listening sockets regardless of the localized state name', () => {
  const output = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       5120',
    '  TCP    [::]:3000              [::]:0                 ABHÖREN         5120',
    '  TCP    127.0.0.1:52000        127.0.0.1:443          ESTABLISHED     800',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       0',
  ].join('\r\n');
  assert.deepEqual(parseNetstat(output), [{ pid: 5120, name: '', port: 3000, address: '0.0.0.0' }]);
});

test('parseElapsed handles every ps time format', () => {
  assert.equal(parseElapsed('00:42'), 42);
  assert.equal(parseElapsed('11:29:27'), 11 * 3600 + 29 * 60 + 27);
  assert.equal(parseElapsed('04-13:50:06'), 4 * 86400 + 13 * 3600 + 50 * 60 + 6);
  assert.equal(parseElapsed('garbage'), undefined);
});

test('parsePs reads pid, group, uptime and the full command line', () => {
  const output = ' 2188  2188 04-13:50:06 /opt/homebrew/bin/node /Users/me/app/node_modules/.bin/next dev\n12543 11767    11:29:27 /usr/bin/python3 -m http.server 8000\n';
  assert.deepEqual(parsePs(output), [
    { pid: 2188, groupId: 2188, uptimeSeconds: 395406, commandLine: '/opt/homebrew/bin/node /Users/me/app/node_modules/.bin/next dev' },
    { pid: 12543, groupId: 11767, uptimeSeconds: 41367, commandLine: '/usr/bin/python3 -m http.server 8000' },
  ]);
});

test('parseCwd maps processes to their working folder', () => {
  const output = 'p2188\nfcwd\nn/\np2192\nfcwd\nn/Users/me/app\n';
  assert.deepEqual([...parseCwd(output)], [
    [2188, '/'],
    [2192, '/Users/me/app'],
  ]);
});

test('parseWindowsProcesses accepts a single object or an array', () => {
  const single = '{"ProcessId":5120,"Name":"node.exe","CommandLine":"node server.js","Age":75}';
  assert.deepEqual(parseWindowsProcesses(single), [{ pid: 5120, name: 'node.exe', commandLine: 'node server.js', uptimeSeconds: 75 }]);
  const many = '[{"ProcessId":1,"Name":"a.exe","CommandLine":null,"Age":5},{"ProcessId":2,"Name":"b.exe","CommandLine":"b","Age":null}]';
  assert.deepEqual(parseWindowsProcesses(many), [
    { pid: 1, name: 'a.exe', commandLine: 'a.exe', uptimeSeconds: 5 },
    { pid: 2, name: 'b.exe', commandLine: 'b', uptimeSeconds: 0 },
  ]);
  assert.deepEqual(parseWindowsProcesses(''), []);
});

test('formatUptime picks the largest sensible unit', () => {
  assert.equal(formatUptime(undefined), '');
  assert.equal(formatUptime(42), '42s');
  assert.equal(formatUptime(125), '2m');
  assert.equal(formatUptime(7200), '2h');
  assert.equal(formatUptime(200000), '2d');
});
