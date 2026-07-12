# Deployment (F10)

Hoopedorc shells out to three CLIs that expect **interactive login on a real
host**: `gh`, `claude`, and `opencode`. That's why **native + systemd is the
primary, supported path** — you log in once, on the box that will run the
app, the normal way. The Dockerfile/compose file here are provided as a
reference starting point, not a turnkey solution; they have **not** been
built/run against a live Docker daemon (none was available while writing
this) — treat them as a documented starting point to adapt, not a verified
recipe.

## Native + systemd (recommended)

On Amazon Linux 2023 or Ubuntu LTS, `deploy/ec2-bootstrap.sh` automates
steps 1–2 and 6 below (OS packages including the `gh`/`claude`/`opencode`
CLIs, swap, clone, install/setup/build, and the systemd unit) — see
USER_GUIDE's
[Deploying to EC2 — checklist](../docs/USER_GUIDE.md#deploying-to-ec2--checklist)
for the one-command version. The manual steps:

1. Clone the repo onto the box, e.g. `/opt/hoopedorc`.
2. `cd /opt/hoopedorc && npm install`
3. `npm run setup` — creates `.env` from `.env.example` if missing, and
   checks `gh`/`claude`/`opencode` auth. Fix anything it flags (`gh auth
   login`, `claude` interactive login once, `opencode auth login`) — do this
   as the **same OS user** the systemd service will run as, since all three
   CLIs store their login under that user's home directory. If a CLI is
   missing entirely, install `claude`/`opencode` via `npm install -g` (not
   their curl installers) so the binaries land on the systemd unit's
   default `PATH` — `deploy/ec2-bootstrap.sh` does this for you.
4. Edit `.env` — at minimum decide `HOST`/`PORT`; set `API_TOKEN` if `HOST`
   will be anything other than `127.0.0.1` (the server refuses to boot
   otherwise — see the main README's Security section).
5. `npm run build` — the unit itself doesn't build (see step 7); do it once
   here so `apps/web/dist` exists before the first start.
6. Copy `deploy/hoopedorc.service` to `/etc/systemd/system/hoopedorc.service`,
   editing `User=` and `WorkingDirectory=` for your setup.
7. `sudo systemctl daemon-reload && sudo systemctl enable --now hoopedorc`
8. The unit runs `npm run start:prebuilt` (serve only — starts `@orc/server`,
   which serves the already-built web app itself on the same port, one
   process, one port, nothing else to run) rather than `npm run start`
   (build + serve): rebuilding on every restart costs minutes and risks OOM
   on a small instance. `npm run update` (see `docs/USER_GUIDE.md`) rebuilds
   for you on future deploys, so you only run `npm run build` by hand once,
   here.

For the full ordered walkthrough (instance sizing, all CLI auths, `.env`,
Tailscale, first-boot verification) see USER_GUIDE's
[Deploying to EC2 — checklist](../docs/USER_GUIDE.md#deploying-to-ec2--checklist).

Persistence: the SQLite DB (`DB_PATH`, default `./hoopedorc.db`) and cloned
repos (`REPOS_DIR`, default `~/.hoopedorc/repos`) both need to survive
restarts and deploys — back them up, or point them at a persistent volume/disk
if the box itself is ephemeral.

## Docker (reference only — see caveats)

`deploy/Dockerfile` builds the app and installs `gh`/`claude`/`opencode`
inside the image, but **none of them are authenticated there** — auth must
come from the host at runtime:

- **`gh`**: mount your host's `~/.config/gh` read-only, *or* set `GH_TOKEN` in
  `.env` (`gh` reads it natively — no file needed).
- **`opencode`**: mount `~/.local/share/opencode` (verified on macOS to hold
  `auth.json`/`account.json`; the exact path can differ by OS/install
  method — run `opencode auth list` on the host and check its docs if this
  path doesn't match your setup).
- **`claude`**: **on macOS, Claude Code's login lives in the system
  Keychain** (verified: `security find-generic-password -s "Claude
  Code-credentials"` finds it there), not a plain file — a Linux container
  has no access to it at all, mountable or not. The container-friendly path
  is instead to set **`ANTHROPIC_API_KEY`** in `.env`; `claude --help`
  documents a `--bare` mode whose auth is "strictly `ANTHROPIC_API_KEY` or
  `apiKeyHelper`... OAuth and keychain are never read" — confirming API-key
  auth is the intended non-interactive path. **Caveat:** this bills
  pay-per-token via the Anthropic Console, not your Pro/Max subscription's
  flat rate — a real cost-model difference from running `claude` natively
  logged into a subscription, worth knowing before you rely on it.

```bash
cp .env.example .env   # then edit it — HOST=0.0.0.0, GH_TOKEN/ANTHROPIC_API_KEY, etc.
docker compose -f deploy/docker-compose.yml up --build
```

The compose file mounts a named volume at `/data` for the DB + cloned repos
(`DB_PATH`/`REPOS_DIR` are pre-set to `/data/...` in the Dockerfile) so they
survive container recreation.

## Always-on / remote access

If this runs somewhere you reach over Tailscale (the deployment target this
project was designed around — see `docs/PRODUCTIZATION_PLAN.md`), bind
`HOST` to the tailnet interface (or `0.0.0.0` behind a security group that
only allows the tailnet) and set `API_TOKEN`. See the main README's Security
section and `docs/USER_GUIDE.md` for the full remote-setup walkthrough.
