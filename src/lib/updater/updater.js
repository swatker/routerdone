// Standalone detached updater process.
// Spawns `npm i -g <pkg>@latest`, exposes progress via tiny HTTP server.
// Survives after parent Next server exits (detached + unref by spawner).

const { spawn, execSync } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");

const packageName = process.env.UPDATER_PKG_NAME || "routerdone";
const port = parseInt(process.env.UPDATER_PORT || "20129", 10);
const tailLines = parseInt(process.env.UPDATER_TAIL_LINES || "8", 10);
const maxRetries = parseInt(process.env.UPDATER_RETRIES || "3", 10);
const retryDelayMs = parseInt(process.env.UPDATER_RETRY_DELAY_MS || "5000", 10);
const lingerMs = parseInt(process.env.UPDATER_LINGER_MS || "30000", 10);
const waitMinMs = parseInt(process.env.UPDATER_WAIT_MIN_MS || "3000", 10);
const waitMaxMs = parseInt(process.env.UPDATER_WAIT_MAX_MS || "15000", 10);
const waitCheckMs = parseInt(process.env.UPDATER_WAIT_CHECK_MS || "500", 10);
const appPort = parseInt(process.env.UPDATER_APP_PORT || "20128", 10);
const updaterMode = process.env.UPDATER_MODE || "legacy";
const packTimeoutMs = parseInt(process.env.UPDATER_PACK_TIMEOUT_MS || "120000", 10);

// Data directory (match mitm/paths.js logic)
function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "routerdone");
  }
  return path.join(os.homedir(), ".routerdone");
}
const updateDir = path.join(getDataDir(), "update");
try { fs.mkdirSync(updateDir, { recursive: true }); } catch { /* best effort */ }
const statusFile = path.join(updateDir, "status.json");
const logFile = path.join(updateDir, "install.log");

const state = {
  phase: "starting",
  packageName,
  startedAt: Date.now(),
  finishedAt: null,
  attempt: 0,
  maxRetries,
  done: false,
  success: false,
  exitCode: null,
  error: null,
  logTail: [],
};

function pushLog(line) {
  const trimmed = line.replace(/\r?\n$/, "");
  if (!trimmed) return;
  state.logTail.push(trimmed);
  if (state.logTail.length > tailLines) state.logTail = state.logTail.slice(-tailLines);
  try { fs.appendFileSync(logFile, `${trimmed}\n`); } catch { /* best effort */ }
}

function persistStatus() {
  try { fs.writeFileSync(statusFile, JSON.stringify(state, null, 2)); } catch { /* best effort */ }
}

function setPhase(phase) {
  state.phase = phase;
  persistStatus();
}

// HTTP server exposing status (browser polls this while Next server is dead)
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/update/status" || req.url === "/") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(state));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.on("error", (e) => {
  state.error = `status server error: ${e.message}`;
  persistStatus();
});

server.listen(port, "127.0.0.1", () => {
  persistStatus();
  if (updaterMode === "prepare-swap") {
    runPrepareSwap();
  } else {
    waitForAppExit().then(runInstall);
  }
});

// Check if app port is still being listened on (= app server still alive)
function isAppPortBusy() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(appPort, "127.0.0.1");
  });
}

// Wait for app process to fully exit before running npm (avoids Windows file-lock)
async function waitForAppExit() {
  setPhase("waitingForExit");
  pushLog(`[updater] waiting for app to exit (min ${Math.round(waitMinMs / 1000)}s)...`);

  // Hard minimum delay: OS needs time to release file handles
  await sleep(waitMinMs);

  // Poll app port until free or max timeout
  const deadline = Date.now() + (waitMaxMs - waitMinMs);
  while (Date.now() < deadline) {
    const busy = await isAppPortBusy();
    if (!busy) {
      pushLog(`[updater] app port :${appPort} is free, proceeding`);
      return;
    }
    await sleep(waitCheckMs);
  }
  pushLog(`[updater] timeout waiting for app, proceeding anyway`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runInstall() {
  state.attempt += 1;
  setPhase("installing");
  pushLog(`[updater] attempt ${state.attempt}/${maxRetries} - npm i -g ${packageName} --prefer-online`);

  const isWin = process.platform === "win32";
  const cmd = isWin ? "npm.cmd" : "npm";
  const args = ["i", "-g", packageName, "--prefer-online"];

  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: isWin,
  });

  child.stdout.on("data", (buf) => {
    buf.toString().split(/\r?\n/).forEach(pushLog);
    persistStatus();
  });
  child.stderr.on("data", (buf) => {
    buf.toString().split(/\r?\n/).forEach(pushLog);
    persistStatus();
  });

  child.on("error", (e) => {
    pushLog(`[updater] spawn error: ${e.message}`);
    finalize(false, null, e.message);
  });

  child.on("close", (code) => {
    pushLog(`[updater] npm exited with code ${code}`);
    if (code === 0) {
      finalize(true, code, null);
      return;
    }
    if (state.attempt < maxRetries) {
      pushLog(`[updater] retrying in ${Math.round(retryDelayMs / 1000)}s...`);
      setTimeout(runInstall, retryDelayMs);
      return;
    }
    finalize(false, code, `Install failed after ${maxRetries} attempts`);
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? `open "${url}"`
    : platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  try { spawn(cmd, { shell: true, detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
}

// Wait until app port is listening (server alive again), then open dashboard
async function waitForAppAndOpenBrowser() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const busy = await isAppPortBusy();
    if (busy) {
      openBrowser(`http://localhost:${appPort}/dashboard`);
      pushLog(`[updater] app ready, opened dashboard`);
      return;
    }
    await sleep(1000);
  }
  pushLog(`[updater] app not responding within 30s, skip browser open`);
}

function relaunchApp() {
  if (process.env.UPDATER_RELAUNCH !== "1") return;
  const cmd = process.env.UPDATER_RELAUNCH_CMD;
  if (!cmd) return;
  let args = [];
  try { args = JSON.parse(process.env.UPDATER_RELAUNCH_ARGS || "[]"); } catch { /* noop */ }
  const isWin = process.platform === "win32";
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: isWin,
      env: { ...process.env, UPDATER_RELAUNCH: "", UPDATER_RELAUNCH_CMD: "", UPDATER_RELAUNCH_ARGS: "" },
    });
    child.unref();
    pushLog(`[updater] relaunched: ${cmd} ${args.join(" ")} (pid=${child.pid})`);
    // Wait for new app to come up, then auto-open browser so user sees the result
    waitForAppAndOpenBrowser();
  } catch (e) {
    pushLog(`[updater] relaunch failed: ${e.message}`);
  }
}

