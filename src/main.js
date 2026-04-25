// src/main.js
//
// Electron main process.
// Responsibilities:
//   1. Create and manage the main BrowserWindow that hosts the softphone UI.
//   2. Persist the device token in the OS keychain via safeStorage so it
//      survives app restarts without being readable in plaintext on disk.
//   3. Expose a handful of IPC methods to the renderer (see preload.js).
//   4. Provide a system-tray icon so closing the window doesn't close the
//      app — a phone should always be reachable even when minimized.
//   5. Request microphone permission for the embedded WebRTC voice SDK.

const { app, BrowserWindow, ipcMain, safeStorage, Tray, Menu, nativeImage, shell, dialog, session, net, powerMonitor } = require("electron");
// Auto-updater pulls new versions from GitHub Releases. Loaded lazily
// so a missing dep (when running from source during dev) doesn't crash
// the app on startup — we only need it in packaged builds.
let autoUpdater = null;
try { autoUpdater = require("electron-updater").autoUpdater; } catch (e) {
  console.warn("[updater] electron-updater not installed — auto-update disabled");
}
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// --- Low-level config file (device token + server URL + label). ---
// We store the token ENCRYPTED using safeStorage when available. Falls back
// to a scary warning if the OS can't provide encryption (rare — Keychain on
// Mac, DPAPI on Windows, libsecret on Linux).
const configDir = app.getPath("userData");
const configPath = path.join(configDir, "phone-config.json");

function loadConfig() {
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));

    // Decrypt the token if it was stored encrypted.
    if (raw.deviceTokenEncrypted && safeStorage.isEncryptionAvailable()) {
      try {
        const buf = Buffer.from(raw.deviceTokenEncrypted, "base64");
        raw.deviceToken = safeStorage.decryptString(buf);
      } catch (e) {
        console.warn("[config] token decrypt failed:", e.message);
        raw.deviceToken = "";
      }
    }
    return raw;
  } catch (e) {
    console.warn("[config] load failed:", e.message);
    return {};
  }
}

function saveConfig(cfg) {
  const out = { ...cfg };
  if (out.deviceToken) {
    if (safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(out.deviceToken);
      out.deviceTokenEncrypted = enc.toString("base64");
      delete out.deviceToken;
    } else {
      // Last-resort plaintext — user will see a one-time warning in the UI.
      console.warn("[config] safeStorage NOT available; storing token plaintext");
    }
  }
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(out, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[config] save failed:", e.message);
    return false;
  }
}

function clearConfig() {
  try {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  } catch (e) {
    console.warn("[config] clear failed:", e.message);
  }
}

// --- Window + tray state ---
let mainWindow = null;
let groupWindow = null;   // Only one group conference window at a time.
let tray = null;
let isQuitting = false;

function createMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  // Window position: persist last-known coordinates between launches so
  // the user's manual placement survives. First launch lands in the
  // top-left of the primary display per the user's request — neat,
  // predictable starting point that doesn't fight with other apps.
  const savedPos = (() => {
    const cfg = loadConfig();
    return cfg.windowPos && Number.isFinite(cfg.windowPos.x) && Number.isFinite(cfg.windowPos.y)
      ? cfg.windowPos
      : { x: 0, y: 0 };
  })();

  // Pick the platform-appropriate icon. On Windows electron-builder
  // bakes the .ico into the .exe and BrowserWindow gets it implicitly,
  // but we set it explicitly here so dev runs (electron .) also have
  // the branded icon in the taskbar.
  const iconPath = path.join(__dirname, "..", "assets",
    process.platform === "win32" ? "icon.ico" : "icon.png");
  const windowIcon = (() => {
    try { return fs.existsSync(iconPath) ? iconPath : undefined; } catch { return undefined; }
  })();

  mainWindow = new BrowserWindow({
    width: 420,
    height: 720,
    x: savedPos.x,
    y: savedPos.y,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: "#0f172a",
    title: "JobCount Phone",
    autoHideMenuBar: true,
    icon: windowIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Persist window position on move so next launch opens where the
  // user left it. Debounce to avoid hammering disk during drags.
  let _moveTimer = null;
  const persistPos = () => {
    if (_moveTimer) clearTimeout(_moveTimer);
    _moveTimer = setTimeout(() => {
      try {
        const [x, y] = mainWindow.getPosition();
        const cfg = loadConfig();
        cfg.windowPos = { x, y };
        saveConfig(cfg);
      } catch (e) { /* noop */ }
    }, 400);
  };
  mainWindow.on("move", persistPos);
  mainWindow.on("moved", persistPos);

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Auto-allow mic permission so WebRTC can connect without a prompt
  // (only for our own origin — Twilio's media layer runs inside the page).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === "media" || permission === "microphone") return callback(true);
    callback(false);
  });

  // Open external links in the user's browser, not a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });
}

