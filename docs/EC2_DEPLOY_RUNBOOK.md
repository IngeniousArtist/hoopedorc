# EC2 deploy runbook — deploy day, start to finish

This is the owner's ordered path for the v0.5.0 EC2 deploy: everything to
do, in order, from the AWS console to supervising the box from your phone.
It adds the AWS-side steps the other docs assume (launching the instance,
security group, Tailscale install) and folds in the live verifications
Part 8 still owes. For depth on any step it links out rather than
duplicating:

- [USER_GUIDE — Deploying to EC2 checklist](USER_GUIDE.md#deploying-to-ec2--checklist) — the canonical step list
- [USER_GUIDE — EC2 / headless Linux](USER_GUIDE.md#ec2--headless-linux) — CLI auth detail
- [deploy/README.md](../deploy/README.md) — systemd/Docker specifics

Estimated time: ~45–60 minutes, most of it waiting on installs and OAuth
round-trips.

## 0. Before you touch AWS

Have these ready so the interactive steps don't stall you mid-deploy:

- [ ] A **fine-grained GitHub PAT** scoped to the repos Hoopedorc will work
      on (repo contents + pull requests, read/write). This becomes
      `GH_TOKEN` — no `gh auth login` needed on the box.
- [ ] Your **Claude Pro/Max subscription** login handy (for
      `claude setup-token`).
- [ ] Your **opencode provider logins** (and ChatGPT login, only if you use
      a `codex`-runner model).
- [ ] A **Tailscale account** with the client already installed on your Mac
      and phone.
- [ ] Your **Telegram bot token + chat id** (recommended: create a *new*
      bot via @BotFather just for the EC2 box, so alerts are labeled by
      sender — see [the two-box note](USER_GUIDE.md#two-boxes-ec2-for-webextensions-your-mac-for-apple-targets)).

## 1. Launch the instance

In the EC2 console:

- **AMI**: Amazon Linux 2023 or Ubuntu LTS (22.04/24.04). These are the two
  distros `deploy/ec2-bootstrap.sh` supports; anything else means doing the
  checklist by hand.
- **Instance type**: `t3.small` (2 GB RAM) is the sensible floor. The
  *build* step is what needs memory, not the running server; on anything
  under 2 GB the bootstrap script adds swap automatically, so `t3.micro`
  works but builds slowly.
- **Storage**: 20 GB gp3 or more — the app plus cloned repos plus
  `node_modules` plus (optionally) Docker images add up.
- **Key pair**: create/choose one for the initial SSH.
- **Security group**: inbound **SSH (22) from your current IP only**.
  Do **not** open port 4317 (or any app port) to anything — Tailscale is
  the access path, and it needs no inbound rules at all.

## 2. Tailscale first

SSH in with the key pair, then:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```

Approve the box in your Tailscale admin console. `--ssh` enables Tailscale
SSH so future logins don't depend on the key pair or the security-group IP
rule — once you've confirmed `ssh <box-tailnet-name>` works from your Mac,
you can tighten the security group's port-22 rule (or remove it entirely
and rely on Tailscale SSH).

## 3. Bootstrap (the automated part)

```bash
# AL2023 doesn't preinstall git (the bootstrap script would install it,
# but you need git to fetch the script — chicken and egg):
sudo dnf install -y git        # Ubuntu, if missing: sudo apt-get update && sudo apt-get install -y git

sudo git clone https://github.com/IngeniousArtist/hoopedorc.git /opt/hoopedorc
sudo chown -R "$(whoami)": /opt/hoopedorc
cd /opt/hoopedorc
bash deploy/ec2-bootstrap.sh --dry-run   # preview what it will do
bash deploy/ec2-bootstrap.sh             # then for real
```

This installs Node 22 / git / the `gh`, `claude`, and `opencode` CLIs /
Docker, adds swap if RAM < 2 GB, runs
`npm install && npm run setup && npm run build`, and installs + enables
(but does not start) the systemd unit. It's idempotent — safe to re-run if
anything fails partway. `--no-docker` if you don't want the gate sandbox.

(`claude`/`opencode` are installed npm-global on purpose: that puts them in
`/usr/bin`, which systemd's default `PATH` can see. The vendors' curl
installers put them in `~/.local/bin`/`~/.opencode/bin` — those work over
SSH but the service unit would never find them.)

> **Owed verification (F42):** this is the script's first run on a real
> EC2 box — it was verified via shellcheck and `--dry-run` only. If any
> step misbehaves, paste the output back into a Claude session so the
> script gets fixed against reality.

## 4. CLI auth (the interactive part)

The CLIs themselves are already installed (bootstrap, step 3) — this step
is only the logins. The script stops and prints these; do them **as the
same OS user** that ran the bootstrap (the systemd unit is templated to
that user). Order per
[the checklist](USER_GUIDE.md#deploying-to-ec2--checklist):

1. **`gh`** — nothing to run; you'll set `GH_TOKEN` in `.env` in step 5.
2. **`claude setup-token`** — completes via a URL you open in your Mac's
   browser; bills your subscription's flat rate, not per-token.
3. **`opencode auth login`** — try it over SSH first (most provider flows
   print a URL you can open elsewhere); if a flow truly needs a local
   browser, run it on your Mac and copy `~/.local/share/opencode/auth.json`
   to the box (`scp`, same path, same user).
4. **`codex login`** — only if a model uses runner `codex`. Install it
   first (`sudo npm install -g @openai/codex` — the bootstrap skips it);
   same copy-the-credential-file pattern (`~/.codex/auth.json`).

Then confirm: `npm run setup` — every CLI check should pass.

## 5. `.env`

`npm run setup` already created `.env` from the example. Edit it:

```bash
# Required / strongly recommended
GH_TOKEN=<your fine-grained PAT>
API_TOKEN=<long random string>        # e.g. openssl rand -hex 32
TELEGRAM_BOT_TOKEN=<the box's bot>
TELEGRAM_CHAT_ID=<your chat id>

# Leave these alone
HOST=127.0.0.1                        # Tailscale Serve provides reach; never widen this
PORT=4317
```

Leave provider keys empty for any provider you log into via opencode
OAuth. `DB_PATH`/`DB_BACKUP_DIR` defaults are fine (DB lands at
`/opt/hoopedorc/hoopedorc.db`, backups in `backups/` beside it).

## 6. Serve it over the tailnet + start

```bash
sudo tailscale serve --bg 4317
sudo systemctl start hoopedorc
systemctl status hoopedorc            # active (running)?
journalctl -u hoopedorc -f            # watch the first boot
```

`tailscale serve` gives you `https://<box-name>.<tailnet>.ts.net` with real
TLS — which also makes browser notifications and the PWA install work from
your phone. (Never `tailscale funnel` — that's public internet.)

## 7. First-boot verification

Open the tailnet URL (you'll hit the token login screen — paste
`API_TOKEN`):

- [ ] **Setup & Health**: all CLI checks green; "Gate sandbox" line shows
      what you expect (Docker → `auto` should report the sandbox usable).
- [ ] **Settings → Models → Test models**: every configured model
      round-trips with a real reply.
- [ ] **Settings → Telegram → Send test message**: arrives on your phone.
- [ ] Version footer / `GET /api/health` says `0.5.0`.

## 8. Live-verify the Part 8 features (still owed from the v0.5.0 wave)

These shipped with server-side verification only — no real bot or EC2 box
existed in the dev environment. One pass now closes them out:

- [ ] **F40 — Telegram commands**: from your phone, round-trip each of
      `/help`, `/status`, `/health`, `/pending` (expect "Nothing pending"),
      `/autonomous` (bare — reports policy), `/digest` (bare), and
      `/retry x` (expect a no-match reply). Then `/stopall` — confirm it
      asks Yes/No and that **No** does nothing.
- [ ] **B30 — approval survives a restart**: once a real risky-flagged task
      is waiting on your approval, `sudo systemctl restart hoopedorc` — a
      *fresh* approval (same PR link) should arrive on Telegram within a
      minute or so, with **no re-authoring** (check the task's run history
      shows no new run). Approve it; the merge should complete.
- [ ] **F42** — already covered if step 3 ran clean; note any deviations.

## 9. First real project

Start small and watch one full loop before going hands-off:

1. **Add one project** (a small, low-stakes repo with real
   `test`/`build`/`lint` scripts — vacuous gates escalate everything to
   you, which defeats the point).
2. Keep `mergePolicy` at **`hard_gate_flag_risky`** (the default) for the
   first project. Go `fully_autonomous` (or `/autonomous on` from the
   phone) only after a few approvals have shown you what the validator
   flags.
3. Set a **budget cap** on the project before starting it.
4. Optionally tick **hold-dispatch while awaiting approval** (Settings,
   next to merge policy — F41) for zero unsupervised spend while a
   decision waits on you.
5. Start it, then supervise from Telegram: `/status`, `/cost`, `/health`,
   `/pending`; approvals arrive as pushes with inline buttons.

## 10. Day-2 operations

| What | How |
|---|---|
| Update the box | `cd /opt/hoopedorc && npm run update` (pulls, rebuilds, restarts the unit) |
| Logs | `journalctl -u hoopedorc -f` |
| DB backups | automatic, daily + on boot, `backups/` next to the DB, keeps 7 — copying one off-box occasionally doesn't hurt |
| Stop everything from the phone | `/stopall` (two-step confirm) |
| Missed an approval push | `/pending` re-sends them, buttons included |
| Panic switch back to supervised mode | `/autonomous off` |

**Two-box rule** if you later add Apple/Xcode projects: they run on a
second instance on your Mac, and **each project lives on exactly one box**
— see [the USER_GUIDE section](USER_GUIDE.md#two-boxes-ec2-for-webextensions-your-mac-for-apple-targets).

## If something goes wrong

- Bootstrap failure → it's idempotent; fix the cause and re-run.
- Server refuses to start → `journalctl -u hoopedorc -n 50`; the classic is
  a non-loopback `HOST` without `API_TOKEN` (intentional refusal).
- Anything else → [USER_GUIDE — Troubleshooting](USER_GUIDE.md#troubleshooting).
