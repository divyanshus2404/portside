// Turns raw process information into names people recognize ("Next.js", "Vite", "Django")
// and decides which listeners are dev servers versus system or app services.

interface Rule {
  label: string;
  pattern: RegExp;
}

// Ordered: the first match wins, so more specific tools come before generic runtimes.
const SERVER_RULES: Rule[] = [
  { label: 'Next.js', pattern: /\bnext(?:-server)?\b(?:.*\b(?:dev|start)\b|\s*\(v)|[/\\]next[/\\]dist[/\\]/i },
  { label: 'Nuxt', pattern: /\bnuxi?\b.*\bdev\b|[/\\]nuxt[/\\]/i },
  { label: 'Astro', pattern: /\bastro\b.*\b(?:dev|preview)\b/i },
  { label: 'Remix', pattern: /\bremix\b.*\bdev\b/i },
  { label: 'SvelteKit', pattern: /svelte-kit/i },
  { label: 'Angular', pattern: /\bng\b.*\bserve\b|@angular[/\\]cli/i },
  { label: 'Create React App', pattern: /react-scripts\b.*\bstart\b/i },
  { label: 'Storybook', pattern: /storybook/i },
  { label: 'Gatsby', pattern: /\bgatsby\b.*\bdevelop\b/i },
  { label: 'Expo', pattern: /\bexpo\b.*\bstart\b/i },
  { label: 'Metro', pattern: /\bmetro\b|react-native.*\bstart\b/i },
  { label: 'Vite', pattern: /\bvite\b/i },
  { label: 'webpack dev server', pattern: /webpack(?:-dev-server|.*\bserve\b)/i },
  { label: 'Wrangler', pattern: /\bwrangler\b/i },
  { label: 'Netlify Dev', pattern: /\bnetlify\b.*\bdev\b/i },
  { label: 'Firebase Emulators', pattern: /firebase.*emulators|cloud-firestore-emulator/i },
  { label: 'json-server', pattern: /json-server/i },
  { label: 'Prisma Studio', pattern: /prisma.*\bstudio\b/i },
  { label: 'Django', pattern: /manage\.py\s+runserver|\bdjango\b/i },
  { label: 'Uvicorn', pattern: /\buvicorn\b/i },
  { label: 'Gunicorn', pattern: /\bgunicorn\b/i },
  { label: 'FastAPI', pattern: /\bfastapi\b\s+(?:dev|run)/i },
  { label: 'Flask', pattern: /\bflask\b.*\brun\b/i },
  { label: 'Streamlit', pattern: /\bstreamlit\b/i },
  { label: 'Gradio', pattern: /\bgradio\b/i },
  { label: 'Jupyter', pattern: /\bjupyter|ipykernel/i },
  { label: 'Python http.server', pattern: /-m\s+http\.server/i },
  { label: 'Rails', pattern: /\brails\b.*\b(?:server|s)\b|\bpuma\b/i },
  { label: 'Laravel', pattern: /artisan\s+serve/i },
  { label: 'PHP server', pattern: /\bphp\b.*\s-S\s/i },
  { label: 'Hugo', pattern: /\bhugo\b.*\bserver\b/i },
  { label: 'Jekyll', pattern: /\bjekyll\b.*\bserve\b/i },
  { label: 'Spring Boot', pattern: /spring-boot|org\.springframework/i },
  { label: 'PostgreSQL', pattern: /\bpostgres(?:ql)?\b/i },
  { label: 'MySQL', pattern: /\bmysqld\b/i },
  { label: 'Redis', pattern: /\bredis-server\b/i },
  { label: 'MongoDB', pattern: /\bmongod\b/i },
  { label: 'Ollama', pattern: /\bollama\b/i },
  { label: 'Docker', pattern: /com\.docker|docker-proxy|\bvpnkit\b/i },
];

// Runtimes and servers that indicate a developer-started process.
const DEV_RUNTIMES = /^(?:node|nodejs|bun|deno|python\d*(?:\.\d+)?|ruby|php|java|go|dotnet|beam\.smp|erl|elixir|uvicorn|gunicorn|cargo|rustc|postgres|mysqld|redis-server|mongod|ollama|nginx|httpd|caddy|hugo|com\.docker\.\S*|docker\S*|vpnkit\S*)$/i;

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** The executable's short name, e.g. `node` for `/opt/homebrew/bin/node`. */
export function executableName(commandLine: string, fallback = ''): string {
  const first = commandLine.trim().match(/^"([^"]+)"|^(\S+)/);
  const executable = first ? (first[1] ?? first[2]) : fallback;
  return basename(executable).replace(/\.exe$/i, '') || fallback;
}

/** A recognizable name for the server, or undefined when nothing specific matched. */
export function knownServer(commandLine: string): string | undefined {
  return SERVER_RULES.find((rule) => rule.pattern.test(commandLine))?.label;
}

/**
 * The best short label for a listening process: a known framework, a macOS service with a
 * familiar name, or the executable plus its script (e.g. `node server.js`).
 */
export function describeProcess(commandLine: string, name: string, port: number): string {
  if (isAirPlayReceiver(name, port)) {
    return 'AirPlay Receiver (macOS)';
  }
  const known = knownServer(commandLine);
  if (known) {
    return known;
  }
  // macOS app paths contain spaces ("/Applications/Visual Studio Code.app/..."), so name the app
  // bundle. Runtimes such as Homebrew's Python also live in a bundle; those keep their script name.
  const appBundle = /([^/]+)\.app\/Contents\//.exec(commandLine);
  if (appBundle && !DEV_RUNTIMES.test(appBundle[1])) {
    return appBundle[1];
  }
  const executable = executableName(commandLine, name);
  const script = commandLine
    .trim()
    .split(/\s+/)
    .slice(1)
    .find((argument) => !argument.startsWith('-') && /\.[a-z]{1,4}$/i.test(argument));
  return script ? `${executable} ${basename(script)}` : executable || name || 'Unknown process';
}

/** True for macOS Control Center's AirPlay Receiver, which takes ports 5000 and 7000. */
export function isAirPlayReceiver(name: string, port: number): boolean {
  return /^ControlCe/i.test(name) && (port === 5000 || port === 7000);
}

/** Whether a listener looks like something a developer started, rather than an app or OS service. */
export function isDevProcess(commandLine: string, name: string, insideWorkspace: boolean): boolean {
  if (insideWorkspace) {
    return true;
  }
  if (knownServer(commandLine)) {
    return true;
  }
  return DEV_RUNTIMES.test(executableName(commandLine, name)) || DEV_RUNTIMES.test(name);
}