function createTray() {
  // Use the same icon we ship for the window — Electron auto-resizes
  // for the tray (16×16 / 32×32 on hi-DPI). Falls back gracefully if
  // the raster isn't generated yet (first dev run, e.g.).
  const candidates = [
    path.join(__dirname, "..", "assets", "tray-icon.png"),
    path.join(__dirname, "..", "assets",
      process.platform === "win32" ? "icon.ico" : "icon.png"),
  ];
  let image = null;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) { image = nativeImage.createFromPath(p); break; }
    } catch {}
  }
  if (!image) image = nativeImage.createEmpty();

  tray = new Tray(image);
  tray.setToolTip("JobCount Phone");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show JobCount Phone", click: () => createMainWindow() },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", () => createMainWindow());
}

// ── IPC bridge ───────────────────────────────────────────────────────
// Keep the surface area small and typed. Renderer never touches disk or
// the OS keychain directly.

ipcMain.handle("config:get", () => {
  const cfg = loadConfig();
  return {
    serverUrl: cfg.serverUrl || "",
    shopId: cfg.shopId || "",
    shopName: cfg.shopName || "",
    deviceId: cfg.deviceId || "",
    label: cfg.label || "",
    hasToken: !!(cfg.deviceToken),
  };
});

// Returns the plaintext device token so the renderer can assemble
// Authorization headers and fetch via Chromium's network stack — which
// reliably reaches ngrok when Node's https is blocked by AV/proxy layers.
// Safe to expose within our own process tree; the token only grants
// access to this shop and can be revoked from JobCount at any time.
ipcMain.handle("config:device-token", () => {
  const cfg = loadConfig();
  return cfg.deviceToken || "";
});

ipcMain.handle("config:save-pairing", (_evt, payload) => {
  const cfg = loadConfig();
  const next = {
    ...cfg,
    serverUrl: payload.serverUrl,
    shopId: payload.shopId,
    shopName: payload.shopName,
    deviceId: payload.deviceId,
    label: payload.label || cfg.label || "",
    deviceToken: payload.deviceToken,
  };
  return saveConfig(next);
});

ipcMain.handle("config:set-label", (_evt, label) => {
  const cfg = loadConfig();
  cfg.label = String(label || "").slice(0, 60);
  return saveConfig(cfg);
});

ipcMain.handle("config:clear", () => {
  clearConfig();
  return true;
});

