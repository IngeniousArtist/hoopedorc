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
5. Copy `deploy/hoopedorc.service` to `/etc/systemd/system/hoopedorc.service`,
   editing `User=` and `WorkingDirectory=` for your setup.
6. `sudo systemctl daemon-reload && sudo systemctl enable --now hoopedorc`
7. `npm run start` (what the unit runs) builds every workspace and then
   starts `@orc/server`, which serves the built web app itself once
   `apps/web/dist` exists — one process, one port, nothing else to run.

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
