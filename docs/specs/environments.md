# Project environments (VW16)

A project profile describes requirements, not an automatically provisioned SDK.
The canonical configuration remains `ProjectConfig`: `environment` supplies
runtime/platform/version and output preferences; existing `setupCommand`,
`gateImage`, `gates` and `preview` supply execution details.

The project editor offers two starting points. Node web keeps the existing
lockfile/package-manager preparation and npm-script gates. Python backend
creates a worktree-local `.hoopedorc-venv` and runs standard-library unittest
discovery. The Python preset deliberately skips typecheck/lint/build; add real
commands for those checks if the repository requires them. A skipped test never
satisfies milestone acceptance. Presets require confirmation before replacing
setup/gates/image; they preserve unrelated settings and saved previews.

`gates.commands` has optional `typecheck`, `lint`, `build`, `tests` entries, each
`{command,args}` or `false`. A present entry overrides the corresponding legacy
script/testCommand setting. An absent entry keeps legacy behavior. Commands use
literal argv; quotes, spaces, empty arguments and metacharacters remain data.
Missing executables, nonzero exits and timeouts fail their gate. Cancellation
uses the existing process-group owner and settles before cleanup.

`environment.runtime` currently accepts `node` or `python3`; `platform` is
`any` (macOS/Linux), `darwin` or `linux`; `majorVersion` is optional. The actual
host or selected gate container runs the fixed `--version` probe. The author
preflight and worktree preparation refuse unmet requirements before model work;
gates repeat the probe and record the observed runtime in `GateResult`.
Docker always means Linux, even on a Mac. Setup & Health shows the same check.

Custom setup reuse includes the observed runtime identity, profile and existing
manifest hashes. `setupInputs` adds up to 20 repository-relative files to that
fingerprint; `setupOutputs` requires up to 20 regular files before reuse and
after setup. Missing outputs rerun setup. Escaping symlinks and traversal are
refused. The owned virtual environment is excluded from Git staging and
repository scans; no global Python environment is modified.

Web output reuses the task-scoped start command, readiness, preview ownership
and browser evidence from VW09/VW10. Artifact output opens diagnostics and
supplied evidence in Review, with a visible explanation that browser checks
need web output. No second service supervisor or accounting system is added.
Setup and checks are repository processes, not model calls; provider calls still
use the existing invocation ledger and capacity reservations.

## Compatibility evidence

- Existing Node web path: covered by the repository's required build, browser,
  setup/worktree and cancellation suites.
- Python standard-library HTTP backend: real macOS arm64 Python 3.9.6 fixture
  exercises isolated worktree setup, health + missing-route behavior, literal
  argv, nonzero/missing-command refusal, cancellation, fresh-manager reuse,
  changed inputs, deleted setup outputs and successful retry. Required Linux CI
  runs the same fixture and prints its actual Python version.
- The editable `python:3.12-slim` gate image is a configuration suggestion;
  full Python Docker/provider/AWS acceptance is not claimed. Use an installed
  compatible image and verify setup before starting work; digest pins improve
  reproducibility.
- Windows, Xcode/simulators, managed databases and arbitrary SDK provisioning
  are not verified by this item. Provision external services separately. A
  Linux AWS installation cannot run a macOS-only toolchain.

No AWS or paid provider invocation was used. Provider-powered journeys and AWS
remain pending; the previous AWS installation is shut down by the owner.