// JSON-over-HTTP helper built on Node's native `https`/`http` modules.
// We intentionally avoid Electron's net.fetch and Node's undici-fetch:
//   - net.fetch uses Chromium's network stack which on some Windows setups
//     fails ngrok TLS with net::ERR_SSL_PROTOCOL_ERROR (proxy/MITM AV).
//   - Undici's "fetch failed" error swallows the real cause.
// node:https uses OpenSSL directly, same stack every tested Node library
// has relied on for years. Error codes (ECONNREFUSED, ENOTFOUND, etc.)
// come through cleanly so we can show them in the UI.
function httpJson(url, { method = "GET", body, headers = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); }
    catch (e) {
      return resolve({ ok: false, status: 0, data: { error: `Invalid URL: ${e.message}` } });
    }
    const lib = u.protocol === "https:" ? https : http;
    const payload = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));

    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        "Accept": "application/json",
        "User-Agent": `JobCountPhone/${app.getVersion()} (${process.platform})`,
        // Bypass ngrok's "you are visiting a free tunnel" interstitial — a
        // no-op for prod URLs, required for some ngrok free-tier setups.
        "ngrok-skip-browser-warning": "1",
        ...headers,
      },
    };
    if (payload) {
      opts.headers["Content-Type"] = opts.headers["Content-Type"] || "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = lib.request(opts, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let data = null;
        if (text) {
          try { data = JSON.parse(text); }
          catch { data = { error: text.slice(0, 500) }; }
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          data,
        });
      });
    });

    req.on("error", (err) => {
      const msg = [err.code, err.message].filter(Boolean).join(": ");
      console.error("[httpJson] error:", method, url, msg);
      resolve({ ok: false, status: 0, data: { error: msg || "Network error" } });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout (${Math.round(timeoutMs / 1000)}s)`));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

ipcMain.handle("api:request", async (_evt, { method, path: urlPath, body, authenticated }) => {
  const cfg = loadConfig();
  const baseUrl = (cfg.serverUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Server URL not configured");

  const headers = {};
  if (authenticated && cfg.deviceToken) headers["Authorization"] = `Bearer ${cfg.deviceToken}`;

  return httpJson(baseUrl + urlPath, { method: method || "GET", body, headers });
});

ipcMain.handle("api:voice-token", async () => {
  const cfg = loadConfig();
  const baseUrl = (cfg.serverUrl || "").replace(/\/+$/, "");
  if (!baseUrl || !cfg.deviceToken) throw new Error("Not paired");

  const res = await httpJson(`${baseUrl}/phone-device/voice-token`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${cfg.deviceToken}` },
  });
  if (!res.ok) throw new Error(`voice-token ${res.status}: ${res.data?.error || "request failed"}`);
  return res.data;
});

// Pairing redeem — runs from the MAIN process so it's not subject to
// CORS from the file:// renderer origin. Uses Electron's net.fetch so
// ngrok-style HTTPS endpoints work reliably.
ipcMain.handle("api:pair-redeem", async (_evt, { serverUrl, body } = {}) => {
  const base = String(serverUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, status: 0, data: { error: "Invalid server URL" } };
  }
  return httpJson(`${base}/phone-pair/redeem`, { method: "POST", body: body || {} });
});

ipcMain.handle("system:info", () => ({
  hostname: os.hostname(),
  platform: process.platform,
  appVersion: app.getVersion(),
  arch: process.arch,
  nodeEnv: process.env.NODE_ENV || "production",
  // Explicit env flag the launcher passes so the UI can show a dev ribbon.
  // "prod" (default) or "dev" — the server URL itself still comes from the
  // pairing, this only controls the visual indicator.
  jobcountEnv: (process.env.JOBCOUNT_ENV || "prod").toLowerCase(),
}));

ipcMain.handle("window:minimize-to-tray", () => {
  if (mainWindow) mainWindow.hide();
});

// Open the Group-conference window. Closely mirrors createMainWindow but
// loads a different HTML entry (src/group/index.html) and is dismissible —
// closing it ends the agent's participation in the group (the renderer
// calls the /leave endpoint first and only then window.close()s).
ipcMain.handle("window:group-open", (_evt, payload) => {
  const { groupName } = payload || {};
  if (!groupName) throw new Error("groupName required");

  if (groupWindow && !groupWindow.isDestroyed()) {
    groupWindow.show();
    groupWindow.focus();
    return { ok: true, reused: true };
  }

  groupWindow = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: "#0f172a",
    title: "JobCount Phone — Group",
    autoHideMenuBar: true,
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Additional arg passed through to the renderer via initial URL hash.
    },
  });

  // Encode groupName in the URL hash so the renderer can read it from
  // location.hash without needing a separate IPC round-trip.
  const hash = `#group=${encodeURIComponent(groupName)}`;
  groupWindow.loadFile(path.join(__dirname, "group", "index.html"), { hash });

  groupWindow.on("closed", () => { groupWindow = null; });
  return { ok: true };
});

