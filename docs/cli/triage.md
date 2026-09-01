---
summary: "CLI reference for `openclaw triage` (sanitized diagnostics and agent handoff)"
read_when:
  - OpenClaw is misbehaving and you want an agent-ready debugging prompt
  - You need a sanitized diagnostics bundle without applying repairs
title: "Triage"
---

# `openclaw triage`

Run read-only Doctor checks, collect the existing sanitized diagnostics archive, and write a bounded Markdown prompt for an agent debugging this OpenClaw installation.

```bash
openclaw triage
```

The prompt includes the OpenClaw version, platform, Node.js version, prioritized Doctor findings with repair hints, and the diagnostics archive path. The archive contains sanitized config, best-effort Gateway status and health snapshots, operational log summaries, and available stability diagnostics. If the Gateway is unreachable, triage still writes the archive with available local diagnostics and records snapshot failures inside it. If the export itself fails, triage still writes the prompt and explains why the archive is unavailable.

Secrets, tokens, raw chat payloads, and raw logs are excluded. Paths inside the prompt are shown relative to `~` or `$OPENCLAW_STATE_DIR`; the saved prompt path, archive path, and printed handoff commands retain the real absolute paths needed by your shell. Doctor checks remain advisory and do not apply repairs.

The archive's config summary counts agent, plugin, and channel entries declared in the saved file. Shared channel settings and `$include` directives are excluded from those counts; diagnostics do not expand included files.

## Agent handoff

In an interactive terminal, triage detects the agent handoff routes available on the current machine and asks which one to use. A configured OpenClaw embedded agent appears first, followed by Claude Code when `claude` is on `PATH`, Codex CLI when `codex` is on `PATH`, and an option to just print the commands.

Choosing Claude Code or Codex starts its interactive session directly with the generated prompt. Choosing the embedded agent first verifies the configured model with a live inference check, then runs one OpenClaw agent turn. `--run` requests that same verified embedded route explicitly.

Triage captures the diagnosed installation's resolved state directory, exact config path, and default workspace, including custom paths and named profiles. Local shell commands receive these as `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `OPENCLAW_WORKSPACE_DIR`, so archive references and default workspace checks resolve against the diagnosed installation even when its selectors were implicit. An authored workspace in the installation's config still takes precedence over its default workspace. The embedded agent keeps its own config snapshot, sessions, execution cwd, and temporary run state separate; in-process config and session tools refer to that temporary run. Use local shell commands to inspect or repair the diagnosed installation.

Embedded triage supports local OpenClaw tools, local CLI harness children, and local Codex native shells over stdio or a local Unix socket. It refuses WebSocket app-server connections, including loopback URLs that may forward to another host, because they cannot establish where native commands execute. Ordinary Codex runs without a triage installation target retain WebSocket support. Selected ACP turns, OpenClaw-provisioned sandboxes, remote/node execution, and a Codex app-server with `remoteWorkspaceRoot` are also unsupported for this local target. Use stdio, a local Unix socket, or the saved external/manual handoff on this machine. Triage does not redirect unsupported routes onto the host or relax native sandbox and approval policy.

On Windows, agents installed only as `.cmd` or `.bat` command shims appear in the manual handoff commands instead of the direct-launch picker.

Non-interactive sessions and the print-only choice provide these POSIX shell handoff commands instead:

```bash
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' claude "$(cat '<prompt-path>')"
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' codex exec --skip-git-repo-check - < '<prompt-path>'
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' openclaw triage --run
```

JSON output also includes `detectedAgents`, listing the external agents found on `PATH`. Running `openclaw triage --json` or plain `openclaw triage` non-interactively never starts an agent.

The Codex command works outside a Git checkout; it does not change Codex sandbox or approval settings.

## Automatic failure handoff

Failed updates that reached installation changes, unhealthy update restarts, and recorded Gateway server startup failures can invoke the same triage flow automatically. Existing update settlement runs first; restoration requires the update owner to verify that restarting is safe. After package replacement, the installed CLI owns triage; unavailable or incompatible CLI files leave saved failure diagnostics and manual guidance. A supervised Gateway attempts triage only when its existing crash-loop breaker first trips. Later failures in the same Gateway process do not launch another agent.

The automatic handoff selects the configured embedded agent first, otherwise a directly launchable Claude Code or Codex CLI, in that order. External agents run non-interactively with their existing authentication and permissions. Claude Code uses `--safe-mode` to disable custom hooks, plugins, and project instructions while retaining authentication and built-in tools. Finding an executable does not establish authentication. A failed selected route, including a Claude version that does not support safe mode, is reported without trying another agent; the private prompt and manual handoff commands remain available.

