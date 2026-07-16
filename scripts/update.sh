#!/usr/bin/env bash
# Update a deployed Hoopedorc instance in place. The manual default remains
# interactive; F50's UI calls the same script with fail-closed non-interactive
# flags from a separate transient systemd unit so the updater survives the
# main service restart.
set -Eeuo pipefail

NON_INTERACTIVE=0
REQUIRE_MAIN=0
REQUIRE_SYSTEMD_RESTART=0
STATUS_FILE=""
STARTED_AT=""
UPDATE_UNIT="${HOOPEDORC_UPDATE_UNIT:-hoopedorc-self-update.service}"

usage() {
  cat <<'USAGE'
Usage: bash scripts/update.sh [options]

  --non-interactive          Never prompt; fail when safety cannot be proven
  --require-main             Refuse unless the checkout is on branch main
  --require-systemd-restart  Refuse unless hoopedorc.service serves this checkout
  --status-file <path>       Atomically persist machine-readable update progress
  --started-at <ISO time>    Preserve the launch timestamp supplied by the server
  -h, --help                 Show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive)
      NON_INTERACTIVE=1
      shift
      ;;
    --require-main)
      REQUIRE_MAIN=1
      shift
      ;;
    --require-systemd-restart)
      REQUIRE_SYSTEMD_RESTART=1
      shift
      ;;
    --status-file)
      [ $# -ge 2 ] || { echo "--status-file requires a path" >&2; exit 1; }
      STATUS_FILE="$2"
      shift 2
      ;;
    --started-at)
      [ $# -ge 2 ] || { echo "--started-at requires an ISO timestamp" >&2; exit 1; }
      STARTED_AT="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

if [ -n "$STATUS_FILE" ] && [[ "$STATUS_FILE" != /* ]]; then
  echo "--status-file must be an absolute path" >&2
  exit 1
fi

iso_now() {
  date -u +%Y-%m-%dT%H:%M:%S.000Z
}

[ -n "$STARTED_AT" ] || STARTED_AT="$(iso_now)"
from_commit=""
to_commit=""
current_step="checking deployment safety"

write_status() {
  [ -n "$STATUS_FILE" ] || return 0
  local state="$1"
  local message="$2"
  local finished_at="${3:-}"
  local updated_at
  updated_at="$(iso_now)"

  # The JavaScript template literals below belong to Node, not the shell.
  # shellcheck disable=SC2016
  if ! node -e '
const fs = require("node:fs");
const path = require("node:path");
const [
  file,
  state,
  message,
  startedAt,
  updatedAt,
  finishedAt,
  fromCommit,
  toCommit,
  updateUnit,
] = process.argv.slice(1);
const status = { state, message, startedAt, updatedAt, updateUnit };
if (finishedAt) status.finishedAt = finishedAt;
if (fromCommit) status.fromCommit = fromCommit;
if (toCommit) status.toCommit = toCommit;
fs.mkdirSync(path.dirname(file), { recursive: true });
const temp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
fs.renameSync(temp, file);
' \
    "$STATUS_FILE" \
    "$state" \
    "$message" \
    "$STARTED_AT" \
    "$updated_at" \
    "$finished_at" \
    "$from_commit" \
    "$to_commit" \
    "$UPDATE_UNIT"; then
    echo "Warning: could not persist update status to $STATUS_FILE" >&2
  fi
}

fail() {
  local message="$1"
  local finished_at
  finished_at="$(iso_now)"
  trap - ERR
  write_status "failed" "$message Inspect journalctl -u $UPDATE_UNIT." "$finished_at"
  echo "$message" >&2
  exit 1
}

on_error() {
  local exit_code=$?
  trap - ERR
  local message="Update failed while $current_step."
  local finished_at
  finished_at="$(iso_now)"
  write_status "failed" "$message Inspect journalctl -u $UPDATE_UNIT." "$finished_at"
  echo "$message" >&2
  exit "$exit_code"
}
trap on_error ERR

echo "Hoopedorc update"
echo
write_status "checking" "Checking Git, project activity, and the serving systemd unit."

# 1. Refuse on a dirty tree. Capture first so a Git failure is an actual
# update failure rather than being mistaken for a clean checkout.
git_status="$(git status --porcelain --untracked-files=normal)"
if [ -n "$git_status" ]; then
  fail "Refusing to update: the working tree has uncommitted or untracked changes."
fi

branch="$(git branch --show-current)"
from_commit="$(git rev-parse --short HEAD)"
if [ "$REQUIRE_MAIN" = "1" ] && [ "$branch" != "main" ]; then
  fail "Refusing to update: the deployed checkout must be on main (currently ${branch:-detached})."
fi

# 2. Resolve the restart target before changing the checkout. The UI path
# requires an exact match; the manual path preserves the historical
# build-only fallback when no matching unit is installed.
systemd_match=0
unit_dir=""
if command -v systemctl >/dev/null 2>&1 && \
   systemctl list-unit-files 'hoopedorc.service' 2>/dev/null | grep -q '^hoopedorc\.service'; then
  unit_dir="$(systemctl show hoopedorc.service -p WorkingDirectory --value 2>/dev/null || true)"
  if [ "$unit_dir" = "$here" ]; then
    systemd_match=1
  fi
fi

if [ "$REQUIRE_SYSTEMD_RESTART" = "1" ] && [ "$systemd_match" != "1" ]; then
  fail "Refusing to update: hoopedorc.service does not serve this exact checkout ($here)."
fi

if [ "$REQUIRE_SYSTEMD_RESTART" = "1" ] && [ "$(id -u)" -ne 0 ]; then
  if ! sudo -n -l systemctl restart hoopedorc.service >/dev/null 2>&1; then
    fail "Refusing to update: the service user cannot restart hoopedorc.service without a password."
  fi
fi

# 3. Refuse or confirm if anything is currently running. Reads
# PORT/API_TOKEN from .env; the non-interactive UI path fails closed when the
# server cannot be reached because it cannot prove the project set is idle.
port="4317"
token=""
if [ -f .env ]; then
  env_port="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2- || true)"
  [ -n "$env_port" ] && port="$env_port"
  token="$(grep -E '^API_TOKEN=' .env | tail -1 | cut -d= -f2- || true)"
fi

if [ -n "$token" ]; then
  projects_json="$(curl -fsS --max-time 3 -H "Authorization: Bearer $token" "http://127.0.0.1:${port}/api/projects" 2>/dev/null || true)"
else
  projects_json="$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/api/projects" 2>/dev/null || true)"
fi

project_state=""
if [ -n "$projects_json" ]; then
  project_state="$(
    node -e '
const fs = require("node:fs");
try {
  const body = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!body || !Array.isArray(body.projects)) process.exit(2);
  process.stdout.write(
    body.projects.some((project) => project?.status === "running")
      ? "running"
      : "idle",
  );
} catch {
  process.exit(2);
}
' <<<"$projects_json" 2>/dev/null || true
  )"
fi

if [ -z "$projects_json" ]; then
  if [ "$NON_INTERACTIVE" = "1" ]; then
    fail "Refusing to update: the server is unreachable, so active projects cannot be ruled out."
  fi
  echo "(Server not reachable on 127.0.0.1:${port} — skipping the running-project check.)"
elif [ "$project_state" != "idle" ] && [ "$project_state" != "running" ]; then
  if [ "$NON_INTERACTIVE" = "1" ]; then
    fail "Refusing to update: the server response could not prove that every project is idle."
  fi
  echo "(Server response did not contain a project list — skipping the running-project check.)"
elif [ "$project_state" = "running" ]; then
  if [ "$NON_INTERACTIVE" = "1" ]; then
    fail "Refusing to update: at least one project is currently running."
  fi
  echo "Warning: at least one project is currently running." >&2
  echo "Updating restarts the server, aborting any active task." >&2
  read -r -p "Continue anyway? [y/N] " reply
  case "$reply" in
    [yY] | [yY][eE][sS]) ;;
    *) fail "Update aborted by the operator." ;;
  esac
fi
echo

# 4. Pull + rebuild. --ff-only refuses a merge when local and upstream
# diverge. Every phase is durable so reconnecting after restart shows exactly
# where a failure occurred.
current_step="pulling the latest commit"
write_status "pulling" "Pulling the configured main upstream with fast-forward only."
echo "Pulling latest..."
git pull --ff-only
to_commit="$(git rev-parse --short HEAD)"
echo

current_step="installing dependencies"
write_status "installing" "Installing the exact lockfile dependencies with npm ci."
echo "Installing dependencies..."
npm ci
echo

current_step="building the production app"
write_status "building" "Building every workspace before the service restart."
echo "Building..."
npm run build
echo

# 5. Restart only the exact unit resolved before the update. In F50's UI path
# the script itself is already in a separate transient unit, so
# hoopedorc.service's KillMode=control-group cannot kill this updater.
if [ "$systemd_match" = "1" ]; then
  current_step="restarting hoopedorc.service"
  write_status "restarting" "Build complete. Gracefully restarting hoopedorc.service."
  echo "Restarting hoopedorc.service..."
  if [ "$(id -u)" -eq 0 ]; then
    systemctl restart hoopedorc.service
  elif [ "$NON_INTERACTIVE" = "1" ]; then
    sudo -n systemctl restart hoopedorc.service
  else
    sudo systemctl restart hoopedorc.service
  fi
  finished_at="$(iso_now)"
  write_status "succeeded" "Update completed and Hoopedorc restarted successfully." "$finished_at"
  echo "Done — restarted via systemd."
elif [ -n "$unit_dir" ]; then
  finished_at="$(iso_now)"
  write_status "succeeded" "Dependencies updated and built; an unrelated Hoopedorc unit was left untouched." "$finished_at"
  echo "Done — dependencies updated and rebuilt."
  echo "A hoopedorc.service unit exists on this box, but its WorkingDirectory"
  echo "(${unit_dir:-<unset>}) isn't this checkout ($here) — leaving it alone"
  echo "rather than restarting an unrelated deployment. Restart this checkout's"
  echo "own process yourself if it's the one actually serving traffic."
else
  finished_at="$(iso_now)"
  write_status "succeeded" "Dependencies updated and built; no systemd service was installed." "$finished_at"
  echo "Done — dependencies updated and rebuilt."
  echo "No hoopedorc systemd unit found on this box: restart the server yourself"
  echo "(however you normally run it — npm run start, a process manager, etc)."
fi