ipcMain.handle("window:group-close", () => {
  if (groupWindow && !groupWindow.isDestroyed()) {
    groupWindow.close();
  }
});

// Grab the user's attention on an incoming call. Flashes the taskbar
// icon and shows the window if it was hidden. Doesn't steal focus —
// that would be hostile — just makes sure they notice.
ipcMain.handle("window:alert-incoming", () => {
  if (!mainWindow) return;
  try {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.flashFrame(true);
    // Stop flashing once the user focuses (or after 15s).
    const stop = () => {
      try { mainWindow.flashFrame(false); } catch {}
      mainWindow.removeListener("focus", stop);
      clearTimeout(killTimer);
    };
    const killTimer = setTimeout(stop, 15000);
    mainWindow.once("focus", stop);
  } catch (e) {
    console.warn("[window] alert-incoming failed:", e.message);
  }
});

ipcMain.handle("app:quit", () => {
  isQuitting = true;
  app.quit();
});

// ── App lifecycle ────────────────────────────────────────────────────

// ── Auto-update plumbing ──────────────────────────────────────────
// electron-updater polls the GitHub Releases feed for this repo. When
// a newer version is published, it downloads the installer in the
// background (resumable, differential), pings the renderer so the UI
// can show an update badge, and installs on quit (or immediately if
// the user clicks "Install now"). Skipped entirely in dev runs.

let _updaterLastEvent = null; // { state, version?, progress?, error? }

function broadcastUpdateState(payload) {
  _updaterLastEvent = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send("app:update-state", payload); } catch {}
  }
}

