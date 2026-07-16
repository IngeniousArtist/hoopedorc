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
steps 1–2 and 6 below (OS packages, swap, clone, install/setup/build, and
the systemd unit) — see USER_GUIDE's
[Deploying to EC2 — checklist](../docs/USER_GUIDE.md#deploying-to-ec2--checklist)
for the one-command version. The manual steps:

1. Clone the repo onto the box, e.g. `/opt/hoopedorc`.
2. `cd /opt/hoopedorc && npm install`
3. `npm run setup` — creates `.env` from `.env.example` if missing, and
   checks `gh`/`claude`/`opencode` auth. Fix anything it flags (`gh auth
   login`, `claude` interactive login once, `opencode auth login`) — do this
   as the **same OS user** the systemd service will run as, since all three
   CLIs store their login under that user's home directory.
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

After that first deployment, Setup & Health exposes **Update Hoopedorc** when
the service user can launch `sudo -n systemd-run`, the checkout is clean on
`main`, `API_TOKEN` is present in `.env` when auth is enabled, and the installed
unit's exact `WorkingDirectory` matches the checkout. It runs the same guarded
`scripts/update.sh` in a separate transient unit, so restarting
`hoopedorc.service` cannot kill the updater. Hardened boxes that deliberately
deny passwordless systemd launch keep the button disabled and continue using
`npm run update` over SSH.

The unit gives Hoopedorc 25 seconds to handle `SIGTERM`. The app immediately
refuses new mutations, cancels active model/gate/setup processes, waits up to
15 seconds for all project and rollback runtimes together, stops Telegram,
flushes logs, checkpoints SQLite's WAL, records a shutdown audit entry, and
exits zero. Fatal exceptions use the same cleanup but exit nonzero so
`Restart=on-failure` brings the service back. `KillMode=control-group` remains
the final guard against an orphaned CLI if the process cannot finish cleanup.
The self-updater is intentionally launched as a different transient systemd
unit, outside this control group, before it restarts the main service.

For the full ordered walkthrough (instance sizing, all CLI auths, `.env`,
Tailscale, first-boot verification) see USER_GUIDE's
[Deploying to EC2 — checklist](../docs/USER_GUIDE.md#deploying-to-ec2--checklist).

Persistence: the SQLite DB (`DB_PATH`, default `./hoopedorc.db`) and cloned
repos (`REPOS_DIR`, default `~/.hoopedorc/repos`) both need to survive
restarts and deploys — back them up, or point them at a persistent volume/disk
if the box itself is ephemeral.

## Docker (reference only — see caveats)

`deploy/Dockerfile` builds the app and installs `gh`/`claude`/`opencode`
inside the image, but **none of them are authenticated there**. This reference
compose file is not a supported model-execution deployment: S10 intentionally
does not forward provider-key environment variables, and a Linux container
cannot consume a macOS Keychain login. Use the native same-user deployment for
real runs. The remaining mounts only illustrate what a future container design
would need for the more portable CLIs:

- **`gh`**: mount your host's `~/.config/gh` read-only, *or* set `GH_TOKEN` in
  `.env` (`gh` reads it natively — no file needed).
- **`opencode`**: mount `~/.local/share/opencode` (verified on macOS to hold
  `auth.json`/`account.json`; the exact path can differ by OS/install
  method — run `opencode auth list` on the host and check its docs if this
  path doesn't match your setup).
- **`claude`**: **on macOS, Claude Code's login lives in the system
  Keychain** (verified: `security find-generic-password -s "Claude
  Code-credentials"` finds it there), not a plain file — a Linux container
  has no access to it at all, mountable or not. Hoopedorc does not accept an
  `ANTHROPIC_API_KEY` fallback, so this remains the blocking reason full-app
  Docker is reference-only.

```bash
cp .env.example .env   # then edit it — HOST=0.0.0.0, API_TOKEN, GH_TOKEN, etc.
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
