# Changelog

## 0.2.1

- Fixed the version and install badges at the top of the Marketplace page, which showed "retired badge" after the badge service dropped support.

## 0.2.0

- **Run Again:** after freeing a port from the "port in use" popup, rerun the command that failed in the same terminal.
- **Auto-free (opt-in):** `portside.autoFreePortsFromThisProject` stops stale servers from the open project without asking.
- **Docker:** ports published by containers show the container's name and image, and Stop runs `docker stop`. Supports Docker Desktop, OrbStack, Colima, Rancher Desktop and Podman; on Linux, published ports appear even when the forwarder runs as root.
- **Stop All Servers in This Project** (sidebar button) and **Stop All Dev Servers**.
- **Remote:** in SSH, WSL and Dev Container windows Portside runs on the remote side, and Open in Browser forwards the port.
- **Windows:** servers are matched to the open project from their command line.
- Tested on every change on macOS, Linux and Windows with real servers, plus a real Docker container on Linux.

## 0.1.2

- Projects opened through a symlinked folder (for example `~/code` linked to another drive, or anything under `/tmp` on macOS) now show their servers under "This project".
- New `npm run demo` script that starts sample dev servers, for trying Portside without your own projects.
- New demo animation and sidebar screenshot on the Marketplace page, and clearer search wording.

## 0.1.1

- Servers started from your home folder (for example a quick `npx http-server` in a new terminal) no longer show your home folder as their project.
- Added a screenshot to the Marketplace page, plus links to report issues.

## 0.1.0

- First release: sidebar of localhost servers grouped by project, readable names for common frameworks, open/copy/reveal/stop/force kill, status bar count, and "port already in use" detection in terminals.