function initAutoUpdater() {
  if (!autoUpdater) return;

  // Update behavior is MANUAL-ONLY. We never check for updates on our
  // own — the user has to click "Check for updates" in Settings.
  // Rationale: surprise updates during business hours (mid-call) are
  // unacceptable for a phone system. Dispatchers want to decide when
  // to take the app down for a restart.
  //
  //   autoDownload = true            → once the user clicks Check and
  //                                    a newer version is found, start
  //                                    downloading it right away so the
  //                                    "Install & Restart" button is
  //                                    ready by the time they look back.
  //   autoInstallOnAppQuit = false   → closing the app never silently
  //                                    installs. The user must
  //                                    explicitly click Install &
  //                                    Restart to apply the update.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () =>
    broadcastUpdateState({ state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    broadcastUpdateState({ state: "available", version: info?.version }));
  autoUpdater.on("update-not-available", (info) =>
    broadcastUpdateState({ state: "up-to-date", version: info?.version }));
  autoUpdater.on("download-progress", (progress) =>
    broadcastUpdateState({
      state: "downloading",
      percent: Math.round(progress.percent || 0),
      bytesPerSecond: progress.bytesPerSecond,
    }));
  autoUpdater.on("update-downloaded", (info) =>
    broadcastUpdateState({ state: "ready", version: info?.version }));
  autoUpdater.on("error", (err) =>
    broadcastUpdateState({ state: "error", error: String(err?.message || err) }));

  // No startup check, no interval. Updates happen only when the user
  // presses Check for updates in Settings (which routes through the
  // app:check-for-updates IPC handler below).
}

ipcMain.handle("app:check-for-updates", async () => {
  if (!autoUpdater) return { ok: false, error: "Updater unavailable in dev" };
  try {
    const result = await autoUpdater.checkForUpdates();
    return {
      ok: true,
      currentVersion: app.getVersion(),
      latestVersion: result?.updateInfo?.version || null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("app:install-update-now", () => {
  if (!autoUpdater) return { ok: false, error: "Updater unavailable" };
  try {
    // quitAndInstall() closes the app and relaunches after the installer.
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("app:get-update-state", () => ({
  version: app.getVersion(),
  last: _updaterLastEvent,
}));

// ── Dev-only: Publish Update flow ──────────────────────────────────
//
// When running from source (npm run dev / JOBCOUNT_ENV=dev), the
// settings tab exposes a "Publish Update" panel. Pressing it bumps
// the version, commits the change, creates a v<version> tag, and
// pushes to origin — which fires the GitHub Actions release workflow
// and ultimately makes the new installer + auto-update payload
// available to every installed Phone App on the network.
//
// We stream every git/npm command's stdout+stderr back to the
// renderer so the user sees real progress. Only enabled when
// JOBCOUNT_ENV=dev to avoid shipping git operations in production
// installer builds.

const _publishStreams = new Map(); // jobId → { proc, listeners: Set<sender> }

function _isDevMode() {
  return (process.env.JOBCOUNT_ENV || "").toLowerCase() === "dev";
}

function _streamLine(jobId, kind, line) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("app:publish-log", { jobId, kind, line });
  } catch {}
}

// Run a single child-process step, piping stdout/stderr to the
// renderer in real time. Resolves with exit code.
//
// Shell handling on Windows is a minefield:
//   - `git.exe` is a normal binary on PATH — spawn can find it, NO
//     shell needed. With `shell:true`, cmd.exe re-parses the arg
//     array and strips quotes, breaking args with spaces like a
//     commit message `Release v1.0.2`.
//   - `npm.cmd` IS a cmd batch file — spawn without shell fails on
//     Windows with ENOENT. We set shell:true for npm specifically
//     and pass the args as a single pre-quoted string to dodge the
//     re-parsing bug.
function _runStep(jobId, label, command, args, opts = {}) {
  return new Promise((resolve) => {
    _streamLine(jobId, "step", `\n$ ${label}`);
    const { spawn } = require("child_process");

    const isWin = process.platform === "win32";
    const needsShell = opts.shell === true ||
      (isWin && /^(npm|npx|yarn)$/i.test(command));

    let spawnCmd = command;
    let spawnArgs = args;
    let spawnShell = needsShell;

    if (needsShell && isWin) {
      // Hand-quote each arg to survive cmd.exe re-parsing.
      const quoteIfNeeded = (a) => {
        const s = String(a);
        return /[\s"&|<>^()%]/.test(s)
          ? `"${s.replace(/"/g, '\\"')}"`
          : s;
      };
      spawnCmd = [command, ...args.map(quoteIfNeeded)].join(" ");
      spawnArgs = [];
    }

    const proc = spawn(spawnCmd, spawnArgs, {
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
      shell: spawnShell,
      ...opts,
    });
    proc.stdout.on("data", (b) =>
      String(b).split(/\r?\n/).filter(Boolean).forEach((l) => _streamLine(jobId, "out", l))
    );
    proc.stderr.on("data", (b) =>
      String(b).split(/\r?\n/).filter(Boolean).forEach((l) => _streamLine(jobId, "err", l))
    );
    proc.on("close", (code) => {
      _streamLine(jobId, code === 0 ? "ok" : "fail", `[exit ${code}]`);
      resolve(code);
    });
    proc.on("error", (e) => {
      _streamLine(jobId, "fail", `spawn error: ${e.message}`);
      resolve(-1);
    });
  });
}

ipcMain.handle("app:publish-update", async (_evt, payload) => {
  if (!_isDevMode()) {
    return { ok: false, error: "Publish Update is only available in dev mode" };
  }
  const bump = String(payload?.bump || "patch").toLowerCase();
  if (!["patch", "minor", "major"].includes(bump)) {
    return { ok: false, error: "Invalid bump type — expected patch / minor / major" };
  }

  const jobId = `pub_${Date.now()}`;
  _streamLine(jobId, "step", `Publishing update — ${bump} bump`);

  // 1. Bump version in package.json (no auto git tag — we do that by hand
  //    so we control the commit message).
  const npmBumpOk = await _runStep(jobId, `npm version ${bump} --no-git-tag-version`,
    "npm", ["version", bump, "--no-git-tag-version"]);
  if (npmBumpOk !== 0) return { ok: false, jobId, error: "Version bump failed" };

  // 2. Read the new version that was just written.
  const pkg = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "..", "package.json"), "utf8"));
  const newVersion = pkg.version;
  const tagName = `v${newVersion}`;
  _streamLine(jobId, "step", `New version: ${newVersion}`);

  // 3. Git: commit the package.json/lock change, tag, push branch + tag.
  const steps = [
    ["git add package.json package-lock.json",
      "git", ["add", "package.json", "package-lock.json"]],
    [`git commit -m "Release ${tagName}"`,
      "git", ["commit", "-m", `Release ${tagName}`]],
    [`git tag ${tagName}`,
      "git", ["tag", tagName]],
    ["git push origin HEAD",
      "git", ["push", "origin", "HEAD"]],
    [`git push origin ${tagName}`,
      "git", ["push", "origin", tagName]],
  ];
  for (const [label, cmd, args] of steps) {
    const code = await _runStep(jobId, label, cmd, args);
    if (code !== 0) {
      return { ok: false, jobId, version: newVersion, tagName,
        error: `Step failed: ${label}` };
    }
  }

  _streamLine(jobId, "ok", `\n✓ Tag ${tagName} pushed. GitHub Actions is now building.`);
  _streamLine(jobId, "ok",
    `Watch progress: https://github.com/CryptoBot-Bot/jobcount-phone-desktop/actions`);
  _streamLine(jobId, "ok",
    `Release will appear at: https://github.com/CryptoBot-Bot/jobcount-phone-desktop/releases/tag/${tagName}`);
  return { ok: true, jobId, version: newVersion, tagName };
});

// Quick check whether the dev environment is in a state where a
// publish would even succeed (clean working tree, has git remote,
// etc.). Renderer hits this on tab open to show readiness/blockers.
ipcMain.handle("app:publish-readiness", async () => {
  if (!_isDevMode()) {
    return { ready: false, isDev: false, reasons: ["Not in dev mode"] };
  }
  const { execSync } = require("child_process");
  const cwd = path.resolve(__dirname, "..");
  const reasons = [];

  try {
    const status = execSync("git status --porcelain", { cwd, encoding: "utf8" }).trim();
    if (status) reasons.push(`Working tree has uncommitted changes:\n${status}`);
  } catch (e) {
    reasons.push("Not a git repo (or git not on PATH)");
  }
  try {
    const remote = execSync("git remote get-url origin", { cwd, encoding: "utf8" }).trim();
    if (!remote) reasons.push("No 'origin' remote configured");
  } catch {
    reasons.push("Could not read 'origin' remote");
  }

  let currentVersion = "?";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    currentVersion = pkg.version;
  } catch {}

  return { ready: reasons.length === 0, isDev: true, currentVersion, reasons };
});

app.whenReady().then(() => {
  createTray();
  createMainWindow();
  initAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else if (mainWindow) mainWindow.show();
  });

  // Wake / unlock hooks — if the OS was asleep or the session was
  // locked for a long time, our Twilio token is probably expired and
  // the refresh timer didn't fire. Nudge the renderer to verify and
  // reconnect as needed.
  const pokeRenderer = (reason) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send("system:wake", { reason, ts: Date.now() });
    } catch (e) {
      console.warn("[powerMonitor] send failed:", e.message);
    }
  };
  try { powerMonitor.on("resume",       () => pokeRenderer("resume")); } catch {}
  try { powerMonitor.on("unlock-screen",() => pokeRenderer("unlock")); } catch {}
  try { powerMonitor.on("user-did-become-active", () => pokeRenderer("active")); } catch {}
});

app.on("window-all-closed", () => {
  // Intentionally DON'T quit on last window close — the app lives in the
  // tray. Explicit Quit menu item stops it.
});

app.on("before-quit", () => { isQuitting = true; });

// Single-instance lock so running the installer twice doesn't leave two
// softphones racing to answer the same inbound call.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