The fixing agent receives the original failure and a verification goal: check the intended installation with `openclaw health --json` and `openclaw status --all` or `openclaw gateway status --deep`, confirm the expected running version after an update when known, and verify the original symptom. A PID, valid config, or successful repair command alone does not prove recovery. The report must include changes, verification evidence, and any remaining blocker.

Skipped or blocked updates, capability approval refusals, ownership and schema refusals, existing-Gateway lock conflicts, external supervisors, and commands already running inside a fixing agent do not trigger another automatic agent. Automatic triage honors `--no-restart` and leaves intentionally stopped services stopped. Termination signals cancel foreground triage. Diagnostics and agent output go to stderr; the original failure result and exit status remain unchanged even if the agent reports success.

Automatic fixing is single-flight per canonical installation, including foreground updates and unsupervised Gateway startup. A competing failure reports that triage is already owned, preserves its original output and exit status, and leaves the running attempt alone. After normal cleanup, a later independent failure can start a fresh attempt.

Foreground triage stays attached to its caller. Cancellation or loss of that connection stops new work and gives registered OpenClaw resources their existing cleanup deadlines. The CLI gets the existing 30-second handoff grace to exit after cancellation or terminal disconnect; a stuck CLI is then terminated and its generation remains fenced. A normally exiting external CLI completes that invocation; OpenClaw cannot certify that arbitrary processes detached by that CLI have exited. A failed agent can still finish cleanup normally.

If the fixing process disappears abruptly, forced termination is needed, or teardown fails, automatic admission remains blocked for that OS boot. Cooperative cancellation that drains normally confirms closure and allows another attempt; a forced or uncertain terminal outcome cannot certify that closure. Inspect the saved diagnostics and use `openclaw triage` manually. Do not delete the claim while prior work may still be running. A verified different OS boot allows a fresh attempt; triage never initiates a reboot. Unavailable boot identity or incompatible private handoff data leaves diagnostics and manual guidance.

For a Linux user-systemd Gateway, automatic managed recovery reuses the existing update handoff in a native scope attached to the Gateway service. **Cancellation begins when that native scope attachment is verified**, before readiness is announced or a fixing agent starts. Earlier update parking, restoration, and preparation keep their existing update behavior; a stop completed before attachment is not treated as cancellation of a future recovery. Failed update restoration may leave the installed service inactive, and triage can still be admitted. An unsafe installation or preserve-activation request permits offline diagnosis and repair while leaving the primary stopped; running health verification is deferred.

When managed triage needs a restart, use the atomic `openclaw gateway restart` command. An explicit stop cancels recovery and its descendants, including `systemctl --user stop <gateway-unit>` when the primary is already inactive or a restart is pending. Do not use stop-then-start during recovery. Losing the helper, fixing child, or current handoff claim also closes recovery; the updater cannot restore the Gateway afterward. Cancellation or infeasibility must be reported, and an agent exit code or prose alone is not proof of health.

Repair commands such as `openclaw doctor --fix` remain available when the target is offline and ownership, schema, and maintenance locks permit repair. If maintenance needs to stop the managed Gateway, it refuses from inside that Gateway's automatic fixing subtree before issuing the stop. Continue with read-only diagnosis or safe offline artifact repair followed by an atomic restart, or report the blocker so an independent operator can run maintenance from a shell outside triage.

Automatic managed execution is limited to verified Linux user-systemd ownership. Launchd, Windows, system-scope systemd, and unverifiable managed ownership retain diagnostics/manual guidance. Foreground recovery remains available. No broader native cancellation support is implied.

This connection requires a working CLI. Missing Node or CLI files, failures before Gateway server startup or while recording its boot, and invalid-config paths that retain the existing Doctor recovery flow may still require `openclaw triage` manually. It does not install a separate recovery service.

## Output and exit codes

The prompt is written to `logs/support/` inside the state directory with owner-only permissions, alongside the diagnostics archive when one was produced. Both paths are printed, and `--json` returns them plus finding counts by severity.

A launched external agent inherits the current environment with the captured installation's state, config, and default workspace selectors pinned. The printed commands pin the same selectors and preserve shell quoting. External agents still control their own shell environment and execution policy; keep the handoff on this machine. Triage exits with the launched agent's exit code. If the agent cannot be started, triage prints its manual command and exits non-zero. A failed embedded inference check or unsupported execution route exits non-zero whether selected from the picker or requested with `--run`; the saved prompt and manual handoff commands remain available. `--run` without an interactive terminal also exits non-zero.

## Options

| Option        | Effect                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| `--json`      | Emit prompt and archive paths, finding counts, detected agents, and commands.    |
| `--no-export` | Skip the diagnostics archive and only generate the debugging prompt.             |
| `--run`       | Run one embedded agent turn after checking the model in an interactive terminal. |

`--json` cannot be combined with `--run`.

Related: [Doctor](/cli/doctor), [Gateway](/cli/gateway), and [Troubleshooting](/help/troubleshooting).
