#!/usr/bin/env bash
# Update a deployed Hoopedorc instance in place: refuse on a dirty tree, warn
# (and ask) if any project is currently running, then git pull --ff-only +
# npm ci + build, restarting the systemd service if one is installed.
# See docs/USER_GUIDE.md's "Updating" section.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

echo "Hoopedorc update"
echo

# 1. Refuse on a dirty tree — this script's own git pull would otherwise
# either fail confusingly or, worse, silently merge over local edits.
if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to update: the working tree has uncommitted changes." >&2
  echo "Commit, stash, or discard them first, then re-run this script." >&2
  exit 1
fi

# 2. Warn if anything is currently running — updating mid-run restarts the
# process and aborts whatever's in flight. Reads PORT/API_TOKEN from .env if
# present; tolerates the server being down entirely (nothing to warn about).
port="4317"
token=""
if [ -f .env ]; then
  env_port="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2- || true)"
  [ -n "$env_port" ] && port="$env_port"
  token="$(grep -E '^API_TOKEN=' .env | tail -1 | cut -d= -f2- || true)"
fi

if [ -n "$token" ]; then
  projects_json="$(curl -s --max-time 3 -H "Authorization: Bearer $token" "http://127.0.0.1:${port}/api/projects" 2>/dev/null || true)"
else
  projects_json="$(curl -s --max-time 3 "http://127.0.0.1:${port}/api/projects" 2>/dev/null || true)"
fi
if [ -n "$projects_json" ] && echo "$projects_json" | grep -q '"status":"running"'; then
  echo "Warning: at least one project is currently running." >&2
  echo "Updating restarts the server, aborting any active task." >&2
  read -r -p "Continue anyway? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted." >&2; exit 1 ;;
  esac
elif [ -z "$projects_json" ]; then
  echo "(Server not reachable on 127.0.0.1:${port} — skipping the running-project check.)"
fi
echo

# 3. Pull + rebuild. --ff-only refuses a merge if local and remote diverged
# (shouldn't happen given the dirty-tree check above ran first, but a
# rebase/force-push upstream could still cause it) rather than creating a
# merge commit on a deployed box.
echo "Pulling latest..."
git pull --ff-only
echo
echo "Installing dependencies..."
npm ci
echo
echo "Building..."
npm run build
echo

# 4. Restart: prefer the systemd unit if this box has one installed
# (deploy/hoopedorc.service); otherwise this is as far as an update can go
# automatically — print the manual restart instruction instead of guessing
# how this instance is actually being run (npm run start in a screen/tmux
# session, some other process manager, etc).
#
# B27: detection is output-based, not exit-code-based — on some systemd
# versions `list-unit-files <pattern>` exits 0 even on zero matches
# (printing "0 unit files listed." rather than failing), which would have
# made this branch fire `sudo systemctl restart` against a unit that
# doesn't exist. NOT verified against a real systemd box in this
# environment (macOS has none installed) — verify on your box before
# relying on it, the same rule the Remote setup section's tailscale
# commands already follow.
if command -v systemctl >/dev/null 2>&1 && \
   systemctl list-unit-files 'hoopedorc.service' 2>/dev/null | grep -q '^hoopedorc\.service'; then
  echo "Restarting hoopedorc.service..."
  sudo systemctl restart hoopedorc
  echo "Done — restarted via systemd."
else
  echo "Done — dependencies updated and rebuilt."
  echo "No hoopedorc systemd unit found on this box: restart the server yourself"
  echo "(however you normally run it — npm run start, a process manager, etc)."
fi
