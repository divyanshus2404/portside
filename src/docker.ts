// Maps host ports to Docker containers, so a port held by Docker shows the container that
// published it (and can be stopped with `docker stop`) instead of "Docker".

export interface Container {
  id: string;
  name: string;
  image: string;
}

/** The format Portside asks `docker ps` for: one container per line, tab-separated. */
export const DOCKER_PS_FORMAT = '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}';

/**
 * Parses `docker ps --format <DOCKER_PS_FORMAT>` into host port → container. Ports look like
 * `0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp` or ranges `0.0.0.0:8000-8002->8000-8002/tcp`;
 * container-only ports (`6379/tcp`, not published) are skipped.
 */
export function parseDockerPs(output: string): Map<number, Container> {
  const result = new Map<number, Container>();
  for (const line of output.split('\n')) {
    const [id, name, image, ports] = line.split('\t');
    if (!id || !name || !ports) {
      continue;
    }
    const container = { id: id.trim(), name: name.trim(), image: (image ?? '').trim() };
    for (const mapping of ports.split(',')) {
      const match = /:(\d+)(?:-(\d+))?->/.exec(mapping.trim());
      if (!match) {
        continue;
      }
      const first = Number(match[1]);
      const last = match[2] ? Number(match[2]) : first;
      for (let port = first; port <= last && port - first < 1000; port++) {
        result.set(port, container);
      }
    }
  }
  return result;
}

/** Process names of Docker Desktop, OrbStack, Colima, Rancher Desktop and Podman port forwarders. */
export function isDockerForwarder(name: string, commandLine: string): boolean {
  return /com\.docker|docker-proxy|vpnkit|OrbStack|orbstack|limactl|colima|rancher|gvproxy|podman|wslrelay/i.test(`${name} ${commandLine}`);
}
