// Who: Tim Buglaev
// When: 2026-05-28
// What: Added a cross-platform Electron launcher that clears ELECTRON_RUN_AS_NODE before
//       spawning Electron, preventing dev-shell environments from running the app as plain Node.
const { spawn, spawnSync } = require("child_process");
const { validateOwnedLauncherControl, attachOwnedLauncherControl } = require("./owned_launcher_control");
const OWNED_CONTROL = validateOwnedLauncherControl(process.env);

// Who: Tim Buglaev
// When: 2026-06-14
// What: Switch Windows console sessions to UTF-8 before Electron starts so backend
//       Russian logs are readable in PowerShell instead of CP866 mojibake.
function configureWindowsConsoleEncoding() {
  if (process.platform !== "win32") {
    return;
  }
  try {
    // Who: Tim Buglaev
    // When: 2026-06-30
    // What: Keep the best-effort code-page helper invisible when the launcher is
    //       started outside an existing developer console.
    spawnSync("chcp.com", ["65001"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (_) {
    // Console code page changes are best-effort and should not block app startup.
  }
  process.env.PYTHONIOENCODING = process.env.PYTHONIOENCODING || "utf-8";
  process.env.PYTHONUTF8 = process.env.PYTHONUTF8 || "1";
}

configureWindowsConsoleEncoding();

delete process.env.ELECTRON_RUN_AS_NODE;

const electronPath = require("electron");
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
// Who: Tim Buglaev
// When: 2026-06-21
// What: Give Electron a validated launcher PID so it can detect an abrupt npm/PTY
//       termination and still execute its own managed-service cleanup.
childEnv.TEST_GUI_LAUNCHER_PID = String(process.pid);

const args = process.argv.slice(2);
const electronArgs = args.length ? args : ["."];
// Who: Tim Buglaev
// When: 2026-06-22
// What: On Windows, relay Electron logs through pipes instead of inheriting the launcher
//       console so Ctrl+C reaches only this launcher and shutdown is delivered over IPC.
const childStdio = process.platform === "win32"
  ? ["ignore", "pipe", "pipe", "ipc"]
  : ["inherit", "inherit", "inherit", "ipc"];
const child = spawn(electronPath, electronArgs, {
  cwd: __dirname,
  env: childEnv,
  // Who: Tim Buglaev
  // When: 2026-06-21
  // What: Keep inherited developer logs while adding a private parent/child IPC
  //       channel so Ctrl+C requests Electron cleanup instead of killing WSL,
  //       backend, and Qdrant ownership abruptly.
  stdio: childStdio,
  detached: process.platform === "win32",
  windowsHide: process.platform === "win32",
});

if (child.stdout) {
  child.stdout.pipe(process.stdout);
}
if (child.stderr) {
  child.stderr.pipe(process.stderr);
}

let shutdownRequested = false;
let forcedShutdownTimer = null;

// Who: Tim Buglaev
// When: 2026-06-21
// What: Forward the first console stop as a graceful app shutdown and reserve a
//       second signal or bounded 90-second deadline for force termination.
function requestGracefulShutdown(signal) {
  if (shutdownRequested) {
    child.kill("SIGKILL");
    return;
  }
  shutdownRequested = true;
  if (child.connected) {
    child.send({ type: "test-gui-shutdown", signal: String(signal || "external") });
  } else {
    child.kill("SIGTERM");
  }
  forcedShutdownTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 90000);
  forcedShutdownTimer.unref?.();
}

attachOwnedLauncherControl(process, requestGracefulShutdown, child, OWNED_CONTROL);

process.on("SIGINT", () => requestGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => requestGracefulShutdown("SIGTERM"));

child.on("exit", (code, signal) => {
  if (forcedShutdownTimer) {
    clearTimeout(forcedShutdownTimer);
  }
  process.exit(shutdownRequested ? (code ?? 0) : (code ?? (signal ? 1 : 0)));
});
