// One staged helper for managed updates and revocable automatic triage.
import { MANAGED_SERVICE_UPDATE_SAFE_EXIT_CODE } from "./update-control-plane-sentinel.js";
import { HANDOFF_LEASE_FACTORY_SOURCE } from "./update-managed-service-handoff-lease-script.js";
import {
  HANDOFF_SENTINEL_SCRIPT,
  HANDOFF_SENTINEL_STATE_SCRIPT,
} from "./update-managed-service-handoff-sentinel-script.js";
import { HANDOFF_SERVICE_SCRIPT } from "./update-managed-service-handoff-service-script.js";
const HANDOFF_READY_MARKER = "OPENCLAW_UPDATE_HANDOFF_READY\n";
const HANDOFF_BUSY_MARKER = "HANDOFF_BUSY ";
const PARENT_EXIT_SHUTDOWN_RESERVE_MS = 30_000;
const HANDOFF_COMMAND_RUNNER_SCRIPT = String.raw`
await new Promise((resolve, reject) => {
  process.stdin.once("data", (decision) => {
    if (decision.toString() === "go") resolve();
    else reject(new Error("Managed handoff admission was refused"));
  });
  process.stdin.once("end", () => reject(new Error("Managed handoff admission was cancelled")));
});
`;

// Non-Node update launchers keep their existing exec handoff; only the installed
// Node CLI can retain IPC and request the private automatic-triage continuation.
const HANDOFF_EXEC_RUNNER_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
process.stdin.once("data", (decision) => {
  if (decision.toString() !== "go") return;
  const argv = JSON.parse(process.argv[1]);
  if (process.platform !== "win32" && typeof process.execve === "function")
    process.execve(argv[0], argv, process.env);
  const child = spawn(argv[0], argv.slice(1), { env: process.env, stdio: "inherit" });
  child.once("error", () => {
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
  });
});
`;

export const HANDOFF_SCRIPT = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const params = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(params.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(params.logPath, "[" + new Date().toISOString() + "] " + line + "\n", {
      mode: 0o600,
    });
  } catch {
    // Best effort only.
  }
}

const leaseStore = (${HANDOFF_LEASE_FACTORY_SOURCE})({ fs, path, spawnSync, DatabaseSync: require("node:sqlite").DatabaseSync, process }, {
  databasePath: params.updateLeaseDatabasePath,
  serviceManagerEnv: params.serviceManagerEnv,
});
const { isPidAlive, readProcessStartIdentity, properties: parseSystemdProperties, validFailure: validTriageFailure } = leaseStore;
let managedUpdateLease = null;
function initialTriageAction() {
  return { kind: "triage", phase: "reserved", lifetime: { kind: "native", unit: params.serviceRecovery.unit, scope: params.scopeUnit, placement: { kind: "pending" } } };
}
function acquireManagedUpdateLease() {
  const result = leaseStore.acquire(params.updateLeaseKey, params.updateLeaseOwner,
    params.action === "triage" ? initialTriageAction() : { kind: "update" }, params.triageTransition);
  if (result.kind === "acquired") {
    managedUpdateLease = result.lease;
    if (params.action === "triage") nativePlacement = result.lease;
  }
  return { acquired: result.kind === "acquired", owner: result.owner };
}
function bindManagedUpdateLeaseToProcess(pid, expectedPayload, action) {
  if (!managedUpdateLease || expectedPayload && managedUpdateLease.payload !== expectedPayload) return false;
  const next = leaseStore.bind(managedUpdateLease, pid, action);
  if (!next) return false;
  managedUpdateLease = next;
  return true;
}
function hasManagedUpdateLease() { return managedUpdateLease && leaseStore.owns(managedUpdateLease); }
function ownsManagedUpdateLease() { return hasManagedUpdateLease() && managedUpdateLease.executor.pid === process.pid; }
function releaseManagedUpdateLease() {
  const lease = managedUpdateLease;
  if (!lease) return;
  try {
    if (lease.action.kind === "triage") leaseStore.revoke(lease);
    else leaseStore.release(lease);
  } catch (error) { appendLog("managed handoff release failed: " + String(error)); }
  managedUpdateLease = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupSensitiveFiles() {
  for (const filePath of params.sensitivePaths || []) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort only.
    }
  }
}

${HANDOFF_SENTINEL_SCRIPT}
${HANDOFF_SENTINEL_STATE_SCRIPT}
${HANDOFF_SERVICE_SCRIPT}
function killOwnedCommand(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      env: params.serviceManagerEnv, stdio: "ignore", windowsHide: true, timeout: 5000,
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}


async function runOwnedUpdateCommand(commandArgv, timeoutMs) {
  let outputFd;
  let timeout;
  let continuation;
  let triageAdmitted = false;
  let leaseWatch;
  let admissionDeadline;
  try {
    outputFd = fs.openSync(params.logPath, "a", 0o600);
    const retainedIpc = Array.isArray(params.nodeExecArgv);
    const child = spawn(
      retainedIpc ? commandArgv[0] : process.execPath,
      retainedIpc
        ? [
            ...params.nodeExecArgv,
            "--import",
            ${JSON.stringify(`data:text/javascript,${encodeURIComponent(HANDOFF_COMMAND_RUNNER_SCRIPT)}`)},
            ...commandArgv.slice(1),
          ]
        : ["-e", ${JSON.stringify(HANDOFF_EXEC_RUNNER_SCRIPT)}, JSON.stringify(commandArgv)],
      {
        cwd: params.cwd,
        env:
          params.action === "triage"
            ? { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" }
            : process.env,
        detached: true,
        stdio: ["pipe", outputFd, outputFd, "ipc"],
      },
    );
    const exited = new Promise((resolve) => {
      child.once("error", (err) => resolve({ error: err }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.stdin.on("error", () => {});
    if (!bindManagedUpdateLeaseToProcess(child.pid)) {
      killOwnedCommand(child);
      await exited;
      throw new Error("managed update runner lease binding failed");
    }
    let runnerIdentity = managedUpdateLease.payload;
    child.on("message", async (message) => {
      try {
        if (
          !message ||
          message.version !== 2 ||
          !hasManagedUpdateLease() ||
          managedUpdateLease.payload !== runnerIdentity ||
          child.exitCode !== null ||
          child.signalCode !== null
        ) {
          throw new Error("managed handoff child lost its current claim");
        }
        if (
          params.action === "triage" &&
          message.type === "triage-ready" &&
          !triageAdmitted &&
          Object.keys(message).length === 2
        ) {
          // Claim the one admission before awaiting native inspection; duplicate
          // messages cannot both pass the same current runner lease.
          triageAdmitted = true;
          const scope = await inspectTriageScope();
          if (
            !hasManagedUpdateLease() ||
            managedUpdateLease.payload !== runnerIdentity ||
            fs.readFileSync("/proc/" + child.pid + "/cgroup", "utf8").trim() !==
              "0::" + scope.ControlGroup
          ) {
            throw new Error("automatic triage executor lost its native placement");
          }
          if (!child.connected || child.exitCode !== null || child.signalCode !== null) throw new Error("automatic triage child disconnected");
          const admitted = leaseStore.activate(managedUpdateLease);
          if (!admitted) throw new Error("automatic triage activation lost its claim");
          managedUpdateLease = admitted;
          runnerIdentity = admitted.payload;
          clearTimeout(admissionDeadline);
          child.send(
            {
              type: "triage",
              version: 2,
              failure: params.failure,
              installRoot: params.updateLeaseKey,
              owner: managedUpdateLease.owner,
            },
            () => {},
          );
        } else if (
          params.action === "update" &&
          message.type === "triage-request" &&
          !continuation &&
          Object.keys(message).length === 4 &&
          Array.isArray(message.commandArgv) &&
          message.commandArgv.length === 3 &&
          message.commandArgv.every((arg) => typeof arg === "string" && arg.length < 4096) &&
          message.commandArgv[2] === "triage" &&
          validTriageFailure(message.failure) &&
          message.failure.kind === "update" &&
          params.serviceRecovery?.kind === "systemd" &&
          Buffer.byteLength(JSON.stringify(message)) <= 16384
        ) {
          continuation = message;
          child.send({ type: "triage-queued", version: 2 }, () => {});
        } else throw new Error("invalid or repeated managed handoff continuation");
      } catch (error) {
        appendLog("automatic triage admission failed: " + String(error));
        if (params.action === "triage") stopTriageScope();
        else if (child.connected) child.send({ type: "triage-refused", version: 2 }, () => {});
      }
    });
    if (params.action === "triage") {
      admissionDeadline = setTimeout(() => {
        appendLog("installed candidate did not admit triage; run openclaw triage manually");
        stopTriageScope();
      }, 30000);
      leaseWatch = setInterval(() => {
        if (!hasManagedUpdateLease()) {
          clearInterval(leaseWatch);
          appendLog("automatic triage cancelled: lease lost or replaced");
          stopTriageScope();
        }
      }, 250);
    }
    try {
      // Sending the gate can start mutation even if its write callback fails.
      // From here, only the updater can authorize recovery of this installation.
      restorationArmed = false;
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          appendLog("verified recovery command exceeded its update timeout");
          killOwnedCommand(child);
        }, timeoutMs);
      }
      await new Promise((resolve, reject) => {
        child.stdin.once("error", reject);
        child.stdin.once("close", () => reject(new Error("managed update runner stdin closed")));
        child.once("exit", () =>
          reject(new Error("managed update runner exited before its gate")),
        );
        child.stdin.write("go", (error) => (error ? reject(error) : resolve()));
      });
      child.stdin.end();
    } catch (error) {
      killOwnedCommand(child);
      await exited;
      bindManagedUpdateLeaseToProcess(process.pid, runnerIdentity);
      throw error;
    }
    appendLog("managed update command pid=" + (child.pid || "unknown"));
    const exit = await exited;
    clearInterval(leaseWatch);
    clearTimeout(admissionDeadline);
    if (params.action !== "triage" && !bindManagedUpdateLeaseToProcess(process.pid, runnerIdentity)) {
      throw new Error("managed update command lease binding was lost");
    }
    if (exit.error) throw exit.error;
    appendLog(
      "managed update command exited code=" +
        (exit && exit.code !== null && exit.code !== undefined ? exit.code : "null") +
        " signal=" +
        (exit && exit.signal ? exit.signal : "null"),
    );
    if (params.action === "triage" && !triageAdmitted) {
      appendLog(
        "installed candidate cannot accept automatic triage; run openclaw triage manually",
      );
      process.exitCode = 1;
    }
    return { exit, continuation };
  } finally {
    clearTimeout(timeout);
    clearInterval(leaseWatch);
    clearTimeout(admissionDeadline);
    if (outputFd !== undefined) {
      try {
        fs.closeSync(outputFd);
      } catch {
        // Ignore close failures.
      }
    }
  }
}

(async () => {
  if (
    !params.triageTransition &&
    (!Number.isInteger(params.parentPid) ||
      params.parentPid <= 0 ||
      typeof params.parentStartIdentity !== "string" ||
      !params.parentStartIdentity)
  ) {
    throw new Error("managed update parent process identity is unavailable");
  }
  if (
    !params.triageTransition &&
    isPidAlive(params.parentPid) &&
    readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity
  ) {
    throw new Error("managed update parent process identity changed");
  }
  if (
    !["update", "triage"].includes(params.action) ||
    !Number.isFinite(params.parentExitTimeoutMs) ||
    params.parentExitTimeoutMs < 0 ||
    !Number.isFinite(params.parentExitDeadlineAt)
  ) {
    throw new Error("managed update parent exit deadline is unavailable");
  }
  const lease = acquireManagedUpdateLease();
  if (!lease.acquired) {
    appendLog("managed update handoff joined active owner=" + (lease.owner || "unknown"));
    cleanupSensitiveFiles();
    fs.writeSync(1, ${JSON.stringify(HANDOFF_BUSY_MARKER)} + (lease.owner || "") + "\n");
    await sleep(25);
    return;
  }
  let outcome = params.triageTransition ? "triage" : undefined;
  let wake;
  let deadlineExpired = false;
  const parentExitDeadline = setTimeout(() => {
    deadlineExpired = true;
    if (outcome !== "update" && outcome !== "triage") outcome = "restore";
    wake?.();
  }, params.parentExitTimeoutMs);
  try {
    if (params.action === "triage") await admitTriageScope();
    if (!params.triageTransition) fs.writeSync(1, ${JSON.stringify(HANDOFF_READY_MARKER)});
    const commands = [];
    let input = "";
    let disconnected = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (input.length > 64) return process.stdin.destroy();
      let newline;
      while ((newline = input.indexOf("\n")) >= 0) {
        if (commands.length >= 4) return process.stdin.destroy();
        commands.push(input.slice(0, newline));
        input = input.slice(newline + 1);
      }
      wake?.();
    });
    process.stdin.once("close", () => {
      disconnected = true;
      wake?.();
    });
    const reply = (line) => fs.writeSync(1, line + "\n");
    let parked = false;
    while (outcome !== "triage" && isPidAlive(params.parentPid)) {
      if (!ownsManagedUpdateLease())
        throw new Error("managed update lease no longer owns the helper");
      if (readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity) {
        if (isPidAlive(params.parentPid))
          throw new Error("managed update parent process identity changed");
        await new Promise((resolve) => setImmediate(resolve));
        if (!commands.length) break;
      }
      if (deadlineExpired) {
        if (params.action === "triage") throw new Error("automatic triage admission expired");
        deadlineExpired = false;
        if (!parked) {
          await parkGatewayService();
          parked = true;
        }
        if (
          ownsManagedUpdateLease() &&
          readProcessStartIdentity(params.parentPid) === params.parentStartIdentity
        ) {
          try {
            process.kill(params.parentPid, "SIGKILL");
          } catch {}
        }
      }
      const command = commands.shift();
      if (command === "commit" && params.action === "triage") {
        await inspectTriageScope();
        if (!ownsManagedUpdateLease()) throw new Error("automatic triage admission lost its lease");
        outcome = "triage";
        reply("committed");
        break;
      } else if (command === "park" && params.action !== "triage") {
        try {
          if (!parked) await parkGatewayService();
          parked = true;
          reply("parked");
        } catch (error) {
          appendLog("managed service parking failed: " + String(error));
          if (restorationArmed) {
            outcome = "restore";
            reply("restore-after-exit");
          } else {
            markUpdateSentinelFailureIfPending("managed-service-handoff-cancelled");
            reply("cancelled");
            return;
          }
        }
      } else if (command === "commit" && parked) {
        const restoring = outcome === "restore" || Date.now() >= params.parentExitDeadlineAt;
        outcome = restoring ? "restore" : "update";
        reply(restoring ? "restore-after-exit" : "committed");
      } else if (command === "cancel" || (disconnected && outcome !== "update")) {
        if (!restorationArmed) {
          if (params.action === "update")
            markUpdateSentinelFailureIfPending("managed-service-handoff-cancelled");
          if (command) reply("cancelled");
          return;
        }
        outcome = "restore";
        if (command) reply("restore-after-exit");
      } else if (command === "restore-commit" && outcome === "restore") {
        reply("committed");
      } else if (command) {
        throw new Error("invalid managed update control command");
      }
      await Promise.race([
        sleep(25),
        new Promise((resolve) => {
          wake = resolve;
        }),
      ]);
    }
    clearTimeout(parentExitDeadline);
    const stopped = pendingServiceStop ? await pendingServiceStop : null;
    if (
      stopped &&
      stopped.code !== 0 &&
      params.serviceRecovery?.kind === "launchd" &&
      !isLaunchdNotLoaded(stopped)
    ) {
      throw new Error("launchctl bootout failed: " + stopped.stderr);
    }
    if (outcome !== "update" && outcome !== "triage") {
      if (restorationArmed) await restoreGatewayService("managed-service-handoff-cancelled");
      else if (params.action === "update")
        markUpdateSentinelFailureIfPending("managed-service-handoff-cancelled");
      return;
    }
    if (params.action !== "triage" && params.serviceRecovery?.kind === "systemd") {
      if (!stopped || stopped.code !== 0 || Date.now() >= params.parentExitDeadlineAt) {
        throw new Error("systemd stop failed or exceeded the parent-exit deadline");
      }
      const unit = params.serviceRecovery.unit;
      for (;;) {
        const current = await inspectSystemdService(unit, params.parentExitDeadlineAt);
        if (
          !current ||
          current.Id !== unit ||
          current.LoadState !== "loaded" ||
          Date.now() >= params.parentExitDeadlineAt
        ) {
          throw new Error("systemd service remained active or changed execution generation");
        }
        if (current.ActiveState === "inactive" && current.MainPID === "0") {
          const retainedIdentity =
            current.ExecMainStartTimestampMonotonic === parkedServiceGeneration &&
            current.InvocationID === parkedServiceInvocation;
          const clearedIdentity =
            current.ExecMainStartTimestampMonotonic === "0" && !current.InvocationID;
          if (!retainedIdentity && !clearedIdentity) {
            throw new Error("systemd service remained active or changed execution generation");
          }
          break;
        }
        if (
          current.ActiveState !== "deactivating" ||
          current.MainPID !== "0" ||
          current.ExecMainStartTimestampMonotonic !== parkedServiceGeneration ||
          current.InvocationID !== parkedServiceInvocation
        ) {
          throw new Error("systemd service remained active or changed execution generation");
        }
        // The exact stop job has completed; systemd may publish inactive a moment later.
        await sleep(Math.min(25, Math.max(0, params.parentExitDeadlineAt - Date.now())));
      }
    }
    if (params.serviceRecovery?.kind === "launchd") {
      const target = "gui/" + params.serviceRecovery.uid + "/" + params.serviceRecovery.label;
      const deadline = Date.now() + ${PARENT_EXIT_SHUTDOWN_RESERVE_MS};
      for (;;) {
        const result = await runServiceCommand("launchctl", ["print", target], undefined, deadline);
        if (result.code !== 0) {
          if (!isLaunchdNotLoaded(result))
            throw new Error("launchctl print failed: " + result.stderr);
          break;
        }
        if (Date.now() >= deadline)
          throw new Error("launchd service remained loaded after parent exit");
        await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
      }
    }

    appendLog("starting managed update command: " + params.commandLabel);
    const { exit, continuation } = await runOwnedUpdateCommand(params.commandArgv);
    if (exit.signal || exit.code !== 0) {
      // Exit 80 is the updater's recovery protocol, never authority from a fixing agent.
      if (params.action === "triage") {
        process.exitCode = exit.code || 1;
      } else {
        if (!exit.signal && exit.code === ${MANAGED_SERVICE_UPDATE_SAFE_EXIT_CODE} && params.serviceRecovery) {
          // The installed CLI checks current config, service ownership and readiness.
          // Native restoration would bypass those checks after a rollback.
          appendLog("updater verified recovery; checking the installed gateway before restart");
          // Startup can consume this notification during recovery. Retain its exact
          // revision so later annotation cannot recreate it or replace a newer outcome.
          recoverySentinelRevision = markUpdateSentinelFailureIfPending("managed-service-handoff-failed");
          const { exit: recovery } = await runOwnedUpdateCommand(params.recoveryCommandArgv, params.recoveryTimeoutMs);
          recordServiceRecovery("managed-service-handoff-failed", !recovery.signal && recovery.code === 0, recoverySentinelRevision);
        } else {
          appendLog("updater exited without requesting helper recovery; inspect the update result before restarting");
          markUpdateSentinelFailureIfPending("managed-service-handoff-failed");
        }
        process.exitCode = 1;
      }
    }
    if (continuation && !exit.signal) await enterTriageAfterUpdate(continuation);
  } catch (err) {
    appendLog("handoff failed: " + (err && err.stack ? err.stack : String(err)));
    if (hasManagedUpdateLease()) {
      if (params.action !== "triage") bindManagedUpdateLeaseToProcess(process.pid);
      if (restorationArmed) await restoreGatewayService("managed-service-handoff-helper-failed");
      else if (params.action === "update")
        markUpdateSentinelFailureIfPending("managed-service-handoff-helper-failed", undefined, recoverySentinelRevision);
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(parentExitDeadline);
    releaseManagedUpdateLease();
    process.stdin.destroy();
    cleanupSensitiveFiles();
    stopTriageScope();
  }
})().catch((err) => {
  appendLog("handoff setup failed: " + (err && err.stack ? err.stack : String(err)));
  cleanupSensitiveFiles();
  stopTriageScope();
  process.exitCode = 1;
});
`;
