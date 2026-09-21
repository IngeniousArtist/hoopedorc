# Isolated Codex worker (VW14)

This optional profile confines each agent to one assigned workspace and explicit
CLI account state. Native host execution remains the default. Gate/setup
sandboxing is configured separately. This is a Docker container boundary, not a
microVM or a promise to withstand a kernel/runtime exploit.

The initial supported image contains **Codex CLI 0.154.0**, Node 22.23.0,
Python 3 and Git. Only **ChatGPT subscription login** is accepted. Claude and
OpenCode worker profiles are refused. Host CLI logins are not imported. Model
access, OAuth renewal through the proxy and AWS deployment need live verification
on the operator's installation; no-model boundary tests do not prove those facts.

## Install and sign in

Use a non-root Hoopedorc service user with access to a local Linux Docker engine
and the `docker` CLI. A local Docker Desktop/Lima Unix socket is also usable when
both the task workspace and execution state directory are shared with its VM at
the same absolute paths. Remote TCP/SSH Docker contexts are unsupported. Set
`DOCKER_HOST=unix:///absolute/path/docker.sock` in the service environment when
not using `/var/run/docker.sock`. Keep `DB_PATH` and the server checkout outside
project workspaces. Docker socket access itself is a privileged host capability;
that socket is never mounted into the worker.

Build from this directory's Dockerfile and inspect its actual image ID. Newer
Docker containerd stores may report a manifest ID rather than a config digest;
use the value returned by `docker image inspect`, not a build-log digest.

```sh
docker build -t hoopedorc-codex-worker -f deploy/worker/Dockerfile deploy/worker
docker image inspect hoopedorc-codex-worker --format '{{.Id}}'
```

Create a subscription account pool in Settings → Resources. Copy its `id` from
saved settings (`GET /api/settings`). Create a **new**, dedicated account volume
with that exact pool label. Substitute your chosen pool and volume below. Never
reuse an unrelated volume or mount your host HOME, keychain or `.codex` directory.
The example `shared-codex` is a placeholder pool ID.

```sh
docker volume create --label io.hoopedorc.account=shared-codex hoopedorc-account-codex
docker run --rm --network none \
  --mount type=volume,source=hoopedorc-account-codex,target=/account \
  --entrypoint chown hoopedorc-codex-worker "$(id -u):$(id -g)" /account
docker run --rm -it --user "$(id -u):$(id -g)" \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --mount type=volume,source=hoopedorc-account-codex,target=/account \
  --env CODEX_HOME=/account --env HOME=/home/worker \
  --entrypoint codex hoopedorc-codex-worker login --device-auth
```

This explicit operator login owns its own credentials. It uses normal Docker
networking only for the interactive account setup. Hoopedorc's subsequent workers
use the restricted transport below. Do not set provider API keys in the image or
account configuration. The CLI's login status must report ChatGPT; Hoopedorc
forces `forced_login_method="chatgpt"` for execution and refuses a missing login.

Add a Docker profile with the inspected immutable image ID, labelled account
volume, matching subscription pool and desired CPU/memory/process limits. Save,
then **Verify worker**. Assign eligible Codex model profiles to it. Verification
runs `codex --version` and `codex login status` inside the actual worker; it sends
no model prompt. Use the existing explicit model test to verify real model
access when ready. Inherited capabilities mean the **worker's own** account
configuration; host MCP discovery and login probes are not worker evidence.
Selected Codex capabilities remain unavailable until separately verified.

## Boundary and lifecycle

- Worker: non-root service UID/GID, read-only root, no Linux capabilities,
  no-new-privileges, PID/CPU/memory limits, temporary `/tmp`, `--network none`.
- Mounts: assigned workspace, private output directory, read-only launcher,
  the explicitly selected account volume, and one private proxy socket volume.
  Project `.git` is masked. Host Git commits/pushes/gates remain engine-owned;
  agents edit files. Planning/review/health workspaces are read-only.
- Proxy: separate trusted container, no account/workspace/control-plane mounts.
  A private Unix socket bridges HTTP CONNECT to `chatgpt.com`, `api.openai.com`
  and `auth.openai.com`, port 443. Checked public IPv4 addresses are connected
  directly to avoid DNS rebinding; private, loopback and metadata destinations
  are denied. TLS contents are opaque; this is destination policy, not TLS
  inspection or a guarantee against data sent to an allowed provider/CDN.
- Package downloads and arbitrary external MCP endpoints are unavailable inside
  this initial worker. Prepare dependencies through the host-owned setup/gates.
  Do not advertise a host browser/MCP as an isolated capability.
- Ownership is persisted before Docker mutation. Containers and proxy volume
  have exact installation/invocation labels and a persisted Docker engine ID.
  A changed Docker engine cannot confirm absence on the old engine; restore access
  to that engine to verify termination. Moving a database never releases old workers. Cancellation removes and verifies
  both containers before success or releasing the account slot. Startup attempts
  the same bounded recovery. A daemon failure or foreign label leaves unresolved
  ownership; worktree cleanup and new project runs are blocked.
- Settings → Resources shows unresolved workers. Stop the owned worker, then
  recover its account reservation. Recovery is versioned and idempotent. Login
  volumes and task workspaces are never deleted by worker recovery.

The service user must retain the same UID/GID and access to its account volume.
Worker images are trusted operator-installed executables. The app never pulls an
image automatically or accepts client-supplied runtime commands, mounts or flags.

## No-model boundary check

With the built image and a temporary directory visible to Docker:

```sh
HOOPEDORC_DOCKER_BOUNDARY=1 \
HOOPEDORC_WORKER_IMAGE="$(docker image inspect hoopedorc-codex-worker --format '{{.Id}}')" \
HOOPEDORC_WORKER_TEST_ROOT=/tmp \
node --import tsx --test packages/server/src/execution-boundary.test.ts
```

This creates only labelled fixture containers/volumes and checks filesystem,
environment, network refusal, read-only review, cancellation, ownership recovery,
CLI version and refusal of an empty account. It does not copy credentials or
make model requests. AWS checks remain owner-deferred until a new installation
exists.
