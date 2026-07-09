#!/usr/bin/env bash
# One-command box setup for Hoopedorc on a fresh EC2 instance (or any
# comparable Amazon Linux 2023 / Ubuntu LTS box). Automates the
# non-interactive parts of docs/USER_GUIDE.md's "Deploying to EC2 —
# checklist" (steps 1-2 and 6): OS packages, swap on small instances, the
# repo clone, npm install/setup/build, and the systemd unit. Deliberately
# stops before the genuinely interactive parts (CLI logins, .env editing,
# tailscale serve — checklist steps 3-5) and prints exactly what to do next
# instead of guessing at them.
#
# Usage:
#   bash deploy/ec2-bootstrap.sh [--dir /opt/hoopedorc] [--repo <git-url>] [--no-docker] [--dry-run]
#
# Safe to re-run on a partially-configured box: every step checks the
# current state (an installed package, an existing clone, existing swap, an
# existing systemd unit, ...) before acting, rather than assuming a blank
# machine — the same B27 lesson update.sh already follows: detect by
# output/state, not by assuming a fresh run.
set -euo pipefail

REPO_URL="https://github.com/IngeniousArtist/hoopedorc.git"
INSTALL_DIR="/opt/hoopedorc"
INSTALL_DOCKER=1
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: bash deploy/ec2-bootstrap.sh [options]

  --dir <path>   Where to clone/install Hoopedorc (default: /opt/hoopedorc)
  --repo <url>   Git URL to clone (default: the upstream repo — pass your
                 own fork's URL if you're deploying from one)
  --no-docker    Skip installing Docker (the gate sandbox falls back to
                 running gates on the host instead — see the USER_GUIDE's
                 "Gate sandbox" section)
  --dry-run      Print what each step would do without changing anything
  -h, --help     Show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --repo)
      REPO_URL="$2"
      shift 2
      ;;
    --no-docker)
      INSTALL_DOCKER=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
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

echo "Hoopedorc EC2 bootstrap"
echo

if [ "$(id -u)" -eq 0 ]; then
  echo "Warning: running as root. Hoopedorc (and the gh/claude/opencode CLIs" >&2
  echo "it drives) are meant to run as a normal user — re-run this as the" >&2
  echo "non-root user that will own the deployment (e.g. ec2-user/ubuntu) if" >&2
  echo "that wasn't intentional." >&2
fi
RUN_AS_USER="$(whoami)"
RUN_AS_GROUP="$(id -gn "$RUN_AS_USER")"

# 1a. Distro detection — only Amazon Linux 2023 and Ubuntu LTS are
# supported; anything else falls back to the manual checklist rather than
# guessing at an unfamiliar package manager.
DISTRO_ID="unknown"
if [ -f /etc/os-release ]; then
  # shellcheck source=/dev/null
  . /etc/os-release
  DISTRO_ID="${ID:-unknown}"
fi

case "$DISTRO_ID" in
  amzn | ubuntu) ;;
  *)
    echo "Unsupported distro: '$DISTRO_ID' — this script only supports Amazon Linux 2023 and Ubuntu LTS." >&2
    echo "Follow docs/USER_GUIDE.md's 'Deploying to EC2 — checklist' by hand instead." >&2
    exit 1
    ;;
esac
echo "Detected distro: $DISTRO_ID"
echo

# 1b. Node 22, git, Docker (optional). Each check-before-install so
# re-running this script on a box that already has some of these is a no-op
# for that piece.
node_is_22() {
  command -v node >/dev/null 2>&1 && [ "$(node -v | cut -d. -f1)" = "v22" ]
}

if node_is_22; then
  echo "Node $(node -v) already installed — skipping."
else
  echo "Installing Node.js 22..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would fetch and run NodeSource's setup_22.x script, then install the nodejs package"
  elif [ "$DISTRO_ID" = "amzn" ]; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo dnf install -y nodejs
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
    sudo apt-get install -y nodejs
  fi
fi
echo

if command -v git >/dev/null 2>&1; then
  echo "git already installed — skipping."
else
  echo "Installing git..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would install git via the distro package manager"
  elif [ "$DISTRO_ID" = "amzn" ]; then
    sudo dnf install -y git
  else
    sudo apt-get update && sudo apt-get install -y git
  fi
fi
echo

if [ "$INSTALL_DOCKER" = "1" ]; then
  if command -v docker >/dev/null 2>&1; then
    echo "Docker already installed — skipping."
  else
    echo "Installing Docker (via Docker's own get.docker.com install script)..."
    if [ "$DRY_RUN" = "1" ]; then
      echo "[dry-run] would install Docker and add $RUN_AS_USER to the docker group"
    else
      curl -fsSL https://get.docker.com | sudo sh
      sudo usermod -aG docker "$RUN_AS_USER"
      echo "Added $RUN_AS_USER to the docker group — log out and back in (or start a new shell) before relying on the gate sandbox."
    fi
  fi