function finalize(success, exitCode, error) {
  state.done = true;
  state.success = success;
  state.exitCode = exitCode;
  state.error = error;
  state.finishedAt = Date.now();
  setPhase(success ? "done" : "error");
  if (success) relaunchApp();
  // Linger so browser can poll final status, then exit & close the port
  setTimeout(() => {
    try { server.close(); } catch { /* ignore */ }
    process.exit(success ? 0 : 1);
  }, lingerMs);
}

// ---------------------------------------------------------------------------
// Prepare/swap update flow (near-zero downtime)
// Phase 1 (preparing):  npm pack downloads tarball while app stays alive
// Phase 2 (swapping):   kill old app (updater excludes itself)
// Phase 3 (installing): npm i -g <local-tarball> (fast, no network)
// Phase 4 (done):       relaunch app
// Fallback: if pack/install fails -> legacy remote install (kill + npm i -g)
// ---------------------------------------------------------------------------

// Kill MITM server by PID file (mirror appUpdater.js, using local getDataDir)
function killMitmByPidFileSwap() {
  try {
    const mitmPidFile = path.join(getDataDir(), "mitm", ".mitm.pid");
    if (!fs.existsSync(mitmPidFile)) return;
    const pid = parseInt(fs.readFileSync(mitmPidFile, "utf8").trim(), 10);
    if (!pid) return;
    if (process.platform === "win32") {
      try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch {
        try { execSync(`powershell -NonInteractive -WindowStyle Hidden -Command "Stop-Process -Id ${pid} -Force"`, { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch { /* best effort */ }
      }
    } else {
      try { execSync(`sudo -n kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 3000 }); } catch {
        try { process.kill(pid, "SIGKILL"); } catch { /* best effort */ }
      }
    }
    try { fs.unlinkSync(mitmPidFile); } catch { /* best effort */ }
  } catch { /* best effort */ }
}

// Collect app PIDs for the swap kill, excluding the detached updater process
function collectAppPidsForKill() {
  const pids = [];
  const platform = process.platform;
  if (platform === "win32") {
    try {
      const psCmd = `powershell -NonInteractive -WindowStyle Hidden -Command "Get-WmiObject Win32_Process -Filter 'Name=\"node.exe\"' | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`;
      const output = execSync(psCmd, { encoding: "utf8", windowsHide: true, timeout: 5000 });
      output.split("\n").slice(1).filter(l => l.trim()).forEach(line => {
        const lower = line.toLowerCase();
        const isAppProcess = lower.includes("routerdone") ||
          lower.includes("next-server") ||
          lower.includes("\\bin\\app\\") ||
          lower.includes("/bin/app/") ||
          lower.includes("cli.js");
        const isUpdaterProc = lower.includes("updater.js");
        if (isAppProcess && !isUpdaterProc) {
          const match = line.match(/^"(\d+)"/);
          if (match && match[1] && match[1] !== process.pid.toString()) pids.push(match[1]);
        }
      });
    } catch { /* no processes */ }
    for (const procName of ["cloudflared", "tray_windows_release"]) {
      try {
        const cmd = `powershell -NonInteractive -WindowStyle Hidden -Command "Get-Process ${procName} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`;
        const out = execSync(cmd, { encoding: "utf8", windowsHide: true, timeout: 5000 });
        out.split("\n").forEach(l => {
          const pid = l.trim();
          if (pid && !isNaN(pid)) pids.push(pid);
        });
      } catch { /* not running */ }
    }
  } else {
    try {
      const output = execSync("ps aux 2>/dev/null", { encoding: "utf8", timeout: 5000 });
      output.split("\n").forEach(line => {
        const isAppProcess = line.includes("routerdone") ||
          line.includes("next-server") ||
          line.includes("cloudflared") ||
          line.includes("/bin/app/") ||
          line.includes("tray_darwin") ||
          line.includes("tray_linux");
        const isUpdaterProc = line.includes("updater.js");
        if (isAppProcess && !isUpdaterProc) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[1];
          if (pid && !isNaN(pid) && pid !== process.pid.toString()) pids.push(pid);
        }
      });
    } catch { /* no processes */ }
  }
  return pids;
}


// Kill all app-related processes to release file locks (excludes updater)
function killAppProcessesForSwap() {
  killMitmByPidFileSwap();
  const pids = collectAppPidsForKill();
  const platform = process.platform;
  pids.forEach(pid => {
    try {
      if (platform === "win32") {
        execSync(`taskkill /F /PID ${pid} 2>nul`, { stdio: "ignore", shell: true, windowsHide: true, timeout: 3000 });
      } else {
        execSync(`kill -9 ${pid} 2>/dev/null`, { stdio: "ignore", timeout: 3000 });
      }
    } catch { /* already dead */ }
  });
  return pids.length;
}

// Phase 1: download tarball via `npm pack` while app stays alive (no kill yet)
function npmPackToStaging() {
  return new Promise((resolve, reject) => {
    const stagingDir = path.join(updateDir, "staging");
    try { fs.mkdirSync(stagingDir, { recursive: true }); } catch { /* best effort */ }
    // Clean stale tarballs from previous attempts
    try { fs.readdirSync(stagingDir).forEach(f => { if (f.endsWith(".tgz")) { try { fs.unlinkSync(path.join(stagingDir, f)); } catch { /* ignore */ } } }); } catch { /* ignore */ }
    const isWin = process.platform === "win32";
    const cmd = isWin ? "npm.cmd" : "npm";
    const args = ["pack", `${packageName}@latest`];
    pushLog(`[updater] prepare: npm pack ${packageName}@latest -> ${stagingDir}`);
    const child = spawn(cmd, args, { cwd: stagingDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: isWin });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error(`npm pack timed out after ${Math.round(packTimeoutMs / 1000)}s`));
    }, packTimeoutMs);
    child.stdout.on("data", (buf) => { stdout += buf.toString(); });
    child.stderr.on("data", (buf) => {
      const s = buf.toString();
      stderr += s;
      s.split(/\r?\n/).forEach(pushLog);
      persistStatus();
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      stdout.split(/\r?\n/).forEach(pushLog);
      persistStatus();
      if (code !== 0) {
        reject(new Error(`npm pack exited ${code}${stderr ? ": " + stderr.slice(0, 200) : ""}`));
        return;
      }
      // npm pack prints the tarball filename (last non-empty stdout line)
      const tarballName = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop();
      if (!tarballName) { reject(new Error("npm pack produced no tarball name")); return; }
      const tarballPath = path.join(stagingDir, tarballName);
      if (!fs.existsSync(tarballPath)) { reject(new Error(`tarball not found: ${tarballPath}`)); return; }
      pushLog(`[updater] prepare: tarball ready ${tarballName}`);
      resolve(tarballPath);
    });
  });
}

// Phase 3: install from local tarball (fast, no network)
function installFromTarball(tarballPath) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "npm.cmd" : "npm";
    const args = ["i", "-g", tarballPath];
    pushLog(`[updater] install: npm i -g ${tarballPath}`);
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: isWin });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error("npm i -g (tarball) timed out"));
    }, packTimeoutMs);
    child.stdout.on("data", (buf) => { buf.toString().split(/\r?\n/).forEach(pushLog); persistStatus(); });
    child.stderr.on("data", (buf) => { buf.toString().split(/\r?\n/).forEach(pushLog); persistStatus(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      pushLog(`[updater] install: npm i -g exited ${code}`);
      if (code === 0) resolve();
      else reject(new Error(`npm i -g (tarball) exited ${code}`));
    });
  });
}

// Orchestrate near-zero-downtime update
async function runPrepareSwap() {
  pushLog(`[updater] prepare-swap mode starting`);
  // Phase 1: prepare (download tarball while app keeps serving traffic)
  setPhase("preparing");
  let tarballPath;
  try {
    tarballPath = await npmPackToStaging();
  } catch (e) {
    pushLog(`[updater] prepare failed: ${e.message} -> fallback to legacy remote install`);
    setPhase("swapping");
    killAppProcessesForSwap();
    await waitForAppExit();
    runInstall();
    return;
  }
  // Phase 2: swap (kill old app now that tarball is staged)
  setPhase("swapping");
  const killed = killAppProcessesForSwap();
  pushLog(`[updater] swap: killed ${killed} app process(es)`);
  // Give OS time to release file handles (waitForAppExit enforces min delay)
  await waitForAppExit();
  // Phase 3: install from local tarball (fast, no network)
  setPhase("installing");
  try {
    await installFromTarball(tarballPath);
    finalize(true, 0, null);
  } catch (e) {
    pushLog(`[updater] tarball install failed: ${e.message} -> fallback to remote install`);
    runInstall();
  }
}
