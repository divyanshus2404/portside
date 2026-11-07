// Recognizes "port already in use" errors in terminal output from common dev tools.

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

const PORT_IN_USE_PATTERNS: RegExp[] = [
  // Node: "Error: listen EADDRINUSE: address already in use :::3000"
  /EADDRINUSE\b[^\n]*?:(\d{2,5})\b/,
  // Next.js, Vite, Astro, Nuxt and others: "Port 3000 is already in use", "Port 5173 is in use"
  /\bport\s+(\d{2,5})\s+is\s+(?:already\s+)?in\s+use/i,
  // Create React App: "Something is already running on port 3000."
  /already running on port\s+(\d{2,5})/i,
  // Uvicorn and Python sockets: "error while attempting to bind on address ('127.0.0.1', 8000): address already in use"
  /bind on address \('[^']*',\s*(\d{2,5})\)/i,
  // Django and generic: "Error: That port is already in use." handled below; "0.0.0.0:8000: address already in use"
  /:(\d{2,5})\b[^\n]{0,40}address already in use/i,
  /address already in use[^\n]{0,40}?:(\d{2,5})\b/i,
  // Go: "listen tcp :8080: bind: address already in use"
  /listen tcp [^\s:]*:(\d{2,5}): bind: address already in use/i,
  // Rails/Puma: "Address already in use - bind(2) for "127.0.0.1" port 3000"
  /Address already in use[^\n]*\bport\s+(\d{2,5})/i,
];

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/** Returns the port from a "port in use" error in the text, if there is one. */
export function findPortConflict(text: string): number | undefined {
  const clean = stripAnsi(text);
  for (const pattern of PORT_IN_USE_PATTERNS) {
    const match = pattern.exec(clean);
    if (match) {
      const port = Number(match[1]);
      if (port > 0 && port < 65536) {
        return port;
      }
    }
  }
  return undefined;
}

/**
 * Some tools (Django, plain Python sockets) report the conflict without the port. In that
 * case the port is read from the command that was run, e.g. `--port 8000` or `runserver 8000`.
 */
export function portFromCommand(commandLine: string): number | undefined {
  const patterns = [
    /(?:--port|-p)(?:=|\s+)(\d{2,5})\b/,
    /\brunserver\s+(?:[\d.]+:)?(\d{2,5})\b/,
    /\bPORT=(\d{2,5})\b/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(commandLine);
    if (match) {
      return Number(match[1]);
    }
  }
  if (/manage\.py\s+runserver/.test(commandLine)) {
    return 8000;
  }
  return undefined;
}

/** True when the text reports a port conflict without naming the port. */
export function hasUnnamedPortConflict(text: string): boolean {
  return /That port is already in use|\[Errno (?:48|98|10048)\]|address already in use/i.test(stripAnsi(text));
}