else
  echo "Skipping Docker (--no-docker) — gates will fall back to running on the host."
fi
echo

# 1c. Swap on small instances — the build step (npm run build), not the
# running server, is what needs the headroom (see deploy/hoopedorc.service's
# own comments for the identical snippet used there).
total_mem_mb="$(free -m | awk '/^Mem:/{print $2}')"
if [ "$total_mem_mb" -ge 2048 ]; then
  echo "RAM is ${total_mem_mb}MB (>= 2GB) — no swap needed."
elif swapon --show --noheadings 2>/dev/null | grep -q .; then
  echo "RAM is ${total_mem_mb}MB and swap is already active — skipping."
else
  echo "RAM is ${total_mem_mb}MB (< 2GB) — adding a 2GB swapfile for the build step."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would: fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile (+ persist via /etc/fstab)"
  else
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    if ! grep -q '^/swapfile ' /etc/fstab; then
      echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    fi
  fi
fi
echo

# 2. Clone + install + setup + build.
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "$INSTALL_DIR already looks like a clone — skipping git clone."
else
  echo "Cloning $REPO_URL to $INSTALL_DIR..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would clone into $INSTALL_DIR and chown it to $RUN_AS_USER:$RUN_AS_GROUP"
  else
    sudo mkdir -p "$(dirname "$INSTALL_DIR")"
    sudo git clone "$REPO_URL" "$INSTALL_DIR"
    sudo chown -R "$RUN_AS_USER":"$RUN_AS_GROUP" "$INSTALL_DIR"
  fi
fi
echo

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] would run in $INSTALL_DIR: npm install; npm run setup; npm run build"
else
  echo "Installing npm dependencies..."
  (cd "$INSTALL_DIR" && npm install)
  echo
  # npm run setup checks gh/claude/opencode auth and exits non-zero if any
  # of them aren't authenticated yet — expected at this point (that's
  # checklist step 3, done by hand after this script), so don't let it
  # abort the bootstrap under set -e.
  echo "Running npm run setup (CLI auth checks below are expected to still be red — you'll fix those in step 3 printed at the end)..."
  (cd "$INSTALL_DIR" && npm run setup) || true
  echo
  echo "Building..."
  (cd "$INSTALL_DIR" && npm run build)
fi
echo

# 6. Systemd unit — templated with THIS user + INSTALL_DIR, enabled but not
# started yet (starting now would just crash-loop: no CLI auth, no .env
# review — checklist steps 3-5 come first). Never overwrite an existing
# unit: an operator may have already customized MemoryMax, User=, etc.
UNIT_PATH="/etc/systemd/system/hoopedorc.service"
if [ -f "$UNIT_PATH" ]; then
  echo "$UNIT_PATH already exists — leaving it as-is."
else
  echo "Installing the systemd unit ($UNIT_PATH)..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] would template deploy/hoopedorc.service (User=$RUN_AS_USER, WorkingDirectory=$INSTALL_DIR) to $UNIT_PATH"
  else
    sed \
      -e "s|User=YOUR_USERNAME|User=$RUN_AS_USER|" \
      -e "s|WorkingDirectory=/opt/hoopedorc|WorkingDirectory=$INSTALL_DIR|" \
      -e "s|EnvironmentFile=/opt/hoopedorc/.env|EnvironmentFile=$INSTALL_DIR/.env|" \
      "$INSTALL_DIR/deploy/hoopedorc.service" | sudo tee "$UNIT_PATH" >/dev/null
  fi
fi
echo

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] would: systemctl daemon-reload && systemctl enable hoopedorc"
else
  sudo systemctl daemon-reload
  sudo systemctl enable hoopedorc
fi

echo
echo "======================================================================"
echo "Bootstrap done. Remaining steps (docs/USER_GUIDE.md's EC2 checklist):"
echo
echo "  3. Authenticate the CLIs, in order, as this same user ($RUN_AS_USER):"
echo "       - GH_TOKEN in $INSTALL_DIR/.env (no interactive gh login needed)"
echo "       - claude setup-token"
echo "       - opencode auth login (or copy auth.json from a machine with a browser)"
echo "       - codex login — only if a model uses runner \"codex\""
echo "  4. Edit $INSTALL_DIR/.env — at minimum PORT, API_TOKEN, DB_BACKUP_DIR."
echo "  5. tailscale serve --bg <PORT>"
echo "  Then start it: sudo systemctl start hoopedorc"
echo "  Verify: open the app over your tailnet URL, check Setup & Health,"
echo "          tail logs with: journalctl -u hoopedorc -f"
echo
echo "Full detail: docs/USER_GUIDE.md, 'Deploying to EC2 — checklist'."
echo "======================================================================"
