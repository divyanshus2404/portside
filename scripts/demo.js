#!/usr/bin/env node
// Starts a few small local servers that look like everyday dev servers (Next.js, Vite, Astro,
// Django and a plain Node API), each in its own project folder, so Portside's sidebar and
// port-conflict popup can be tried or recorded without real projects.
//
//   npm run demo          start the demo servers (Ctrl-C stops them all)
//   npm run demo -- --path   print the demo folder, e.g. to open "storefront" in VS Code

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(os.tmpdir(), 'portside-demo');

const SERVER_SOURCE = `
const http = require('node:http');
const port = Number(process.argv[process.argv.length - 1]) || Number(process.env.PORT);
const name = process.env.DEMO_NAME;
http.createServer((_, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>' + name + '</title><body style="font:16px system-ui;padding:2rem">' +
    '<h1>' + name + '</h1><p>A Portside demo server on port ' + port + '.</p>');
}).listen(port, () => {});
`;

const DJANGO_SOURCE = `
import http.server, sys
port = int(sys.argv[-1])
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
`;

// Each entry is laid out so its command line matches what the real tool runs.
const SERVERS = [
  { project: 'storefront', name: 'Next.js', port: 3000, bin: 'node_modules/.bin/next', args: ['dev', '3000'] },
  { project: 'storefront', name: 'Storybook', port: 6006, bin: 'node_modules/.bin/storybook', args: ['dev', '6006'] },
  { project: 'dashboard', name: 'Vite', port: 5173, bin: 'node_modules/.bin/vite', args: ['5173'] },
  { project: 'docs', name: 'Astro', port: 4321, bin: 'node_modules/.bin/astro', args: ['dev', '4321'] },
  { project: 'realtime', name: 'Node API', port: 4000, bin: 'server.js', args: ['4000'] },
  { project: 'blog-api', name: 'Django', port: 8000, python: true, bin: 'manage.py', args: ['runserver', '8000'] },
];

function prepare() {
  for (const server of SERVERS) {
    const file = path.join(root, server.project, server.bin);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, server.python ? DJANGO_SOURCE : SERVER_SOURCE);
  }
}

function portInUse(port) {
  try {
    execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (process.argv.includes('--path')) {
    console.log(root);
    return;
  }
  prepare();
  const children = [];
  for (const server of SERVERS) {
    if (portInUse(server.port)) {
      console.log(`  skipped  :${server.port}  ${server.name} (port already in use)`);
      continue;
    }
    const cwd = path.join(root, server.project);
    const command = server.python ? 'python3' : process.execPath;
    const child = spawn(command, [server.bin, ...server.args], {
      cwd,
      env: { ...process.env, DEMO_NAME: `${server.name} · ${server.project}` },
      stdio: 'ignore',
    });
    child.on('error', (error) => console.log(`  failed   :${server.port}  ${server.name}: ${error.message}`));
    children.push(child);
    console.log(`  started  :${server.port}  ${server.name.padEnd(9)} ${path.join(root, server.project)}`);
  }
  console.log(`\nOpen ${path.join(root, 'storefront')} in VS Code to see "This project" in Portside.`);
  console.log('Press Ctrl-C to stop the demo servers.');
  const stop = () => {
    for (const child of children) {
      child.kill('SIGTERM');
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30);
}

main();
