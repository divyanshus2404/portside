import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPortConflict, hasUnnamedPortConflict, portFromCommand } from '../portConflict';

test('findPortConflict reads the port from each tool\'s error message', () => {
  const cases: Array<[string, number]> = [
    ['Error: listen EADDRINUSE: address already in use :::3000', 3000],
    ['Error: listen EADDRINUSE: address already in use 127.0.0.1:8080', 8080],
    [' ⚠ Port 3000 is in use, trying 3001 instead.', 3000],
    ['Port 5173 is in use, trying another one...', 5173],
    ['Error: Port 4321 is already in use', 4321],
    ['Something is already running on port 3000.', 3000],
    ["ERROR:    [Errno 48] error while attempting to bind on address ('127.0.0.1', 8000): address already in use", 8000],
    ['listen tcp :8080: bind: address already in use', 8080],
    ['Address already in use - bind(2) for "127.0.0.1" port 3000 (Errno::EADDRINUSE)', 3000],
    ['\u001b[31mError: listen EADDRINUSE: address already in use :::4000\u001b[39m', 4000],
  ];
  for (const [text, port] of cases) {
    assert.equal(findPortConflict(text), port, text);
  }
});

test('findPortConflict ignores normal server output', () => {
  assert.equal(findPortConflict('  ➜  Local:   http://localhost:5173/'), undefined);
  assert.equal(findPortConflict('ready - started server on 0.0.0.0:3000, url: http://localhost:3000'), undefined);
  assert.equal(findPortConflict('INFO:     Uvicorn running on http://127.0.0.1:8000'), undefined);
});

test('conflicts without a port are recognized, and the port comes from the command', () => {
  assert.equal(hasUnnamedPortConflict('Error: That port is already in use.'), true);
  assert.equal(hasUnnamedPortConflict('OSError: [Errno 48] Address already in use'), true);
  assert.equal(hasUnnamedPortConflict('Compiled successfully'), false);
  assert.equal(portFromCommand('python manage.py runserver'), 8000);
  assert.equal(portFromCommand('python manage.py runserver 0.0.0.0:8001'), 8001);
  assert.equal(portFromCommand('uvicorn main:app --port 9000'), 9000);
  assert.equal(portFromCommand('PORT=4000 node server.js'), 4000);
  assert.equal(portFromCommand('node server.js'), undefined);
});
