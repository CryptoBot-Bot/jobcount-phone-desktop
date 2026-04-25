// src/renderer/app.js
//
// Renderer-side controller for the JobCount Phone desktop app.
//
// State machine:
//   'loading'  → initial; read config from main
//   'pairing'  → no token stored; user enters code
//   'phone'    → paired; Twilio Device connected; softphone live
//   'settings' → overlay for label + audio device picker + unpair
//
// Uses window.jobcountPhone (preload bridge) for anything privileged:
// HTTP calls, keychain token read/write, system info.
//
// Twilio Voice SDK is loaded via <script> tag in index.html and exposes
// the global `Twilio.Device` constructor.

"use strict";

(function () {
  // ─── DOM handles ───────────────────────────────────────────────
  const screens = {
    loading:  document.getElementById("screenLoading"),
    pairing:  document.getElementById("screenPairing"),
    phone:    document.getElementById("screenPhone"),
    settings: document.getElementById("screenSettings"),
  };
  const topbarSub = document.getElementById("topbarSub");
  const statusDot = document.querySelector("#statusPill .dot");
  const statusText = document.getElementById("statusText");
  const loadingSub = document.getElementById("loadingSub");
  const btnSettings = document.getElementById("btnSettings");
  const btnMinimize = document.getElementById("btnMinimize");

  // Pair form
  const pairPayload = document.getElementById("pairPayload");
  const pairServerBadge = document.getElementById("pairServerBadge");
  const pairServerUrl = document.getElementById("pairServerUrl");
  const pairLabel = document.getElementById("pairLabel");
  const pairCode = document.getElementById("pairCode");
  const btnSubmitPair = document.getElementById("btnSubmitPair");
  const pairStatus = document.getElementById("pairStatus");

  // In-memory state for the pairing flow — the parsed pairing info
  // extracted from the JSON payload or Advanced URL field.
  let pairServerUrlResolved = "";
  let pairShopNameResolved = "";

  // Phone
  const callHero = document.getElementById("callHero");
  const callLabel = document.getElementById("callLabel");
  const callTitle = document.getElementById("callTitle");
  const callMeta = document.getElementById("callMeta");
  const callTimer = document.getElementById("callTimer");
  const btnAnswer = document.getElementById("btnAnswer");
  const btnReject = document.getElementById("btnReject");
  const btnHangup = document.getElementById("btnHangup");
  const btnMute = document.getElementById("btnMute");
  const muteLabel = document.getElementById("muteLabel");
  const btnHold = document.getElementById("btnHold");
  const holdLabel = document.getElementById("holdLabel");
  const btnTransfer = document.getElementById("btnTransfer");
  const transferPicker = document.getElementById("transferPicker");
  const transferPickerBody = document.getElementById("transferPickerBody");
  const btnTransferClose = document.getElementById("btnTransferClose");
  const btnGroup = document.getElementById("btnGroup");
  const dialInput = document.getElementById("dialInput");
  const btnDial = document.getElementById("btnDial");
  const btnBackspace = document.getElementById("btnBackspace");
  const keys = document.querySelectorAll(".keypad .key");

  // Live Queue + Held Calls
  const queueList = document.getElementById("queueList");
  const queueCount = document.getElementById("queueCount");
  const heldList = document.getElementById("heldList");
  const heldCount = document.getElementById("heldCount");
  const btnAnswerNext = document.getElementById("btnAnswerNext");

  // Settings
  const settingsLabel = document.getElementById("settingsLabel");
  const selectMicrophone = document.getElementById("selectMicrophone");
  const selectSpeaker = document.getElementById("selectSpeaker");
  const settingsShop = document.getElementById("settingsShop");
  const settingsDeviceId = document.getElementById("settingsDeviceId");
  const settingsServer = document.getElementById("settingsServer");
  const btnSaveSettings = document.getElementById("btnSaveSettings");
  const btnBackFromSettings = document.getElementById("btnBackFromSettings");
  const btnUnpair = document.getElementById("btnUnpair");

  // ─── State ─────────────────────────────────────────────────────
  let config = null;           // { serverUrl, shopId, shopName, deviceId, label, hasToken }
  let device = null;           // Twilio.Device instance
  let activeCall = null;       // current Twilio.Call (incoming or outgoing)
  let activeDirection = null;  // "incoming" | "outgoing"
  let callTimerHandle = null;
  let callStartedAt = null;
  let tokenRefreshTimer = null;
  let presenceSocket = null;   // socket.io-client connection to /phone-live

  // Current customer call SID (for Hold/Hangup via REST). Set when a call
  // arrives (from customParameters) or on accept for outgoing.
  let currentCustomerCallSid = null;

  // Reconnect state — true while we're tearing down and re-building the
  // Twilio Device. Prevents overlapping recovery attempts and lets the
  // UI show a "Reconnecting…" status.
  let _reconnecting = false;

  // True when launched with JOBCOUNT_ENV=dev (npm run dev). Drives
  // both the DEV ribbon and the behavior of the auto-update UI —
  // dev mode never shows the "Update ready" pill because we're the
  // ones publishing updates, not consuming them.
  //
  // Sourced synchronously from preload's jobcountEnv bridge so every
  // render call sees the correct flag — no IPC round-trip race.
  let _isDevMode = (() => {
    try { return (window.jobcountEnv?.jobcountEnv || "") === "dev"; }
    catch { return false; }
  })();

  // Auto-answer hint from server — see presenceSocket 'phone:auto-answer'.
  // { groupName, reason, expiresAt } or null. Consumed once by the next
  // incoming call, then cleared.
  let _autoAnswerHint = null;

  // Active group name when the call has been promoted to a conference.
  // While non-null, Hold / Transfer on the main window are disabled —
  // those operations only make sense on a 1:1 Dial-Client call and would
  // tear down the conference. Participant management lives in the
  // dedicated group window instead. Cleared on call disconnect.
  let currentGroupName = null;

  // Local cached lists of queue + held so we can render optimistically.
  let queueState = [];
  let heldState = [];
  let queuePollTimer = null;
  let heldPollTimer = null;

  // ─── Screen helpers ────────────────────────────────────────────
  function showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => {
      if (!el) return;
      if (k === name) el.hidden = false;
      else el.hidden = true;
    });
    // Settings button only visible when paired AND not already in settings
    btnSettings.style.display = (name === "phone" || name === "settings") ? "" : "none";
  }

  function setStatus(kind, text) {
    // kind: 'gray' | 'yellow' | 'green' | 'red'
    statusDot.className = "dot dot-" + kind;
    statusText.textContent = text;
  }

  function setCallState(state, payload) {
    callHero.classList.remove("ringing", "in-call");

    const enable = (el, yes) => { el.disabled = !yes; };

    switch (state) {
      case "idle":
        callLabel.textContent = "Ready";
        callTitle.textContent = "Waiting for calls…";
        callMeta.textContent = "";
        callTimer.hidden = true;
        stopCallTimer();
        enable(btnAnswer, false);
        enable(btnReject, false);
        enable(btnHangup, false);
        enable(btnMute, false);
        if (btnHold) enable(btnHold, false);
        if (btnTransfer) enable(btnTransfer, false);
        if (btnGroup) enable(btnGroup, false);
        break;
      case "ringing":
        callHero.classList.add("ringing");
        callLabel.textContent = "Incoming Call";
        callTitle.textContent = payload?.caller || "Unknown";
        callMeta.textContent = payload?.meta || "";
        callTimer.hidden = true;
        enable(btnAnswer, true);
        enable(btnReject, true);
        enable(btnHangup, false);
        enable(btnMute, false);
        if (btnHold) enable(btnHold, false);
        if (btnTransfer) enable(btnTransfer, false);
        if (btnGroup) enable(btnGroup, false);
        break;
      case "dialing":
        callLabel.textContent = "Dialing";
        callTitle.textContent = payload?.to || "";
        callMeta.textContent = "";
        callTimer.hidden = true;
        enable(btnAnswer, false);
        enable(btnReject, false);
        enable(btnHangup, true);
        enable(btnMute, true);
        if (btnHold) enable(btnHold, false); // no CallSid until connect
        if (btnGroup) enable(btnGroup, false);
        break;
      case "in-call":
        callHero.classList.add("in-call");
        callHero.classList.toggle("in-group", !!currentGroupName);
        callLabel.textContent = currentGroupName ? "Group Call" : "On Call";
        callTitle.textContent = payload?.caller || "";
        // In a group, meta always reflects the conference state — the
        // "caller" isn't meaningful when there are multiple participants.
        callMeta.textContent = currentGroupName
          ? "Conference in progress — tap Group to manage"
          : (payload?.meta || "");
        callTimer.hidden = false;
        startCallTimer();
        enable(btnAnswer, false);
        enable(btnReject, false);
        enable(btnHangup, true);
        enable(btnMute, true);
        // Hold + Transfer only work for 1:1 calls. In a group conference
        // they'd tear the conference down, so leave them disabled.
        // Group button stays ENABLED while in a group — clicking it
        // re-opens the group-management window.
        if (btnHold)     enable(btnHold,     !!currentCustomerCallSid && !currentGroupName);
        if (btnTransfer) enable(btnTransfer, !!currentCustomerCallSid && !currentGroupName);
        if (btnGroup)    enable(btnGroup,    !!currentCustomerCallSid || !!currentGroupName);
        updateGroupButtonLabel();
        break;
    }
  }

  // Group button's label + title change based on state:
  //   - Not in a group: "Group" — click starts a new one.
  //   - In a group:     "Open Group" — click re-opens the management window.
  function updateGroupButtonLabel() {
    if (!btnGroup) return;
    const label = document.getElementById("groupLabel");
    if (label) label.textContent = currentGroupName ? "Open Group" : "Group";
    btnGroup.title = currentGroupName
      ? "Open group management window"
      : "Start a group conference with other paired devices";
  }

  function startCallTimer() {
    callStartedAt = Date.now();
    const tick = () => {
      const secs = Math.floor((Date.now() - callStartedAt) / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      callTimer.textContent = `${m}:${String(s).padStart(2, "0")}`;
    };
    tick();
    if (callTimerHandle) clearInterval(callTimerHandle);
    callTimerHandle = setInterval(tick, 1000);
  }
  function stopCallTimer() {
    if (callTimerHandle) clearInterval(callTimerHandle);
    callTimerHandle = null;
    callStartedAt = null;
  }

  // ─── Boot ──────────────────────────────────────────────────────
  // ═══════════════ Console helpers ═══════════════
  // A single consistent look for boot banner + health ping so the
  // console is skimmable instead of a wall of Twilio SDK noise.
  function printBootBanner({ version, env, shop, deviceId, server }) {
    const bar = "═".repeat(56);
    console.log(
`\n${bar}
   📞 JobCount Phone   v${version || "?"}   [${(env || "prod").toUpperCase()}]
${bar}
   Shop:     ${shop     || "(not paired)"}
   Device:   ${deviceId  || "(not paired)"}
   Server:   ${server    || "(none)"}
${bar}\n`
    );
  }
  function logHealth(label, details) {
    const parts = Object.entries(details || {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    console.log(`[${label}] ${parts}`);
  }

  async function boot() {
    setStatus("gray", "Loading");
    loadingSub.textContent = "Reading device config…";

    // Surface the dev ribbon if the launcher set JOBCOUNT_ENV=dev.
    try {
      const sys = await window.jobcountPhone.systemInfo();
      _isDevMode = !!(sys && sys.jobcountEnv === "dev");
      if (_isDevMode) {
        document.getElementById("devRibbon").hidden = false;
      }
      // Re-render the update state now that we know whether we're in
      // dev mode — the initial render happened before _isDevMode was
      // set and may have shown the wrong label/pill for dev builds.
      try {
        const info = await window.jobcountPhone.getUpdateState?.();
        renderUpdateState(info?.last || { state: "idle" });
      } catch {}
    } catch {}

    config = await window.jobcountPhone.getConfig();

    // Once-per-session boot banner — gives us a clean anchor in the
    // log showing exactly what this instance is.
    try {
      const info = await window.jobcountPhone.getUpdateState?.();
      printBootBanner({
        version: info?.version,
        env: _isDevMode ? "dev" : "prod",
        shop: config.shopName ? `${config.shopName} (${config.shopId})` : "",
        deviceId: config.deviceId ? `${config.label || "unnamed"} — ${config.deviceId}` : "",
        server: config.serverUrl || "",
      });
    } catch {}

    // Periodic health ping — every 5 minutes. Short, scannable, and
    // useful when the app has been running for hours and you want
    // to confirm everything's still wired up.
    setInterval(() => {
      logHealth("health", {
        ts: new Date().toISOString().slice(11, 19),
        twilio: device ? "online" : "offline",
        socket: presenceSocket && presenceSocket.connected ? "connected" : "disconnected",
        call: activeCall ? (activeDirection || "active") : "idle",
        queue: _lastQueueCount >= 0 ? _lastQueueCount : "?",
        held: _lastHeldCount >= 0 ? _lastHeldCount : "?",
        group: currentGroupName ? "in-group" : "—",
      });
    }, 5 * 60 * 1000);

    if (!config.hasToken) {
      showScreen("pairing");
      setStatus("gray", "Unpaired");
      topbarSub.textContent = "Not paired";
      return;
    }

    topbarSub.textContent = config.shopName ? config.shopName : "Paired device";
    showScreen("phone");
    setStatus("yellow", "Connecting");
    setCallState("idle");

    try {
      await connectTwilioDevice();
    } catch (e) {
      console.error("Device init failed:", e);
      setStatus("red", "Offline");
      callLabel.textContent = "Connection failed";
      callTitle.textContent = "Could not connect";
      callMeta.textContent = e.message || "Check server URL and try again";
    }
  }

  // ─── Pairing ───────────────────────────────────────────────────
  //
  // Pairing info can arrive three ways, in priority order:
  //   1. JSON payload pasted into #pairPayload — auto-extracts URL + code
  //   2. 6-digit code + Advanced "manual server URL" field
  //   3. 6-digit code + previously-remembered server URL (unpair-then-repair)
  //
  // Once we have BOTH a server URL and a 6-digit code, we submit via the
  // main-process IPC (bypasses CORS from the file:// renderer origin).

  function parsePairPayload(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    if (text.startsWith("{")) {
      try {
        const p = JSON.parse(text);
        if (p && p.code && p.serverUrl) return p;
      } catch { /* fall through */ }
    }
    // Some QR scanners yield a URL-encoded thing — try extracting fields.
    return null;
  }

  // Build the ordered list of URLs to try for API calls.
  //
  // Priority:
  //   1. http://localhost:4000 (auto-injected when we're running with
  //      JOBCOUNT_ENV=dev — 99% of dev setups have the server on this
  //      port, and localhost doesn't TLS so it sidesteps any AV issues).
  //   2. payload.localServerUrl (explicit same-machine URL from server)
  //   3. payload.serverUrl (public URL, ngrok or prod)
  //   4. fallbackUrl (manual Advanced URL or previously-saved config)
  //
  // Duplicates removed. A failed localhost attempt is essentially free
  // (ECONNREFUSED is instant) so there's no downside to always trying it
  // first in dev.
  function candidateServerUrls(parsed, fallbackUrl, systemInfo) {
    const list = [];
    if (systemInfo && systemInfo.jobcountEnv === "dev") {
      list.push("http://localhost:4000");
    }
    if (parsed && parsed.localServerUrl) list.push(String(parsed.localServerUrl).replace(/\/+$/, ""));
    if (parsed && parsed.serverUrl)      list.push(String(parsed.serverUrl).replace(/\/+$/, ""));
    if (fallbackUrl)                     list.push(String(fallbackUrl).replace(/\/+$/, ""));
    return Array.from(new Set(list.filter(Boolean)));
  }

  function setServerBadge(serverUrl, shopName) {
    if (!serverUrl) {
      pairServerBadge.style.display = "none";
      pairServerUrlResolved = "";
      pairShopNameResolved = "";
      return;
    }
    pairServerUrlResolved = serverUrl.replace(/\/+$/, "");
    pairShopNameResolved = shopName || "";
    const short = (() => { try { return new URL(pairServerUrlResolved).host; } catch { return pairServerUrlResolved; } })();
    const nameHtml = shopName ? `<strong>${shopName}</strong> · ` : "";
    pairServerBadge.querySelector(".sb-text").innerHTML = `${nameHtml}<code>${short}</code>`;
    pairServerBadge.style.display = "";
  }

  // Watch the payload textarea — parse on every keystroke so the server
  // badge appears as soon as the user pastes valid JSON.
  pairPayload.addEventListener("input", () => {
    const parsed = parsePairPayload(pairPayload.value);
    if (parsed) {
      pairCode.value = String(parsed.code || "");
      setServerBadge(parsed.serverUrl, parsed.shopName);
    } else {
      setServerBadge("", "");
    }
  });

  // Also react to pastes into the bare code field — some users will just
  // paste the JSON there by muscle memory.
  pairCode.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    const parsed = parsePairPayload(text);
    if (parsed) {
      e.preventDefault();
      pairPayload.value = text.trim();
      pairCode.value = String(parsed.code || "");
      setServerBadge(parsed.serverUrl, parsed.shopName);
    }
  });

  // Advanced URL field (fallback for manual typing).
  pairServerUrl.addEventListener("input", () => {
    const v = pairServerUrl.value.trim();
    if (v && /^https?:\/\//i.test(v)) {
      // Advanced URL takes precedence if payload wasn't pasted.
      if (!parsePairPayload(pairPayload.value)) {
        setServerBadge(v.replace(/\/+$/, ""), "");
      }
    } else if (!parsePairPayload(pairPayload.value)) {
      setServerBadge("", "");
    }
  });

  btnSubmitPair.addEventListener("click", async () => {
    pairStatus.className = "pair-status";
    pairStatus.textContent = "";

    const parsed = parsePairPayload(pairPayload.value);
    const manualUrl = pairServerUrl.value.trim();
    const fallbackUrl =
      manualUrl && /^https?:\/\//i.test(manualUrl)
        ? manualUrl.replace(/\/+$/, "")
        : (config && config.serverUrl) || "";

    const sys = await window.jobcountPhone.systemInfo();
    const urls = candidateServerUrls(parsed, fallbackUrl, sys);
    const label = (pairLabel.value || "").trim();
    const code = (pairCode.value || "").replace(/\D/g, "");

    if (!urls.length) {
      pairStatus.className = "pair-status err";
      pairStatus.textContent = "Paste the pairing info from JobCount — we need the server URL too.";
      return;
    }
    if (code.length !== 6) {
      pairStatus.className = "pair-status err";
      pairStatus.textContent = "Pairing code must be 6 digits.";
      return;
    }

    btnSubmitPair.disabled = true;
    pairStatus.className = "pair-status info";
    pairStatus.textContent = "Pairing…";

    const body = {
      code, label,
      hostname: sys.hostname,
      platform: sys.platform,
      appVersion: sys.appVersion,
    };

    // Try each candidate URL in order. localhost first (fastest, avoids
    // TLS entirely on same-machine dev), public URL as fallback. Each URL
    // gets two attempts: Chromium fetch, then node:https.
    let finalData = null, finalOk = false, workingUrl = null, lastError = "No URL succeeded";

    outer: for (const url of urls) {
      pairStatus.textContent = `Pairing via ${new URL(url).host}…`;

      // Attempt 1: renderer fetch
      try {
        const r = await fetch(`${url}/phone-pair/redeem`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "ngrok-skip-browser-warning": "1",
          },
          body: JSON.stringify(body),
          mode: "cors",
        });
        const text = await r.text();
        let d; try { d = text ? JSON.parse(text) : {}; } catch { d = { error: text.slice(0, 400) }; }
        if (r.ok && d.ok) { finalData = d; finalOk = true; workingUrl = url; break outer; }
        if (d && d.error) lastError = `${new URL(url).host}: ${d.error}`;
      } catch (e) {
        lastError = `${new URL(url).host}: ${e.message}`;
      }

      // Attempt 2: node:https fallback through main process
      try {
        const resp = await window.jobcountPhone.pairRedeem({ serverUrl: url, body });
        const d = resp?.data || {};
        if (resp?.ok && d.ok) { finalData = d; finalOk = true; workingUrl = url; break outer; }
        if (d && d.error) lastError = `${new URL(url).host}: ${d.error}`;
      } catch (e) {
        lastError = `${new URL(url).host}: ${e.message}`;
      }
    }

    if (!finalOk) {
      pairStatus.className = "pair-status err";
      pairStatus.textContent = lastError || "Pairing failed.";
      btnSubmitPair.disabled = false;
      return;
    }

    try {
      await window.jobcountPhone.savePairing({
        serverUrl: workingUrl,   // save whichever URL actually worked
        shopId: finalData.shop?.id,
        shopName: finalData.shop?.name,
        deviceId: finalData.deviceId,
        label: finalData.label || label,
        deviceToken: finalData.deviceToken,
      });

      pairStatus.className = "pair-status ok";
      pairStatus.textContent = `Paired as "${finalData.label}" via ${new URL(workingUrl).host}. Connecting…`;
      setTimeout(boot, 800);
    } catch (e) {
      pairStatus.className = "pair-status err";
      pairStatus.textContent = e.message || "Could not persist pairing.";
      btnSubmitPair.disabled = false;
    }
  });

  // ─── Twilio Device ─────────────────────────────────────────────
  async function fetchVoiceToken() {
    // Try Chromium-based fetch first — on Windows machines where AV
    // intercepts Node's https, this is the reliable path.
    const serverUrl = (config?.serverUrl || "").replace(/\/+$/, "");
    const token = await window.jobcountPhone.getDeviceToken();
    if (serverUrl && token) {
      try {
        const r = await fetch(`${serverUrl}/phone-device/voice-token`, {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/json",
            "ngrok-skip-browser-warning": "1",
          },
          mode: "cors",
        });
        if (r.ok) {
          const data = await r.json();
          if (data && data.token) return data;
        } else {
          console.warn("voice-token renderer fetch HTTP", r.status);
        }
      } catch (e) {
        console.warn("voice-token renderer fetch failed; falling back to main:", e.message);
      }
    }

    // Fallback: main-process node:https path.
    const data = await window.jobcountPhone.getVoiceToken();
    if (!data || !data.token) throw new Error("No token returned");
    return data;
  }

  async function connectTwilioDevice() {
    if (!window.Twilio || !window.Twilio.Device) {
      throw new Error("Twilio SDK not loaded (did `npm install` run?)");
    }

    const { token } = await fetchVoiceToken();

    device = new Twilio.Device(token, {
      codecPreferences: ["opus", "pcmu"],
      // Twilio SDK log level:
      //   1 = DEBUG (floods console with heartbeats every 10s)
      //   2 = INFO
      //   3 = WARN  ← production default: only surface real issues
      //   4 = ERROR
      // Raise this back to 1 during deep SDK debugging; otherwise 3
      // gives us clean logs with real warnings still visible.
      logLevel: _isDevMode ? 2 : 3,
    });

    device.on("registered", () => {
      setStatus("green", "Online");
      _reconnecting = false;
    });
    device.on("error", (err) => {
      const code = err?.code ?? err?.twilioError?.code;
      console.error("Twilio error:", code, err);
      // Twilio error codes that mean "your token is invalid" — these are
      // unrecoverable without a fresh token, so tear the Device down
      // entirely and rebuild. Common case: the app sat idle past the JWT
      // lifetime and the OS suspended our refresh timer.
      //   20101 — invalid access token
      //   20104 — access token expired
      //   31204 — invalid access token (Voice SDK surfaces this one too)
      //   31205 — expired access token (SDK variant)
      //   31207 — expired JWT grant
      if ([20101, 20104, 31204, 31205, 31207].includes(Number(code))) {
        setStatus("red", "Token expired — reconnecting…");
        callMeta.textContent = "Reconnecting to Twilio…";
        reconnectDevice().catch((e) => {
          console.error("reconnect failed:", e);
          setStatus("red", "Offline — tap Reconnect");
          callMeta.textContent = "Automatic reconnect failed. Press Reconnect.";
          showReconnectButton(true);
        });
        return;
      }
      setStatus("red", "Error");
      callMeta.textContent = String(err?.message || err);
    });
    device.on("unregistered", () => setStatus("gray", "Offline"));
    device.on("tokenWillExpire", () => refreshDeviceToken().catch(() => {}));

    device.on("incoming", (call) => {
      activeCall = call;
      activeDirection = "incoming";

      const customParams = call.customParameters || new Map();
      const getP = (k) => (customParams.get ? customParams.get(k) : null);
      const shopName = getP("shopName") || "";
      const isResume = getP("resume") === "1";
      const transferFromLabel = getP("transferFromLabel") || "";
      // For resumes from an outbound-hold, `call.parameters.From` is the
      // shop's own caller ID (since the held leg was originally dialed
      // FROM the shop). Prefer the counterpartyPhone that resume-connect
      // computes and passes through — otherwise the UI renders "me
      // calling myself".
      const counterpartyPhone = getP("counterpartyPhone") || "";
      const from = counterpartyPhone || call.parameters.From || "";

      // Auto-answer path — the server told us (via socket) that the
      // next incoming call is a silent group-rejoin. Accept it
      // immediately without the normal ring UX.
      if (_autoAnswerHint && _autoAnswerHint.expiresAt > Date.now()) {
        console.log("[incoming] auto-answering", _autoAnswerHint);
        const hint = _autoAnswerHint;
        _autoAnswerHint = null;
        if (hint.groupName) currentGroupName = hint.groupName;
        try {
          call.accept();
        } catch (e) {
          console.warn("[incoming] auto-accept failed:", e.message);
        }
        call.on("disconnect", onCallDisconnect);
        call.on("cancel", onCallDisconnect);
        call.on("reject", onCallDisconnect);
        call.on("accept", () => {
          activeDirection = "incoming";
          setCallState("in-call", { caller: from, meta: "In group call" });
          reportBusyState(true);
        });
        return;
      }
      // Expire stale hints so they don't intercept an unrelated call.
      if (_autoAnswerHint && _autoAnswerHint.expiresAt <= Date.now()) {
        _autoAnswerHint = null;
      }

      // Capture customer CallSid for Hold/Hangup/Transfer via REST.
      currentCustomerCallSid =
        getP("customerCallSid") || call.parameters.CallSid || null;

      // Transfer-origin banner in the call hero when this is a handoff.
      callHero.classList.toggle("transfer-in", !!transferFromLabel);

      let meta;
      if (transferFromLabel) {
        meta = `Transfer from ${transferFromLabel}`;
      } else if (isResume) {
        meta = "Resumed call — tap Answer";
      } else {
        meta = shopName || "Tap Answer";
      }
      setCallState("ringing", { caller: from, meta });

      // Bring the app's window to attention — flash the taskbar, surface
      // it from the tray. Doesn't steal focus. Works whether the app is
      // minimized, hidden, or in the background of another monitor.
      try { window.jobcountPhone.alertIncoming(); } catch {}

      call.on("disconnect", onCallDisconnect);
      call.on("cancel", onCallDisconnect);
      call.on("reject", onCallDisconnect);
      call.on("accept", () => {
        activeDirection = "incoming";
        setCallState("in-call", { caller: from });
        reportBusyState(true);
      });
    });

    await device.register();
    scheduleTokenRefresh(token);

    // Populate audio device dropdowns once the SDK is up.
    await populateAudioDevices();

    // Open the presence socket so JobCount's Paired Devices panel sees
    // this app as online in real time. Auto-disconnects when the app is
    // closed — server marks the device offline on socket 'disconnect'.
    await connectPresenceSocket();

    // Start watching the shop queue + held calls so the agent sees who's
    // waiting and who's parked. These poll every 5s and react to socket
    // events; first-paint is immediate.
    startLiveMonitors();
  }

  async function connectPresenceSocket() {
    try {
      if (presenceSocket) {
        try { presenceSocket.disconnect(); } catch {}
        presenceSocket = null;
      }
      if (!window.io) {
        console.warn("socket.io-client not loaded — presence will be stale");
        return;
      }
      const serverUrl = (config?.serverUrl || "").replace(/\/+$/, "");
      const token = await window.jobcountPhone.getDeviceToken();
      if (!serverUrl || !token) return;

      presenceSocket = window.io(`${serverUrl}/phone-live`, {
        auth: { deviceToken: token },
        withCredentials: false,
        path: "/socket.io",
        // Force websocket-only — Heroku's router load-balances polling
        // requests across dynos, which causes flapping if sticky
        // sessions weren't enabled, AND polling burns more bandwidth.
        // Websocket is one long-lived connection bound to a single
        // dyno, immune to the LB and dyno-affinity issues.
        transports: ["websocket"],
        upgrade: false,
        reconnection: true,
        reconnectionDelay: 1500,
        reconnectionDelayMax: 15000,
        timeout: 20000,
      });

      // Track connect/disconnect silently except on transitions —
      // reconnect storms would flood the log. First connect is
      // noteworthy, subsequent ones are implicit from disconnect log.
      let _socketEverConnected = false;
      presenceSocket.on("connect", () => {
        if (!_socketEverConnected) {
          console.log(`[socket] connected (${presenceSocket.id})`);
          _socketEverConnected = true;
        } else {
          console.log("[socket] reconnected");
        }
      });
      presenceSocket.on("disconnect", (reason) => {
        // Reasons we see in practice:
        //   "io server disconnect"   → server kicked us (token revoked, etc.)
        //   "io client disconnect"   → we called .disconnect() ourselves
        //   "ping timeout"           → no heartbeat from server
        //   "transport close"        → connection closed (Heroku idle, etc.)
        //   "transport error"        → network blip
        // Anything but "io client disconnect" is unexpected — flag it.
        const unexpected = reason !== "io client disconnect";
        console.log(
          `[socket] disconnected (${reason})${unexpected ? " — will reconnect" : ""}`
        );
      });
      presenceSocket.on("connect_error", (e) => console.warn("[socket] connect error:", e.message));
      presenceSocket.on("phone:error",   (e) => console.warn("[socket] server error:", e));

      // Server-to-device hint: the very next incoming call should be
      // accepted automatically without ringing the user. Used when the
      // admin presses Group and needs to seamlessly rejoin the call as
      // a conference participant. TTL prevents stale hints from
      // intercepting a real customer call.
      presenceSocket.on("phone:auto-answer", (payload) => {
        console.log("[presence] phone:auto-answer hint:", payload);
        _autoAnswerHint = {
          groupName: payload.groupName || null,
          reason: payload.reason || "",
          expiresAt: Date.now() + (Number(payload.expiresInMs) || 10000),
        };
      });
    } catch (e) {
      console.warn("connectPresenceSocket failed:", e.message);
    }
  }

  async function refreshDeviceToken() {
    if (!device) return;
    try {
      const { token } = await fetchVoiceToken();
      if (device && typeof device.updateToken === "function") {
        device.updateToken(token);
      }
      scheduleTokenRefresh(token);
    } catch (e) {
      console.warn("Token refresh failed:", e);
      setTimeout(() => refreshDeviceToken().catch(() => {}), 30_000);
    }
  }

  // Full device teardown + rebuild. Used when the current token is
  // hopelessly stale (expired past the point where updateToken works)
  // or when the user presses the visible Reconnect button.
  async function reconnectDevice() {
    if (_reconnecting) return;
    _reconnecting = true;
    setStatus("yellow", "Reconnecting");
    showReconnectButton(false);

    try {
      if (tokenRefreshTimer) { clearTimeout(tokenRefreshTimer); tokenRefreshTimer = null; }
      if (device) {
        try { device.destroy(); } catch {}
        device = null;
      }
      await connectTwilioDevice();
      console.log("[reconnect] device re-registered OK");
    } catch (e) {
      console.error("[reconnect] failed:", e);
      _reconnecting = false;
      throw e;
    }
  }

  // Toggle the visible "Reconnect" button in the status area. Called
  // when auto-recovery fails so the user has a manual escape hatch.
  function showReconnectButton(show) {
    let btn = document.getElementById("btnReconnect");
    if (!btn && show) {
      btn = document.createElement("button");
      btn.id = "btnReconnect";
      btn.className = "btn-reconnect";
      btn.textContent = "Reconnect";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Reconnecting…";
        try {
          await reconnectDevice();
          showReconnectButton(false);
        } catch {
          btn.disabled = false;
          btn.textContent = "Reconnect";
        }
      });
      // Dock it right next to the status pill.
      const pill = document.getElementById("statusPill");
      (pill?.parentElement || document.body).appendChild(btn);
    }
    if (btn) btn.style.display = show ? "" : "none";
  }

  function scheduleTokenRefresh(jwt) {
    if (tokenRefreshTimer) { clearTimeout(tokenRefreshTimer); tokenRefreshTimer = null; }
    try {
      const parts = String(jwt).split(".");
      if (parts.length !== 3) return;
      const pad = parts[1].length % 4;
      const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/") + (pad ? "=".repeat(4 - pad) : "");
      const payload = JSON.parse(atob(padded));
      const msUntilExp = payload.exp * 1000 - Date.now();
      const refreshIn = Math.max(30_000, Math.min(msUntilExp - 120_000, 55 * 60_000));
      tokenRefreshTimer = setTimeout(() => refreshDeviceToken().catch(() => {}), refreshIn);
    } catch {}
  }

  // ─── Calls ─────────────────────────────────────────────────────
  btnAnswer.addEventListener("click", () => {
    if (!activeCall) return;
    activeCall.accept();
  });
  btnReject.addEventListener("click", () => {
    if (!activeCall) return;
    activeCall.reject();
    activeCall = null;
    setCallState("idle");
  });
  btnHangup.addEventListener("click", () => {
    if (activeCall) activeCall.disconnect();
  });
  btnMute.addEventListener("click", () => {
    if (!activeCall) return;
    const nowMuted = !activeCall.isMuted();
    activeCall.mute(nowMuted);
    btnMute.classList.toggle("active", nowMuted);
    muteLabel.textContent = nowMuted ? "Muted" : "Mute";
  });

  btnDial.addEventListener("click", async () => {
    if (!device) return;
    const raw = (dialInput.value || "").trim();
    if (!raw) return;

    // Support queue:<shopId> for "Answer Next" semantics when agents dial
    // from the JobCount web cockpit. From the desktop app we usually dial
    // regular numbers but allow it if pasted.
    const params = { To: raw };
    if (config && config.shopId) params.shopId = config.shopId;

    try {
      activeCall = await device.connect({ params });
      activeDirection = "outgoing";
      setCallState("dialing", { to: raw });

      activeCall.on("accept", async () => {
        setCallState("in-call", { caller: raw });
        reportBusyState(true);
        // For outgoing calls, currentCustomerCallSid needs to point at
        // the *child* call (the called party's leg), not our own parent
        // SDK leg. Poll the server briefly to find it — Twilio usually
        // has the child registered within 1-2 seconds of accept. Once
        // we have it, setCallState re-renders and Hold/Transfer/Group
        // become enabled.
        const parentSid = activeCall?.parameters?.CallSid;
        if (!parentSid) return;
        for (let attempt = 0; attempt < 6 && activeCall; attempt++) {
          try {
            const data = await apiFetch(
              `/phone-device/calls/${encodeURIComponent(parentSid)}/child`
            );
            if (data?.childCallSid) {
              currentCustomerCallSid = data.childCallSid;
              setCallState("in-call", { caller: raw });
              console.log("[outgoing] child call found:", data.childCallSid);
              return;
            }
          } catch (e) {
            console.warn("[outgoing] child lookup failed:", e.message);
          }
          // Back off: 500ms, 800ms, 1.2s, 1.7s, 2.3s, 3.0s
          await new Promise((r) => setTimeout(r, 500 + attempt * 500));
        }
      });
      activeCall.on("disconnect", onCallDisconnect);
      activeCall.on("cancel", onCallDisconnect);
      activeCall.on("reject", onCallDisconnect);
    } catch (e) {
      callLabel.textContent = "Dial failed";
      callMeta.textContent = e.message || "Try again";
    }
  });

  // Report our own busy-state to the server so /voice/live-reception
  // knows to skip ringing us when a new call lands during a
  // conversation. Fire-and-forget — the socket may briefly be down and
  // that's OK; server default is "not busy" and we re-emit every time
  // the call state changes.
  function reportBusyState(busy) {
    try {
      if (presenceSocket && presenceSocket.connected) {
        presenceSocket.emit("phone:busy-state", { busy: !!busy });
      }
    } catch (e) {
      console.warn("[busy-state] emit failed:", e.message);
    }
  }

  function onCallDisconnect() {
    activeCall = null;
    activeDirection = null;
    currentCustomerCallSid = null;
    // Leaving the Voice SDK call ends our participation in any group
    // conference. Clear the flag so the next call starts fresh.
    currentGroupName = null;
    // Tell the server we're free to take new calls again.
    reportBusyState(false);
    btnMute.classList.remove("active");
    muteLabel.textContent = "Mute";
    if (btnHold) {
      btnHold.classList.remove("active");
      holdLabel.textContent = "Hold";
    }
    setCallState("idle");
    // A call just ended — might have freed up a held slot or confirmed
    // a successful hand-off. Pull fresh panels either way.
    refreshQueue();
    refreshHeld();
  }

  // ─── Keypad ────────────────────────────────────────────────────
  keys.forEach((k) => {
    k.addEventListener("click", () => {
      const digit = k.firstChild?.textContent?.trim() || k.textContent.trim().charAt(0);
      if (activeCall && activeCall.sendDigits) {
        // Mid-call DTMF
        activeCall.sendDigits(digit);
      } else {
        dialInput.value = (dialInput.value || "") + digit;
      }
    });
  });
  btnBackspace.addEventListener("click", () => {
    dialInput.value = (dialInput.value || "").slice(0, -1);
  });

  // ─── Audio device picker ───────────────────────────────────────
  async function populateAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === "audioinput");
      const spks = devices.filter(d => d.kind === "audiooutput");

      selectMicrophone.innerHTML = mics.map((d, i) =>
        `<option value="${d.deviceId}">${escapeHtml(d.label || `Microphone ${i + 1}`)}</option>`
      ).join("");
      selectSpeaker.innerHTML = spks.map((d, i) =>
        `<option value="${d.deviceId}">${escapeHtml(d.label || `Speaker ${i + 1}`)}</option>`
      ).join("");

      // Apply on change — Twilio Device exposes audio.setInputDevice/speakerDevices.set.
      selectMicrophone.addEventListener("change", async () => {
        try { await device.audio.setInputDevice(selectMicrophone.value); }
        catch (e) { console.warn("setInputDevice failed:", e.message); }
      });
      selectSpeaker.addEventListener("change", async () => {
        try { await device.audio.speakerDevices.set([selectSpeaker.value]); }
        catch (e) { console.warn("speakerDevices.set failed:", e.message); }
      });
    } catch (e) {
      console.warn("enumerateDevices failed:", e.message);
    }
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
  }

  // ─── Settings screen ───────────────────────────────────────────
  btnSettings.addEventListener("click", async () => {
    settingsLabel.value = config?.label || "";
    settingsShop.textContent = config?.shopName || "—";
    settingsDeviceId.textContent = config?.deviceId || "—";
    settingsServer.textContent = config?.serverUrl || "—";
    showScreen("settings");
  });

  btnBackFromSettings.addEventListener("click", () => showScreen("phone"));

  btnSaveSettings.addEventListener("click", async () => {
    const label = settingsLabel.value.trim();
    if (label && label !== config.label) {
      // Save locally first so the UI updates even if the server is
      // temporarily unreachable.
      await window.jobcountPhone.setLabel(label);
      config.label = label;
      // Push to the server so the manager's "Online Devices" list and
      // the group/transfer pickers reflect the new name without the
      // user having to re-pair.
      try {
        await apiFetch("/phone-device/set-label", {
          method: "POST",
          body: { label },
        });
      } catch (e) {
        console.warn("label sync to server failed:", e.message);
      }
    }
    showScreen("phone");
  });

  btnUnpair.addEventListener("click", async () => {
    if (!confirm("Unpair this device? You'll need a new pairing code to reconnect.")) return;
    if (device) {
      try { device.destroy(); } catch {}
      device = null;
    }
    if (presenceSocket) {
      try { presenceSocket.disconnect(); } catch {}
      presenceSocket = null;
    }
    // Stop the live-monitor pollers — no point hammering a server we
    // can no longer authenticate to.
    if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null; }
    if (heldPollTimer)  { clearInterval(heldPollTimer);  heldPollTimer  = null; }
    queueState = []; heldState = [];
    renderQueue(); renderHeld();

    await window.jobcountPhone.clearConfig();
    config = await window.jobcountPhone.getConfig();
    showScreen("pairing");
    setStatus("gray", "Unpaired");
    topbarSub.textContent = "Not paired";
  });

  // ═════════════════════════════════════════════════════════════════
  // LIVE QUEUE + HELD CALLS + call-control actions
  // ═════════════════════════════════════════════════════════════════

  // ─── Toast helper ──────────────────────────────────────────────
  function toast(msg, variant = "info", ttl = 3000) {
    const stack = document.getElementById("toastStack");
    if (!stack) return;
    const el = document.createElement("div");
    el.className = `toast-msg ${variant}`;
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .25s";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 300);
    }, ttl);
  }

  // ─── Device-authenticated API fetch (renderer-side Chromium stack) ───
  async function apiFetch(path, options = {}) {
    const serverUrl = (config?.serverUrl || "").replace(/\/+$/, "");
    const token = await window.jobcountPhone.getDeviceToken();
    if (!serverUrl) throw new Error("Not paired (no server URL)");
    if (!token)     throw new Error("Not paired (no device token)");

    const r = await fetch(serverUrl + path, {
      method: options.method || "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "1",
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 400) }; }
    if (!r.ok) {
      const msg = (data && data.error) || `HTTP ${r.status}`;
      const e = new Error(msg);
      e.status = r.status;
      throw e;
    }
    return data;
  }

  // Tiny utils
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c]));
  const fmtDuration = (sec) => {
    const s = Math.max(0, Math.floor(Number(sec || 0)));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  };

  // ─── Live Queue ────────────────────────────────────────────────
  // Keep the last known count so we only log when something changes —
  // otherwise the 5-second poll floods the console with "0 members".
  let _lastQueueCount = -1;
  async function refreshQueue() {
    try {
      const data = await apiFetch("/phone-device/queue");
      queueState = Array.isArray(data?.queue) ? data.queue : [];
      if (queueState.length !== _lastQueueCount) {
        if (queueState.length > 0 || _lastQueueCount > 0) {
          console.log(`[queue] ${queueState.length} caller(s) waiting`);
        }
        _lastQueueCount = queueState.length;
      }
      renderQueue();
    } catch (e) {
      if (e.status !== 401) console.warn("[queue] refresh failed:", e.message);
    }
  }

  function renderQueue() {
    if (!queueList || !queueCount) return;
    queueCount.textContent = queueState.length;
    // Enabled whenever someone is waiting — clicking with an active
    // call auto-holds the current customer (see Answer Next handler).
    if (btnAnswerNext) btnAnswerNext.disabled = queueState.length === 0;

    if (!queueState.length) {
      queueList.innerHTML = '<div class="live-empty">No callers waiting.</div>';
      return;
    }
    queueList.innerHTML = queueState.map((c) => {
      const phone = c.from ? formatPhone(c.from) : "";
      const name = c.customerName || "";
      // Name (if we have one) as the top line; phone number always as the
      // main identifier — never "Unknown caller". When the number hasn't
      // loaded yet (first poll after a new call) show a loading placeholder.
      const primary = phone || (c.customerName ? c.customerName : "Loading…");
      const secondary = name && phone ? name : "";
      return `
      <div class="live-row" data-call-sid="${esc(c.callSid)}">
        <div class="lr-info">
          <div class="lr-name">${esc(primary)}</div>
          <div class="lr-from">${esc(secondary)}</div>
        </div>
        <div class="lr-time">${fmtDuration(c.waitTimeSeconds)}</div>
      </div>`;
    }).join("");
  }

  // Format an E.164 phone number for display.
  // +13609903712 → "(360) 990-3712"
  function formatPhone(raw) {
    const s = String(raw || "").replace(/[^\d+]/g, "");
    // +1XXXXXXXXXX (US/CA)
    const us = s.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
    if (us) return `(${us[1]}) ${us[2]}-${us[3]}`;
    // Bare 10-digit
    const bare = s.match(/^(\d{3})(\d{3})(\d{4})$/);
    if (bare) return `(${bare[1]}) ${bare[2]}-${bare[3]}`;
    // E.164 international — leave as-is
    return s || raw;
  }

  // ─── Held Calls ────────────────────────────────────────────────
  // Only log when the count changes (same rationale as Live Queue).
  let _lastHeldCount = -1;
  async function refreshHeld() {
    try {
      const data = await apiFetch("/phone-device/held-calls");
      heldState = Array.isArray(data?.held) ? data.held : [];
      if (heldState.length !== _lastHeldCount) {
        if (heldState.length > 0 || _lastHeldCount > 0) {
          console.log(`[held] ${heldState.length} call(s) on hold`);
        }
        _lastHeldCount = heldState.length;
      }
      renderHeld();
    } catch (e) {
      if (e.status !== 401) console.warn("[held] refresh failed:", e.message);
    }
  }

  function renderHeld() {
    if (!heldList || !heldCount) return;
    heldCount.textContent = heldState.length;

    if (!heldState.length) {
      heldList.innerHTML = '<div class="live-empty">Nobody on hold.</div>';
      return;
    }
    heldList.innerHTML = heldState.map((c) => {
      const phone = c.from ? formatPhone(c.from) : "";
      const name = c.customerName || "";
      const primary = phone || (name ? name : "Loading…");
      const secondary = name && phone ? name : "";
      return `
      <div class="live-row" data-call-sid="${esc(c.callSid)}">
        <div class="lr-info">
          <div class="lr-name">${esc(primary)}</div>
          <div class="lr-from">${esc(secondary)}</div>
        </div>
        <div class="lr-time">${fmtDuration(c.waitTimeSeconds)}</div>
        <div class="lr-actions">
          <button class="btn-mini resume" data-action="resume" data-sid="${esc(c.callSid)}">Resume</button>
          <button class="btn-mini end" data-action="end" data-sid="${esc(c.callSid)}">End</button>
        </div>
      </div>`;
    }).join("");
  }

  // Event delegation for held-list buttons.
  if (heldList) {
    heldList.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const sid = btn.getAttribute("data-sid");
      const action = btn.getAttribute("data-action");
      if (!sid) return;
      btn.disabled = true;

      try {
        if (action === "resume") {
          // If we're currently on a call with someone else, swap:
          // put THEM on hold first, then pull this held caller back.
          // Without this step the resumed call tries to ring us while
          // we're still bridged to the other customer — the SDK can't
          // serve both and something gets dropped.
          if (activeCall && currentCustomerCallSid && currentCustomerCallSid !== sid) {
            try {
              await apiFetch(
                `/phone-device/calls/${encodeURIComponent(currentCustomerCallSid)}/hold`,
                { method: "POST" }
              );
              toast("Current caller placed on hold", "info", 1500);
            } catch (holdErr) {
              btn.disabled = false;
              toast(`Couldn't hold current call: ${holdErr.message}`, "error");
              return;
            }
          }
          await apiFetch(`/phone-device/calls/${encodeURIComponent(sid)}/resume`, { method: "POST" });
          toast("Resuming call — your phone will ring", "info", 2500);
          // Optimistically remove from held list; server will confirm.
          heldState = heldState.filter((h) => h.callSid !== sid);
          renderHeld();
        } else if (action === "end") {
          if (!confirm("End this held call?")) { btn.disabled = false; return; }
          await apiFetch(`/phone-device/calls/${encodeURIComponent(sid)}/hangup`, { method: "POST" });
          toast("Call ended", "success", 1500);
          heldState = heldState.filter((h) => h.callSid !== sid);
          renderHeld();
        }
      } catch (err) {
        btn.disabled = false;
        toast(`${action === "resume" ? "Resume" : "Hangup"} failed: ${err.message}`, "error");
      }
    });
  }

  // ─── Answer Next button ────────────────────────────────────────
  if (btnAnswerNext) {
    btnAnswerNext.addEventListener("click", async () => {
      btnAnswerNext.disabled = true;
      try {
        // If already on a call, put the current customer on hold so the
        // next queued caller can be bridged in. Mirrors the swap-on-
        // Resume flow we use in the On Hold list.
        if (activeCall && currentCustomerCallSid) {
          try {
            await apiFetch(
              `/phone-device/calls/${encodeURIComponent(currentCustomerCallSid)}/hold`,
              { method: "POST" }
            );
            toast("Current caller placed on hold", "info", 1500);
          } catch (e) {
            toast(`Couldn't hold current call: ${e.message}`, "error");
            btnAnswerNext.disabled = queueState.length === 0 || !!activeCall;
            return;
          }
        }
        const data = await apiFetch("/phone-device/answer-next", { method: "POST" });
        if (!data || !data.ok) throw new Error(data?.error || "No one waiting");
        toast("Connecting next caller — your phone will ring", "info", 2500);
      } catch (err) {
        toast(`Answer Next failed: ${err.message}`, "error");
      } finally {
        btnAnswerNext.disabled = queueState.length === 0;
      }
    });
  }

  // ─── Hold button ───────────────────────────────────────────────
  if (btnHold) {
    btnHold.addEventListener("click", async () => {
      if (!activeCall || !currentCustomerCallSid) {
        toast("No active call to hold.", "error");
        return;
      }
      btnHold.disabled = true;
      const sidToHold = currentCustomerCallSid;
      try {
        await apiFetch(`/phone-device/calls/${encodeURIComponent(sidToHold)}/hold`, { method: "POST" });
        toast("Call placed on hold", "success", 1500);
        // Twilio will disconnect our call leg shortly; onCallDisconnect
        // handles the UI reset. Trigger a held-list refresh immediately
        // so the row shows up before the server event arrives.
        setTimeout(refreshHeld, 600);
      } catch (err) {
        btnHold.disabled = false;
        toast(`Hold failed: ${err.message}`, "error");
      }
    });
  }

  // ─── Transfer button + device picker ───────────────────────────
  //
  // Blind transfer: caller is sent to the chosen paired device via a fresh
  // <Dial><Client> TwiML. The server stamps the original device's label so
  // the target sees "Transfer from <label>" when the call lands. If nobody
  // answers within the configured ring window, the fallback TwiML dumps
  // the customer back into the shop queue — no dropped calls.
  let transferPickerPeers = [];

  function openTransferPicker() {
    if (!transferPicker || !transferPickerBody) return;
    transferPicker.hidden = false;
    transferPickerBody.innerHTML = '<div class="live-empty">Loading devices…</div>';
    loadTransferPeers();
  }

  function closeTransferPicker() {
    if (!transferPicker) return;
    transferPicker.hidden = true;
  }

  async function loadTransferPeers() {
    try {
      const data = await apiFetch("/phone-device/peers");
      transferPickerPeers = Array.isArray(data?.peers) ? data.peers : [];
      renderTransferPeers();
    } catch (err) {
      transferPickerBody.innerHTML =
        `<div class="live-empty">Couldn't load devices: ${esc(err.message)}</div>`;
    }
  }

  function renderTransferPeers() {
    if (!transferPickerBody) return;
    const online = transferPickerPeers.filter((p) => p.online);
    const offline = transferPickerPeers.filter((p) => !p.online);

    if (!transferPickerPeers.length) {
      transferPickerBody.innerHTML =
        '<div class="live-empty">No other paired devices in this shop.</div>';
      return;
    }
    if (!online.length) {
      transferPickerBody.innerHTML =
        '<div class="live-empty">No other devices are online right now.</div>';
      return;
    }

    const row = (p) => `
      <button type="button" class="transfer-device ${p.online ? "online" : "offline"}"
              data-peer-id="${esc(p.id)}" ${p.online ? "" : "disabled"}>
        <div class="td-dot"></div>
        <div class="td-info">
          <div class="td-name">${esc(p.label || p.hostname || "Unnamed device")}</div>
          <div class="td-sub">${esc(p.online ? "Online" : "Offline")}${p.hostname && p.label ? " · " + esc(p.hostname) : ""}</div>
        </div>
      </button>
    `;

    transferPickerBody.innerHTML =
      online.map(row).join("") +
      (offline.length
        ? `<div class="td-divider">Offline</div>` + offline.map(row).join("")
        : "");
  }

  if (btnTransfer) {
    btnTransfer.addEventListener("click", () => {
      if (!activeCall || !currentCustomerCallSid) {
        toast("No active call to transfer.", "error");
        return;
      }
      openTransferPicker();
    });
  }

  if (btnTransferClose) {
    btnTransferClose.addEventListener("click", closeTransferPicker);
  }

  if (transferPicker) {
    // Click the backdrop to dismiss — but not clicks inside the panel.
    transferPicker.addEventListener("click", (e) => {
      if (e.target === transferPicker) closeTransferPicker();
    });
  }

  if (transferPickerBody) {
    transferPickerBody.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-peer-id]");
      if (!btn || btn.disabled) return;
      const targetDeviceId = btn.getAttribute("data-peer-id");
      if (!targetDeviceId) return;
      if (!currentCustomerCallSid) {
        toast("No active call to transfer.", "error");
        closeTransferPicker();
        return;
      }

      // Lock the whole picker while the REST call is in flight so the user
      // can't double-click a second device and race two transfers.
      transferPickerBody.querySelectorAll("button[data-peer-id]")
        .forEach((b) => { b.disabled = true; });
      btn.classList.add("loading");

      const sidToTransfer = currentCustomerCallSid;
      try {
        await apiFetch(
          `/phone-device/calls/${encodeURIComponent(sidToTransfer)}/transfer`,
          { method: "POST", body: { targetDeviceId } }
        );
        toast("Transferring call…", "success", 2000);
        closeTransferPicker();
        // Twilio will tear our leg down once the customer is redirected.
        // onCallDisconnect handles UI reset.
      } catch (err) {
        btn.classList.remove("loading");
        // Re-enable online peers so user can try a different device.
        transferPickerBody.querySelectorAll("button[data-peer-id].online")
          .forEach((b) => { b.disabled = false; });
        toast(`Transfer failed: ${err.message}`, "error");
      }
    });
  }

  // ─── Group button ──────────────────────────────────────────────
  //
  // Pressing Group promotes the current 1-on-1 call into a Twilio
  // Conference. The server redirects the customer's leg AND our own
  // Voice SDK leg into the conference (so our current audio bridge
  // ends cleanly and reconnects with the same audio). We then open a
  // dedicated window where the admin can invite / kick / promote other
  // paired devices.
  if (btnGroup) {
    btnGroup.addEventListener("click", async () => {
      // Already in a group? Just re-open/focus the management window.
      // No server call needed — the group is already running.
      if (currentGroupName) {
        try {
          await window.jobcountPhone.openGroupWindow({ groupName: currentGroupName });
        } catch (e) {
          toast(`Couldn't open group window: ${e.message}`, "error");
        }
        return;
      }

      if (!activeCall || !currentCustomerCallSid) {
        toast("No active call to group.", "error");
        return;
      }
      btnGroup.disabled = true;
      const sidToGroup = currentCustomerCallSid;
      // Pass our own Voice SDK call's CallSid (the agent-side B-leg).
      // Server redirects BOTH this leg and the customer's parent into
      // the conference atomically — no self-ring, no hangup.
      const agentCallSid = activeCall?.parameters?.CallSid || null;
      console.log(
        "[group] starting — customerSid=", sidToGroup,
        "agentCallSid=", agentCallSid
      );
      try {
        const data = await apiFetch(
          `/phone-device/calls/${encodeURIComponent(sidToGroup)}/group`,
          { method: "POST", body: { agentCallSid } }
        );
        console.log("[group] server response:", data);
        if (!data || !data.ok) throw new Error(data?.error || "Group start failed");
        currentGroupName = data.groupName;
        // Re-render so Hold/Transfer/Group reflect the group state.
        setCallState("in-call", { caller: callTitle.textContent });
        toast("Group started — opening controls…", "success", 1500);
        // Open the dedicated group-management window. The Voice SDK
        // keeps running in this window; the new window is pure UI.
        try { await window.jobcountPhone.openGroupWindow({ groupName: data.groupName }); }
        catch (e) { toast(`Couldn't open group window: ${e.message}`, "error"); }
      } catch (err) {
        btnGroup.disabled = false;
        // Log the whole error object + stack so we can see Twilio error
        // codes / statuses if the server bubbled them through.
        console.error("[group] failed:", err, "status:", err?.status);
        toast(`Group failed: ${err.message}`, "error", 6000);
      }
    });
  }

  // ═══════════════ TABS: Recents / Contacts / Keypad / Group ═══════════════
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabPanels  = document.querySelectorAll(".tab-panel");

  function switchTab(name) {
    tabButtons.forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === name));
    tabPanels.forEach((p) => { p.hidden = p.getAttribute("data-tab-panel") !== name; });
    if (name === "recents")  refreshRecents();
    if (name === "contacts") refreshContacts();
    if (name === "group")    refreshGroupInit();
  }
  tabButtons.forEach((b) => b.addEventListener("click", () => switchTab(b.getAttribute("data-tab"))));

  // ─── Recents tab ─────────────────────────────────────────────
  const recentsList = document.getElementById("recentsList");
  const btnRecentsRefresh = document.getElementById("btnRecentsRefresh");
  async function refreshRecents() {
    if (!recentsList) return;
    recentsList.innerHTML = '<div class="tab-empty">Loading…</div>';
    try {
      const data = await apiFetch("/phone-device/recents?limit=50");
      const recents = Array.isArray(data?.recents) ? data.recents : [];
      if (!recents.length) {
        recentsList.innerHTML = '<div class="tab-empty">No calls yet.</div>';
        return;
      }
      recentsList.innerHTML = recents.map((r) => {
        const other = r.counterparty || (r.direction === "in" ? (r.from || "") : (r.to || ""));
        const phone = formatPhone(other);
        const nameLine = r.customerName || phone || "Unknown";
        const subLine  = r.customerName && phone && phone !== r.customerName ? phone : "";

        // Three row variants:
        //   - missed (inbound + not answered)          → red phone-down icon
        //   - unanswered outbound (no-answer/busy/…)   → red arrow-up-right
        //   - regular in / out                         → green / blue arrows
        let iconCls, iconSvg;
        if (r.missed) {
          iconCls = "rec-missed";
          iconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M23 6L13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
        } else if (r.direction === "out" && r.unanswered) {
          iconCls = "rec-missed";
          iconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="15 7 21 7 21 13"/><path d="M21 7L10 18l-4-4L3 17"/></svg>';
        } else if (r.direction === "in") {
          iconCls = "rec-in";
          iconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="16 17 22 11"/><polyline points="22 11 22 17 16 17"/><path d="M22 11l-8 8-4-4-8 8"/></svg>';
        } else {
          iconCls = "rec-out";
          iconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="8 7 2 13"/><polyline points="2 13 2 7 8 7"/><path d="M2 13l8-8 4 4 8-8"/></svg>';
        }

        const when = relTime(r.at);
        const statusLabel =
          r.missed                       ? "Missed" :
          r.direction === "out" && r.unanswered ? "No answer" :
          r.direction === "in"           ? "Incoming" :
          "Outgoing";
        return `
        <div class="rec-row" data-number="${esc(other)}" title="${esc(statusLabel)}">
          <div class="rec-icon ${iconCls}">${iconSvg}</div>
          <div class="rec-info">
            <div class="rec-name">${esc(nameLine)}</div>
            ${subLine ? `<div class="rec-sub">${esc(subLine)}</div>` : ""}
          </div>
          <div class="rec-time">${esc(when)}</div>
        </div>`;
      }).join("");
    } catch (e) {
      recentsList.innerHTML = `<div class="tab-empty">Couldn't load recents: ${esc(e.message)}</div>`;
    }
  }
  if (btnRecentsRefresh) btnRecentsRefresh.addEventListener("click", refreshRecents);
  if (recentsList) {
    recentsList.addEventListener("click", (e) => {
      const row = e.target.closest(".rec-row");
      if (!row) return;
      const num = row.getAttribute("data-number");
      if (num) dialNumberFromTab(num);
    });
  }

  function relTime(iso) {
    const d = new Date(iso);
    const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (secs < 60) return "just now";
    if (secs < 3600) return Math.floor(secs / 60) + "m";
    if (secs < 86400) return Math.floor(secs / 3600) + "h";
    if (secs < 86400 * 7) return Math.floor(secs / 86400) + "d";
    return d.toLocaleDateString();
  }

  // ─── Contacts tab ────────────────────────────────────────────
  const contactsList = document.getElementById("contactsList");
  const contactsSearch = document.getElementById("contactsSearch");
  let _contactsCache = [];
  async function refreshContacts() {
    if (!contactsList) return;
    if (_contactsCache.length) { renderContacts(contactsSearch.value.trim()); return; }
    contactsList.innerHTML = '<div class="tab-empty">Loading contacts…</div>';
    try {
      const data = await apiFetch("/phone-device/contacts");
      _contactsCache = Array.isArray(data?.contacts) ? data.contacts : [];
      renderContacts(contactsSearch.value.trim());
    } catch (e) {
      contactsList.innerHTML = `<div class="tab-empty">Couldn't load contacts: ${esc(e.message)}</div>`;
    }
  }
  function renderContacts(filter) {
    const f = (filter || "").toLowerCase();
    const rows = f
      ? _contactsCache.filter(
          (c) => c.name.toLowerCase().includes(f) || (c.phone || "").includes(f)
        )
      : _contactsCache;
    if (!rows.length) {
      contactsList.innerHTML = '<div class="tab-empty">No contacts.</div>';
      return;
    }
    contactsList.innerHTML = rows.map((c) => `
      <div class="con-row" data-number="${esc(c.phone || c.phoneAlt)}">
        <div class="con-info">
          <div class="con-name">${esc(c.name)}</div>
          <div class="con-sub">${esc(formatPhone(c.phone || c.phoneAlt))}</div>
        </div>
      </div>
    `).join("");
  }
  if (contactsSearch) {
    let deb;
    contactsSearch.addEventListener("input", () => {
      clearTimeout(deb);
      deb = setTimeout(() => renderContacts(contactsSearch.value.trim()), 120);
    });
  }
  if (contactsList) {
    contactsList.addEventListener("click", (e) => {
      const row = e.target.closest(".con-row");
      if (!row) return;
      const num = row.getAttribute("data-number");
      if (num) dialNumberFromTab(num);
    });
  }

  // Helper: populate dial input + switch to Keypad tab so user sees
  // what they're about to call. Doesn't auto-dial — give them a chance
  // to edit or cancel.
  function dialNumberFromTab(num) {
    const cleaned = String(num || "").replace(/[^\d+]/g, "");
    if (!cleaned) return;
    dialInput.value = cleaned;
    switchTab("keypad");
    // Focus the dial button so Enter would fire it.
    setTimeout(() => { try { btnDial.focus(); } catch {} }, 80);
  }

  // ─── Group initiation tab ────────────────────────────────────
  const groupInitDevices = document.getElementById("groupInitDevices");
  const groupInitNumbers = document.getElementById("groupInitNumbers");
  const groupInitNumInput = document.getElementById("groupInitNumInput");
  const btnGroupInitAddNum = document.getElementById("btnGroupInitAddNum");
  const btnStartGroup = document.getElementById("btnStartGroup");
  const _groupInitSelection = { deviceIds: new Set(), numbers: [] };

  async function refreshGroupInit() {
    if (!groupInitDevices) return;
    groupInitDevices.innerHTML = '<div class="tab-empty">Loading…</div>';
    try {
      const data = await apiFetch("/phone-device/peers");
      const peers = Array.isArray(data?.peers) ? data.peers : [];
      if (!peers.length) {
        groupInitDevices.innerHTML = '<div class="tab-empty">No other paired devices.</div>';
      } else {
        groupInitDevices.innerHTML = peers.map((p) => {
          const selected = _groupInitSelection.deviceIds.has(p._id);
          return `
            <label class="gis-item ${selected ? "selected" : ""} ${p.isOnline ? "" : "offline"}">
              <input type="checkbox" data-gi-device-id="${esc(p._id)}" ${selected ? "checked" : ""} ${p.isOnline ? "" : "disabled"}>
              <span>${esc(p.label || p.hostname || "Device")}</span>
              <span class="pr-sub" style="margin-left:auto;">${p.isOnline ? "Online" : "Offline"}</span>
            </label>`;
        }).join("");
      }
    } catch (e) {
      groupInitDevices.innerHTML = `<div class="tab-empty">Couldn't load: ${esc(e.message)}</div>`;
    }
    renderGroupInitNumbers();
    updateStartGroupButton();
  }

  function renderGroupInitNumbers() {
    groupInitNumbers.innerHTML = _groupInitSelection.numbers.length
      ? _groupInitSelection.numbers.map((n, i) => `
        <div class="gis-num-row">
          <span>${esc(formatPhone(n))}</span>
          <button data-gi-remove-num="${i}" title="Remove">×</button>
        </div>
      `).join("")
      : "";
  }

  function updateStartGroupButton() {
    const n = _groupInitSelection.deviceIds.size + _groupInitSelection.numbers.length;
    btnStartGroup.disabled = n === 0 || !!activeCall;
    btnStartGroup.textContent = n
      ? `Start Group (${n} invitee${n === 1 ? "" : "s"})`
      : "Start Group";
    if (activeCall) btnStartGroup.title = "Finish your current call first";
    else if (!n) btnStartGroup.title = "Select at least one device or number";
    else btnStartGroup.title = "";
  }

  if (groupInitDevices) {
    groupInitDevices.addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-gi-device-id]");
      if (!cb) return;
      const id = cb.getAttribute("data-gi-device-id");
      if (cb.checked) _groupInitSelection.deviceIds.add(id);
      else _groupInitSelection.deviceIds.delete(id);
      cb.closest(".gis-item")?.classList.toggle("selected", cb.checked);
      updateStartGroupButton();
    });
  }
  if (btnGroupInitAddNum && groupInitNumInput) {
    const addNum = () => {
      const raw = (groupInitNumInput.value || "").trim();
      const cleaned = raw.replace(/[^\d+]/g, "");
      const digits = cleaned.replace(/\D/g, "");
      if (digits.length < 10) {
        toast("Enter a valid phone number", "error");
        return;
      }
      const norm = /^\d{10}$/.test(cleaned) ? "+1" + cleaned : cleaned;
      if (!_groupInitSelection.numbers.includes(norm)) {
        _groupInitSelection.numbers.push(norm);
        renderGroupInitNumbers();
        updateStartGroupButton();
      }
      groupInitNumInput.value = "";
    };
    btnGroupInitAddNum.addEventListener("click", addNum);
    groupInitNumInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addNum(); });
  }
  if (groupInitNumbers) {
    groupInitNumbers.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-gi-remove-num]");
      if (!btn) return;
      const idx = Number(btn.getAttribute("data-gi-remove-num"));
      _groupInitSelection.numbers.splice(idx, 1);
      renderGroupInitNumbers();
      updateStartGroupButton();
    });
  }

  // Start Group from the tab (no active customer call involved).
  // Server opens a fresh conference with just this device as admin,
  // then the renderer dials each selected invitee into it.
  if (btnStartGroup) {
    btnStartGroup.addEventListener("click", async () => {
      btnStartGroup.disabled = true;
      btnStartGroup.textContent = "Starting…";
      const payload = {
        deviceIds: Array.from(_groupInitSelection.deviceIds),
        numbers: _groupInitSelection.numbers,
      };
      try {
        const data = await apiFetch("/phone-device/groups/new", { method: "POST", body: payload });
        if (!data || !data.ok) throw new Error(data?.error || "Start failed");
        currentGroupName = data.groupName;
        toast("Group starting — opening controls…", "success", 1500);
        try { await window.jobcountPhone.openGroupWindow({ groupName: data.groupName }); } catch {}
        // Reset selection for next time.
        _groupInitSelection.deviceIds.clear();
        _groupInitSelection.numbers.length = 0;
        renderGroupInitNumbers();
      } catch (err) {
        console.error("[group-init]", err);
        toast(`Start failed: ${err.message}`, "error", 5000);
      } finally {
        updateStartGroupButton();
      }
    });
  }

  // ─── Socket subscriptions for live queue/held events ───────────
  function hookCallControlSocketEvents() {
    if (!presenceSocket) return;
    const bump = (label) => {
      // Small delay so Twilio REST state has settled before we poll.
      setTimeout(() => { refreshQueue(); refreshHeld(); }, 300);
    };
    presenceSocket.on("call:held",          () => bump("held"));
    presenceSocket.on("call:resumed",       () => bump("resumed"));
    presenceSocket.on("call:hangup",        () => bump("hangup"));
    presenceSocket.on("call:answered-next", () => bump("answered-next"));
    presenceSocket.on("call:transferred",   () => bump("transferred"));
    presenceSocket.on("call:status",        () => bump("status"));
  }

  // Bootstrapping for the panels: kick a first refresh as soon as the
  // phone screen is live, then start periodic polling as a safety net.
  function startLiveMonitors() {
    // No log here — the refresh functions already surface state
    // changes via [queue] / [held] prefix logs.
    refreshQueue();
    refreshHeld();
    if (queuePollTimer) clearInterval(queuePollTimer);
    if (heldPollTimer)  clearInterval(heldPollTimer);
    queuePollTimer = setInterval(refreshQueue, 5000);
    heldPollTimer  = setInterval(refreshHeld,  5000);
    hookCallControlSocketEvents();
  }

  // Expose on window so you can hand-fire them from DevTools console
  // to confirm the server is returning what you expect:
  //   window.refreshHeld()   -> triggers a poll, logs [refreshHeld] + _debug
  //   window.refreshQueue()  -> same for the live queue
  //   window.dumpHeldState() -> shows current cached list
  window.refreshHeld = refreshHeld;
  window.refreshQueue = refreshQueue;
  window.dumpHeldState = () => ({ heldState, queueState, currentCustomerCallSid });

  // ─── Window controls ───────────────────────────────────────────
  btnMinimize.addEventListener("click", () => window.jobcountPhone.minimizeToTray());

  // ─── System wake → proactively refresh Twilio token ──────────────
  //
  // The refresh timer we schedule in scheduleTokenRefresh() can get
  // paused by the OS during sleep/lock. When the machine wakes back up
  // the token has often already expired, and the next incoming call
  // bombs with AccessTokenExpired (20104). Listen for the main process's
  // wake ping and force a token refresh ourselves; if that fails we fall
  // through to reconnectDevice() which tears everything down and rebuilds.
  try {
    window.jobcountPhone.onSystemWake?.((payload) => {
      console.log("[wake] system event:", payload);
      if (!device) {
        // Wasn't connected anyway — trigger a full reconnect.
        reconnectDevice().catch((e) => {
          console.error("[wake] reconnect failed:", e);
          showReconnectButton(true);
        });
        return;
      }
      refreshDeviceToken().catch(async (e) => {
        console.warn("[wake] token refresh failed — reconnecting:", e?.message);
        try { await reconnectDevice(); }
        catch { showReconnectButton(true); }
      });
    });
  } catch {}

  // ═══════════════ AUTO-UPDATE UI ═══════════════
  // Subscribe to electron-updater events from the main process and
  // surface them in two places: a persistent pill in the top bar
  // (only appears when an update is relevant) and a detailed panel in
  // Settings that shows current version + status + install button.
  const updatePill      = document.getElementById("updatePill");
  const updatePillText  = document.getElementById("updatePillText");
  const updateStatusEl  = document.getElementById("updateStatus");
  const btnCheckUpdates = document.getElementById("btnCheckUpdates");
  const btnInstallUpdate = document.getElementById("btnInstallUpdate");
  const settingsAppVersion = document.getElementById("settingsAppVersion");

  function renderUpdateState(payload) {
    if (!payload) return;
    // In dev, short-circuit any "available" / "downloading" / "ready"
    // states so a stale event lingering from a pre-fix session can't
    // resurrect the pill. Dev always renders as idle regardless of what
    // electron-updater thinks.
    const st = _isDevMode ? "idle" : payload.state;

    // Top-bar pill — only visible in PRODUCTION for "downloading" or
    // "ready" states. In dev we're the one publishing updates, so a
    // "Update ready" pill would be nonsense and visually noisy.
    if (updatePill) {
      if (_isDevMode) {
        updatePill.hidden = true;
      } else if (st === "downloading") {
        updatePill.hidden = false;
        updatePill.classList.remove("ready");
        updatePill.classList.add("downloading");
        updatePillText.textContent = `Updating… ${payload.percent || 0}%`;
        updatePill.title = "An update is downloading in the background.";
      } else if (st === "ready") {
        updatePill.hidden = false;
        updatePill.classList.remove("downloading");
        updatePill.classList.add("ready");
        updatePillText.textContent = `Update ${payload.version || ""} ready`;
        updatePill.title = "Click to install and restart.";
      } else {
        // "idle", "checking", "up-to-date", "available", "error",
        // anything else — no pill. We only interrupt the agent's
        // top bar when there's something actionable for them.
        updatePill.hidden = true;
      }
    }

    // Settings panel — always reflects latest state, with dev-aware
    // phrasing so the agent isn't told to "press Check now" when
    // they're actually running from source.
    if (updateStatusEl) {
      const label = (() => {
        if (_isDevMode && (st === "idle" || st === "up-to-date")) {
          return "Dev build — use the Publish Update panel below to ship a new version.";
        }
        switch (st) {
          case "idle":        return "Updates are manual. Press Check now to see if a new version is available.";
          case "checking":    return "Checking for updates…";
          case "up-to-date":  return "You're on the latest version.";
          case "available":   return `Update available: v${payload.version}. Downloading…`;
          case "downloading": return `Downloading v${payload.version || ""}… ${payload.percent || 0}%`;
          case "ready":       return `Update v${payload.version} ready. Click Install & Restart.`;
          case "error":       return `Update check failed: ${payload.error || "unknown"}`;
          default:
            return _isDevMode
              ? "Dev build — use the Publish Update panel below to ship a new version."
              : "Updates are manual. Press Check now to see if a new version is available.";
        }
      })();
      updateStatusEl.textContent = label;
      updateStatusEl.classList.toggle("error",  st === "error");
      updateStatusEl.classList.toggle("ready",  st === "ready" && !_isDevMode);
    }
    // Install button: shown only in prod when there's actually a
    // downloaded update. In dev it's never relevant.
    if (btnInstallUpdate) btnInstallUpdate.hidden = (_isDevMode || st !== "ready");
    // Check button: hidden in dev too — publishing is the dev workflow.
    if (btnCheckUpdates) btnCheckUpdates.style.display = _isDevMode ? "none" : "";
  }

  if (btnCheckUpdates) {
    btnCheckUpdates.addEventListener("click", async () => {
      btnCheckUpdates.disabled = true;
      try {
        const r = await window.jobcountPhone.checkForUpdates();
        if (!r.ok) renderUpdateState({ state: "error", error: r.error });
      } finally {
        setTimeout(() => { btnCheckUpdates.disabled = false; }, 1200);
      }
    });
  }
  if (btnInstallUpdate) {
    btnInstallUpdate.addEventListener("click", async () => {
      btnInstallUpdate.disabled = true;
      try { await window.jobcountPhone.installUpdateNow(); }
      catch (e) { btnInstallUpdate.disabled = false; }
    });
  }
  if (updatePill) {
    updatePill.addEventListener("click", async () => {
      if (updatePill.classList.contains("ready")) {
        try { await window.jobcountPhone.installUpdateNow(); } catch {}
      }
    });
  }

  // Initialize the update subsystem in a deterministic order:
  //   1. Fetch systemInfo so _isDevMode is set BEFORE any render call
  //   2. Do the initial render with the correct dev-mode flag
  //   3. THEN subscribe to future update-state events
  //
  // Prior versions raced between the initial IIFE and boot()'s
  // dev-mode detection, causing the "Update ready" pill to briefly
  // appear in dev builds when an update had been downloaded earlier
  // in the same process.
  (async () => {
    try {
      const sys = await window.jobcountPhone.systemInfo();
      _isDevMode = !!(sys && sys.jobcountEnv === "dev");
    } catch {}

    try {
      const info = await window.jobcountPhone.getUpdateState?.();
      if (info?.version && settingsAppVersion) {
        settingsAppVersion.textContent = `v${info.version}`;
      }
      renderUpdateState(info?.last || { state: "idle" });
    } catch {}

    // Subscribe only after initial state is settled — any update-state
    // event from here on re-renders with the correct _isDevMode.
    try {
      window.jobcountPhone.onUpdateState?.((payload) => renderUpdateState(payload));
    } catch {}
  })();

  // ═══════════════ DEV-ONLY: Publish Update panel ═══════════════
  // Lives in the Settings tab. Lets you bump version + push tag
  // without leaving the app — kicks off the GitHub Actions release
  // workflow which produces an installer that production devices
  // auto-update to.
  const devPublishPanel  = document.getElementById("devPublishPanel");
  const devCurrentVersion = document.getElementById("devCurrentVersion");
  const devReadiness     = document.getElementById("devReadiness");
  const devPublishLog    = document.getElementById("devPublishLog");
  const devLogWrap       = document.getElementById("devLogWrap");
  const btnCopyPublishLog = document.getElementById("btnCopyPublishLog");
  const btnClearPublishLog = document.getElementById("btnClearPublishLog");
  const devPublishButtons = devPublishPanel
    ? devPublishPanel.querySelectorAll("button[data-bump]")
    : [];

  async function refreshPublishReadiness() {
    if (!devPublishPanel) return;
    let r = null;
    try { r = await window.jobcountPhone.publishReadiness?.(); } catch {}
    if (!r || !r.isDev) {
      devPublishPanel.hidden = true;
      return;
    }
    devPublishPanel.hidden = false;
    devCurrentVersion.textContent = `v${r.currentVersion || "?"}`;
    if (r.ready) {
      devReadiness.className = "dev-readiness ok";
      devReadiness.textContent = "Ready to publish.";
      devPublishButtons.forEach((b) => { b.disabled = false; });
    } else {
      devReadiness.className = "dev-readiness blocked";
      devReadiness.textContent = "Cannot publish:\n" +
        (r.reasons || []).join("\n");
      devPublishButtons.forEach((b) => { b.disabled = true; });
    }
  }

  function appendPublishLog(line, kind) {
    if (!devPublishLog) return;
    if (devLogWrap) devLogWrap.hidden = false;
    const span = document.createElement("span");
    span.className = `log-${kind || "out"}`;
    span.textContent = line + "\n";
    devPublishLog.appendChild(span);
    devPublishLog.scrollTop = devPublishLog.scrollHeight;
  }

  if (btnCopyPublishLog) {
    btnCopyPublishLog.addEventListener("click", async () => {
      const text = devPublishLog ? devPublishLog.innerText : "";
      if (!text) { toast("Log is empty", "info", 1200); return; }
      // Main-process clipboard avoids the "Write permission denied"
      // error that navigator.clipboard throws inside a sandboxed
      // renderer. Fall back to navigator.clipboard if the IPC is
      // somehow unavailable (e.g. older preload bundle).
      let ok = false;
      let errMsg = "";
      try {
        if (window.jobcountPhone.clipboardWrite) {
          const r = await window.jobcountPhone.clipboardWrite(text);
          ok = !!r?.ok;
          if (!ok) errMsg = r?.error || "unknown";
        } else {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch (e) {
        errMsg = e.message;
      }
      if (ok) {
        const orig = btnCopyPublishLog.innerHTML;
        btnCopyPublishLog.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
        setTimeout(() => { btnCopyPublishLog.innerHTML = orig; }, 1500);
      } else {
        toast(`Copy failed: ${errMsg}`, "error");
      }
    });
  }

  if (btnClearPublishLog) {
    btnClearPublishLog.addEventListener("click", () => {
      if (devPublishLog) devPublishLog.innerHTML = "";
      if (devLogWrap) devLogWrap.hidden = true;
    });
  }

  if (devPublishPanel) {
    // Subscribe once; the handler stays for the app's lifetime.
    try {
      window.jobcountPhone.onPublishLog?.((payload) => {
        if (!payload) return;
        appendPublishLog(payload.line, payload.kind);
      });
    } catch {}

    devPublishButtons.forEach((btn) => {
      btn.addEventListener("click", async () => {
        const bump = btn.getAttribute("data-bump");
        if (!bump) return;
        if (!confirm(`Publish a ${bump} version bump? This will create + push a new git tag and start the GitHub Actions build.`)) return;

        devPublishButtons.forEach((b) => { b.disabled = true; });
        if (devPublishLog) devPublishLog.innerHTML = "";
        appendPublishLog(`▶ Starting ${bump} release…`, "step");
        try {
          const result = await window.jobcountPhone.publishUpdate({ bump });
          if (result?.ok) {
            appendPublishLog(`\n✓ Published ${result.tagName}`, "ok");
            toast(`Published ${result.tagName} — GitHub Actions building`, "success", 4000);
          } else {
            appendPublishLog(`\n✗ Publish failed: ${result?.error || "unknown"}`, "fail");
          }
        } catch (e) {
          appendPublishLog(`\n✗ Publish errored: ${e.message}`, "fail");
        }
        // Re-check readiness — version moved, working tree clean again.
        await refreshPublishReadiness();
      });
    });
  }

  // Kick once at startup so the panel appears on the very first
  // settings open without a delay.
  refreshPublishReadiness();

  // ─── Kick off ──────────────────────────────────────────────────
  boot().catch((e) => {
    console.error("Boot failed:", e);
    loadingSub.textContent = "Error: " + (e.message || "unknown");
  });
})();
