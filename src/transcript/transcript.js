// src/transcript/transcript.js
//
// Live-transcript window. Subscribes directly to the /phone-live socket
// (separate connection from the main softphone window — same pattern
// the group window uses) and renders incoming transcript:* events.
//
// Audio capture happens in the MAIN softphone window because that's
// where the active Twilio call lives — see LiveTranscribe in
// src/renderer/app.js. This window is read-only display + a target-
// language picker.
//
// Display model:
//   Each utterance (one per OpenAI VAD-committed segment) is identified
//   by `${side}-${seq}`. We render a bubble in the matching lane that
//   shows the verbatim source text on top and the translation
//   underneath. Partial deltas update the same bubble in place; the
//   `.completed` event freezes the source and the parallel translation
//   request resolves a moment later to fill in the bottom half.

(() => {
  // ─── Bootstrap from URL hash ─────────────────────────────────
  // Main process passed { target, callSid, peerLabel } via #...
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const initialTarget = params.get("target") === "ru" ? "ru" : "en";
  const callSid = params.get("callSid") || "";
  const peerLabel = params.get("peerLabel") || "";

  // ─── DOM refs ────────────────────────────────────────────────
  const peerLabelEl = document.getElementById("peerLabel");
  const targetSelect = document.getElementById("targetLang");
  const btnClose = document.getElementById("btnClose");
  const statusDot = document.getElementById("statusDot");
  const statusLine = document.getElementById("statusLine");
  const laneLocal = document.getElementById("laneLocal");
  const laneRemote = document.getElementById("laneRemote");

  if (peerLabel) peerLabelEl.textContent = peerLabel;
  targetSelect.value = initialTarget;

  btnClose.addEventListener("click", () => window.close());
  // Forward language changes over the socket so the server's translator
  // switches mid-call without the user having to restart.
  targetSelect.addEventListener("change", () => {
    if (!socket || !socket.connected) return;
    socket.emit("transcript:set-target", { target: targetSelect.value });
    setStatus(`Translating to ${targetSelect.value === "ru" ? "Russian" : "English"}.`);
  });

  // Host (main softphone window) tells us when the call ends so we can
  // close the window cleanly.
  if (window.jobcountPhone?.onTranscriptHostEvent) {
    window.jobcountPhone.onTranscriptHostEvent((evt) => {
      if (evt?.kind === "stopped") {
        setStatus("Call ended.");
        statusDot.classList.add("idle");
      }
    });
  }

  // ─── Utterance bubble registry ───────────────────────────────
  // Map<sideSeqKey, { utt, source, translation }>. Keeps DOM lookups
  // O(1) so high-rate partials don't re-querySelector the world.
  const _bubbles = new Map();

  function _laneEl(side) { return side === "local" ? laneLocal : laneRemote; }
  function _key(side, seq) { return `${side}-${seq}`; }

  function _ensureBubble(side, seq, opts = {}) {
    const k = _key(side, seq);
    let entry = _bubbles.get(k);
    if (entry) return entry;

    const lane = _laneEl(side);
    // Drop the "Waiting for speech…" placeholder the first time a
    // bubble appears in this lane.
    const empty = lane.querySelector(".lane-empty");
    if (empty) empty.remove();

    const utt = document.createElement("div");
    utt.className = "utterance" + (opts.partial ? " partial" : "");
    utt.id = `utt-${k}`;

    const source = document.createElement("div");
    source.className = "utt-source";
    utt.appendChild(source);

    const translation = document.createElement("div");
    translation.className = "utt-translation pending";
    translation.textContent = "translating…";
    utt.appendChild(translation);

    lane.appendChild(utt);
    // Keep the most recent line in view. Only autoscroll if the user
    // is near the bottom — don't yank the scroll out from under
    // someone who's reading earlier lines.
    const nearBottom = lane.scrollHeight - lane.scrollTop - lane.clientHeight < 80;
    if (nearBottom) lane.scrollTop = lane.scrollHeight;

    entry = { utt, source, translation };
    _bubbles.set(k, entry);
    return entry;
  }

  function onPartial({ side, seq, delta }) {
    if (!delta) return;
    const entry = _ensureBubble(side, seq, { partial: true });
    entry.source.textContent += delta;
    const lane = _laneEl(side);
    const nearBottom = lane.scrollHeight - lane.scrollTop - lane.clientHeight < 80;
    if (nearBottom) lane.scrollTop = lane.scrollHeight;
  }

  function onFinal({ side, seq, text }) {
    const entry = _ensureBubble(side, seq);
    entry.utt.classList.remove("partial");
    // Replace any accumulated partial deltas with the authoritative
    // verbatim text — partials sometimes have minor revisions the
    // committed text corrects.
    entry.source.textContent = text;
  }

  function onTranslation({ side, seq, translated }) {
    const entry = _ensureBubble(side, seq);
    entry.translation.classList.remove("pending");
    entry.translation.textContent = translated || "";
  }

  function onError({ side, error }) {
    setStatus(`Error: ${error}${side ? ` (${side})` : ""}`, "error");
  }

  function setStatus(msg, kind) {
    statusLine.textContent = msg;
    statusLine.classList.toggle("error", kind === "error");
    statusLine.classList.toggle("ok", kind === "ok");
  }

  // ─── Socket connection ───────────────────────────────────────
  let socket = null;

  async function connect() {
    let cfg, token;
    try {
      [cfg, token] = await Promise.all([
        window.jobcountPhone.getConfig(),
        window.jobcountPhone.getDeviceToken(),
      ]);
    } catch (e) {
      setStatus(`Config load failed: ${e.message}`, "error");
      return;
    }
    if (!cfg?.serverUrl || !token) {
      setStatus("Not paired — close this window and pair the device.", "error");
      return;
    }
    setStatus("Connecting to live transcription…");
    socket = window.io(`${cfg.serverUrl}/phone-live`, {
      auth: { deviceToken: token },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
    });

    socket.on("connect", () => {
      statusDot.classList.remove("idle", "error");
      setStatus(`Listening — translating to ${targetSelect.value === "ru" ? "Russian" : "English"}.`, "ok");
    });
    socket.on("disconnect", (reason) => {
      statusDot.classList.add("idle");
      setStatus(`Disconnected (${reason}). Reconnecting…`);
    });
    socket.on("connect_error", (e) => {
      statusDot.classList.add("error");
      setStatus(`Connection error: ${e.message}`, "error");
    });

    // Filter events by callSid if we know it — the shop room broadcasts
    // every device's events, and we only want this call's stream.
    function _matches(payload) {
      if (!callSid) return true;
      return !payload?.callSid || payload.callSid === callSid;
    }
    socket.on("transcript:partial",     (p) => { if (_matches(p)) onPartial(p); });
    socket.on("transcript:final",       (p) => { if (_matches(p)) onFinal(p); });
    socket.on("transcript:translation", (p) => { if (_matches(p)) onTranslation(p); });
    socket.on("transcript:error",       (p) => { if (_matches(p)) onError(p); });
    socket.on("transcript:started",     () => setStatus("Live — capturing audio.", "ok"));
    socket.on("transcript:stopped",     () => {
      setStatus("Stopped.");
      statusDot.classList.add("idle");
    });
  }

  window.addEventListener("beforeunload", () => {
    try { socket && socket.disconnect(); } catch {}
  });

  connect();
})();
