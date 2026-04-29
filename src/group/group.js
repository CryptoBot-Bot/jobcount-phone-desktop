// src/group/group.js
//
// Controller for the Group conference window. The window is opened by
// the main renderer via IPC, with groupName passed through the URL hash
// (#group=<name>). We re-use the same device bearer token + server URL
// that the main window uses — the main process exposes both via the
// jobcountPhone preload bridge.
//
// No Twilio.Device here — audio is already flowing through the main
// window's SDK connection (the agent's Voice SDK call was redirected
// into the conference by the server). This window is purely a control
// surface for participant management.

"use strict";

(function () {
  // ─── Parse groupName from URL hash ────────────────────────────
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
  const groupName = hashParams.get("group");
  if (!groupName) {
    document.body.innerHTML =
      '<div style="padding:20px;color:#fff;">No group specified. Close this window and try again.</div>';
    return;
  }

  // ─── DOM ──────────────────────────────────────────────────────
  const statusDot = document.getElementById("groupStatusDot");
  const pCount = document.getElementById("groupParticipantCount");
  const selfBanner = document.getElementById("selfBanner");
  const selfLabel = document.getElementById("selfLabel");
  const selfRole = document.getElementById("selfRole");
  const participantList = document.getElementById("participantList");
  const btnInvite = document.getElementById("btnInvite");
  const btnLeave = document.getElementById("btnLeave");
  const btnCloseWindow = document.getElementById("btnCloseWindow");
  const invitePicker = document.getElementById("invitePicker");
  const btnInviteClose = document.getElementById("btnInviteClose");
  const inviteDeviceBody = document.getElementById("inviteDeviceBody");
  const inviteNumberBody = document.getElementById("inviteNumberBody");
  const inviteNumberInput = document.getElementById("inviteNumberInput");
  const btnInviteNumber = document.getElementById("btnInviteNumber");
  const inviteNumberStatus = document.getElementById("inviteNumberStatus");
  const modalTabs = document.querySelectorAll(".modal-tab");
  const successorPicker = document.getElementById("successorPicker");
  const successorPickerBody = document.getElementById("successorPickerBody");
  const btnSuccessorCancel = document.getElementById("btnSuccessorCancel");

  // ─── State ────────────────────────────────────────────────────
  let currentSnapshot = null;   // last fetched group state from server
  let selfDeviceId = null;      // learned from config
  let selfShopId = null;        // learned from config
  let pollTimer = null;
  let groupSocket = null;       // socket.io-client connection to /phone-live
  let leaving = false;          // prevent close-window -> re-leave loop

  // ─── Helpers ──────────────────────────────────────────────────
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c])
    );

  function toast(msg, variant = "info", ttl = 2500) {
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

  // Device-authenticated fetch through the main process preload bridge.
  async function apiFetch(path, options = {}) {
    const res = await window.jobcountPhone.apiRequest({
      method: options.method || "GET",
      path,
      body: options.body || null,
      authenticated: true,
    });
    if (!res || !res.ok) {
      const msg = (res && res.data && res.data.error) || `HTTP ${res?.status || "?"}`;
      const err = new Error(msg);
      err.status = res?.status;
      throw err;
    }
    return res.data;
  }

  // ─── Initial load: fetch config (for selfDeviceId) + first snapshot ──
  async function boot() {
    const cfg = await window.jobcountPhone.getConfig();
    selfDeviceId = cfg?.deviceId || null;
    selfShopId = cfg?.shopId || null;
    if (cfg?.label) selfLabel.textContent = cfg.label;

    await refreshGroup();

    // Connect a socket subscription so the snapshot updates on every
    // server-side state change (participant ringing → connected →
    // hungup, mute toggles, kicks, etc.) without waiting for the
    // 3-second poll. The poll is kept as a fallback for socket gaps.
    await connectGroupSocket();

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshGroup, 3000);
  }

  async function connectGroupSocket() {
    try {
      if (groupSocket) { try { groupSocket.disconnect(); } catch {} groupSocket = null; }
      if (!window.io) { console.warn("socket.io-client missing"); return; }
      const cfg = await window.jobcountPhone.getConfig();
      const token = await window.jobcountPhone.getDeviceToken();
      const serverUrl = (cfg?.serverUrl || "").replace(/\/+$/, "");
      if (!serverUrl || !token) return;

      groupSocket = window.io(`${serverUrl}/phone-live`, {
        auth: { deviceToken: token },
        path: "/socket.io",
        transports: ["websocket"],
        upgrade: false,
        reconnection: true,
        reconnectionDelay: 1500,
        reconnectionDelayMax: 15000,
      });

      // Server pushes the full hydrated snapshot on every state change.
      groupSocket.on("group:snapshot", (payload) => {
        if (!payload || payload.groupName !== groupName) return;
        if (payload.snapshot) {
          currentSnapshot = payload.snapshot;
          render();
        }
      });
      groupSocket.on("group:ended", (payload) => {
        if (!payload || payload.groupName !== groupName) return;
        statusDot.style.background = "#ef4444";
        statusDot.style.boxShadow = "";
        participantList.innerHTML = '<div class="empty">Group has ended.</div>';
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      });
      groupSocket.on("connect_error", (e) =>
        console.warn("[group-socket] connect error:", e.message));
    } catch (e) {
      console.warn("[group-socket] connect failed:", e.message);
    }
  }

  // ─── Group refresh + render ──────────────────────────────────
  async function refreshGroup() {
    try {
      const data = await apiFetch(`/phone-device/groups/${encodeURIComponent(groupName)}`);
      currentSnapshot = data?.group || null;
      render();
    } catch (e) {
      if (e.status === 404) {
        // Group is gone — conference ended, hangups, or server restarted.
        statusDot.style.background = "#ef4444";
        statusDot.style.boxShadow = "";
        participantList.innerHTML = '<div class="empty">Group has ended.</div>';
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      } else {
        console.warn("refreshGroup:", e.message);
      }
    }
  }

  function render() {
    if (!currentSnapshot) return;
    const { participants, adminDeviceId, maxParticipants } = currentSnapshot;
    pCount.textContent = `${participants.length} / ${maxParticipants - 1}`;

    // Self role + banner color.
    const amAdmin = String(adminDeviceId) === String(selfDeviceId);
    selfBanner.classList.toggle("role-admin", amAdmin);
    selfRole.textContent = amAdmin ? "ADMIN — you can invite, kick, promote" : "Agent";

    // Invite button only enabled for admin + room left.
    const atCapacity = participants.length >= maxParticipants - 1;
    btnInvite.disabled = !amAdmin || atCapacity;
    btnInvite.title = atCapacity
      ? "Group is full"
      : (amAdmin ? "Invite another paired device" : "Only admin can invite");

    // Participant rows. Each row's color/pulse is driven by `state`:
    //   ringing   → pulsing green (call placed, awaiting pickup/join)
    //   connected → solid green
    //   muted     → solid orange (overrides connected when muted)
    //   hungup    → red, plus a Redial button (admin only)
    //   failed    → red (couldn't even place the call)
    participantList.innerHTML = participants.length
      ? participants.map((p) => {
          const isCustomer = p.type === "customer";
          const isExternal = p.type === "external";
          const isAgent    = p.type === "agent";
          const isSelf     = isAgent && String(p.deviceId) === String(selfDeviceId);
          const isAdmin    = p.role === "admin";
          const state      = p.state || (p.pending ? "ringing" : "connected");
          const muted      = !!p.muted;
          const isRinging  = state === "ringing";
          const isHungup   = state === "hungup" || state === "failed";

          // dotClass: visual state.
          //   customer always shows the customer color UNLESS hungup → red.
          //   muted+connected overrides connected with orange.
          let dotClass;
          if (isHungup) dotClass = "state-hungup";
          else if (isRinging) dotClass = "state-ringing";
          else if (isCustomer) dotClass = "customer";
          else if (muted) dotClass = "state-muted";
          else dotClass = "state-connected";

          // Action visibility (admin only, never customer):
          //   ringing  + not self → Cancel
          //   hungup   + not self → Redial + Remove
          //   live     + not self + agent + !admin → Promote, Mute, Kick
          //   live     + not self + (already admin or external) → Mute, Kick
          //   live     + self     → Mute (unmute) only
          const showCancel  = amAdmin && isRinging && !isSelf && !isCustomer;
          const showRedial  = amAdmin && isHungup  && !isSelf && !isCustomer;
          const showRemove  = amAdmin && isHungup  && !isSelf && !isCustomer;
          const showKick    = amAdmin && !isRinging && !isHungup && !isSelf && !isCustomer;
          const showPromote = amAdmin && !isRinging && !isHungup && !isSelf && !isCustomer && isAgent && !isAdmin;
          const showMute    = amAdmin && !isRinging && !isHungup &&             !isCustomer;

          const idAttrs = isAgent
            ? `data-id="${esc(p.deviceId)}"`
            : `data-callsid="${esc(p.callSid)}"`;

          let badge = "";
          if (isCustomer) badge = '<span class="pr-badge customer">CUSTOMER</span>';
          else if (isAdmin) badge = '<span class="pr-badge">ADMIN</span>';
          else if (isExternal) badge = '<span class="pr-badge external">PHONE</span>';

          let subText = "";
          if (isRinging)        subText = '<div class="pr-sub">Calling…</div>';
          else if (isHungup)    subText = '<div class="pr-sub hungup">Hung up</div>';
          else if (muted)       subText = '<div class="pr-sub muted">Muted</div>';

          // Row class encodes state for border/bg theming + pulse.
          const rowState = isHungup ? "hungup" : isRinging ? "ringing" : muted ? "muted" : "connected";
          return `
          <div class="participant-row state-${rowState}">
            <div class="pr-info">
              <div class="pr-dot ${dotClass}"></div>
              <div class="pr-meta">
                <div class="pr-name">${esc(p.label || "Device")}${isSelf ? " (you)" : ""}</div>
                ${subText}
              </div>
              ${badge}
            </div>
            <div class="pr-actions">
              ${showCancel  ? `<button class="btn-mini kick"    data-action="cancel"  ${idAttrs}>Cancel</button>` : ""}
              ${showRedial  ? `<button class="btn-mini redial"  data-action="redial"  ${idAttrs}>Redial</button>` : ""}
              ${showRemove  ? `<button class="btn-mini kick"    data-action="kick"    ${idAttrs}>Remove</button>` : ""}
              ${showPromote ? `<button class="btn-mini promote" data-action="promote" ${idAttrs}>Promote</button>` : ""}
              ${showMute    ? `<button class="btn-mini mute"    data-action="mute" data-muted="${muted ? "1" : "0"}" ${idAttrs}>${muted ? "Unmute" : "Mute"}</button>` : ""}
              ${showKick    ? `<button class="btn-mini kick"    data-action="kick"    ${idAttrs}>Kick</button>` : ""}
            </div>
          </div>`;
        }).join("")
      : '<div class="empty">No participants yet.</div>';
  }

  // ─── Event delegation for participant row actions ────────────
  participantList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const deviceId = btn.getAttribute("data-id");      // agents
    const callSid  = btn.getAttribute("data-callsid"); // externals / customer
    if (!action || (!deviceId && !callSid)) return;
    btn.disabled = true;

    try {
      if (action === "kick") {
        if (!confirm("Kick this participant from the group?")) { btn.disabled = false; return; }
        await apiFetch(`/phone-device/groups/${encodeURIComponent(groupName)}/kick`, {
          method: "POST",
          body: deviceId ? { deviceId } : { callSid },
        });
        toast("Participant removed", "success");
      } else if (action === "cancel") {
        // Cancel is a kick on a still-ringing participant. Same endpoint,
        // no confirm prompt (they haven't joined yet, nothing to disrupt).
        await apiFetch(`/phone-device/groups/${encodeURIComponent(groupName)}/kick`, {
          method: "POST",
          body: deviceId ? { deviceId } : { callSid },
        });
        toast("Call canceled", "info", 1500);
      } else if (action === "promote") {
        await apiFetch(`/phone-device/groups/${encodeURIComponent(groupName)}/promote`, {
          method: "POST",
          body: { deviceId },
        });
        toast("Admin role transferred", "success");
      } else if (action === "redial") {
        // Re-place an outbound call to a previously-hungup participant
        // (paired device or external number) into the same conference.
        await apiFetch(`/phone-device/groups/${encodeURIComponent(groupName)}/redial`, {
          method: "POST",
          body: deviceId ? { deviceId } : { callSid },
        });
        toast("Redialing…", "info", 1500);
      } else if (action === "mute") {
        const currentlyMuted = btn.getAttribute("data-muted") === "1";
        const nextMuted = !currentlyMuted;

        // Optimistic UI flip — button label switches immediately so the
        // user sees the result instead of waiting for the next 3s poll.
        // The server's refreshGroup below re-syncs either way.
        btn.setAttribute("data-muted", nextMuted ? "1" : "0");
        btn.textContent = nextMuted ? "Unmute" : "Mute";

        console.log(`[group] mute click target=${deviceId || callSid} → muted=${nextMuted}`);
        const res = await apiFetch(`/phone-device/groups/${encodeURIComponent(groupName)}/mute`, {
          method: "POST",
          body: {
            ...(deviceId ? { deviceId } : { callSid }),
            muted: nextMuted,
          },
        });
        console.log("[group] mute server response:", res);
        toast(nextMuted ? "Muted" : "Unmuted", "success", 1200);
      }
      refreshGroup();
    } catch (err) {
      btn.disabled = false;
      console.error(`[group] ${action} failed:`, err);
      toast(`${action} failed: ${err.message}`, "error");
      // Force a refresh so the UI re-syncs to actual server state after
      // a failure — otherwise an optimistic mute flip might lie.
      refreshGroup();
    }
  });

  // ─── Invite picker (tabs: paired device + contact + phone number) ──
  const inviteContactBody = document.getElementById("inviteContactBody");
  const inviteContactSearch = document.getElementById("inviteContactSearch");
  const inviteContactList = document.getElementById("inviteContactList");
  let _contactsCache = [];

  async function ensureContactsLoaded() {
    if (_contactsCache.length) return;
    try {
      const data = await apiFetch("/phone-device/contacts");
      _contactsCache = Array.isArray(data?.contacts) ? data.contacts : [];
    } catch (e) {
      console.warn("[group] contacts load failed:", e.message);
    }
  }

  function fmtPhoneCompact(raw) {
    const s = String(raw || "").replace(/[^\d+]/g, "");
    const us = s.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
    if (us) return `(${us[1]}) ${us[2]}-${us[3]}`;
    const bare = s.match(/^(\d{3})(\d{3})(\d{4})$/);
    if (bare) return `(${bare[1]}) ${bare[2]}-${bare[3]}`;
    return s || raw;
  }

  function renderInviteContactMatches(query) {
    if (!inviteContactList) return;
    const q = String(query || "").toLowerCase().trim();
    if (!q) {
      inviteContactList.innerHTML = '<div class="empty">Type a name or number to filter your contacts.</div>';
      return;
    }
    const matches = _contactsCache.filter((c) => {
      if (!c.phone && !c.phoneAlt) return false;
      if (c.name && c.name.toLowerCase().includes(q)) return true;
      if (c.phone && c.phone.includes(q)) return true;
      if (c.phoneAlt && c.phoneAlt.includes(q)) return true;
      return false;
    }).slice(0, 12);
    if (!matches.length) {
      inviteContactList.innerHTML = '<div class="empty">No matches.</div>';
      return;
    }
    inviteContactList.innerHTML = matches.map((c) => {
      const phone = c.phone || c.phoneAlt;
      return `
        <button type="button" class="gis-contact-row"
                data-phone="${esc(phone)}" data-name="${esc(c.name || "")}">
          <div class="gis-contact-name">${esc(c.name || "Contact")}</div>
          <div class="gis-contact-sub">${esc(fmtPhoneCompact(phone))}</div>
        </button>`;
    }).join("");
  }

  function switchInviteTab(tab) {
    modalTabs.forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === tab));
    inviteDeviceBody.hidden = tab !== "device";
    if (inviteContactBody) inviteContactBody.hidden = tab !== "contact";
    inviteNumberBody.hidden = tab !== "number";
    if (tab === "number") setTimeout(() => inviteNumberInput.focus(), 50);
    if (tab === "contact") {
      ensureContactsLoaded().then(() => {
        if (inviteContactSearch) {
          inviteContactSearch.value = "";
          renderInviteContactMatches("");
          setTimeout(() => inviteContactSearch.focus(), 50);
        }
      });
    }
  }
  modalTabs.forEach((t) => t.addEventListener("click", () => switchInviteTab(t.getAttribute("data-tab"))));

  // Filter as the admin types.
  if (inviteContactSearch) {
    let _icDeb = null;
    inviteContactSearch.addEventListener("input", () => {
      clearTimeout(_icDeb);
      _icDeb = setTimeout(() => renderInviteContactMatches(inviteContactSearch.value), 100);
    });
  }
  // Tap a contact row → fire invite-number with that phone.
  if (inviteContactList) {
    inviteContactList.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-phone]");
      if (!btn) return;
      const phone = btn.getAttribute("data-phone");
      const name = btn.getAttribute("data-name") || "";
      btn.disabled = true;
      try {
        await apiFetch(
          `/phone-device/groups/${encodeURIComponent(groupName)}/invite-number`,
          { method: "POST", body: { phoneNumber: phone, label: name || phone } }
        );
        toast(`Calling ${name || fmtPhoneCompact(phone)}`, "success");
        invitePicker.hidden = true;
        refreshGroup();
      } catch (err) {
        btn.disabled = false;
        toast(`Couldn't dial: ${err.message}`, "error");
      }
    });
  }

  btnInvite.addEventListener("click", async () => {
    if (btnInvite.disabled) return;
    invitePicker.hidden = false;
    switchInviteTab("device");
    // Reset number tab state.
    inviteNumberInput.value = "";
    inviteNumberStatus.textContent = "";
    inviteNumberStatus.className = "num-status";
    btnInviteNumber.disabled = false;
    // Load paired devices.
    inviteDeviceBody.innerHTML = '<div class="empty">Loading devices…</div>';
    try {
      const data = await apiFetch("/phone-device/peers");
      const peers = Array.isArray(data?.peers) ? data.peers : [];
      const currentIds = new Set(
        (currentSnapshot?.participants || [])
          .filter((p) => p.type === "agent")
          .map((p) => String(p.deviceId))
      );
      const available = peers.filter((p) => !currentIds.has(String(p._id)));
      if (!available.length) {
        inviteDeviceBody.innerHTML = '<div class="empty">No other paired devices available.</div>';
      } else {
        inviteDeviceBody.innerHTML = available.map((p) => `
          <button type="button" class="modal-device ${p.isOnline ? "online" : "offline"}"
                  data-peer-id="${esc(p._id)}" ${p.isOnline ? "" : "disabled"}>
            <div class="md-dot"></div>
            <div>
              <div class="md-name">${esc(p.label || p.hostname || "Device")}</div>
              <div class="md-sub">${p.isOnline ? "Online" : "Offline"}</div>
            </div>
          </button>
        `).join("");
      }
    } catch (e) {
      inviteDeviceBody.innerHTML = `<div class="empty">Couldn't load: ${esc(e.message)}</div>`;
    }
  });

  inviteDeviceBody.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-peer-id]");
    if (!btn || btn.disabled) return;
    const deviceId = btn.getAttribute("data-peer-id");
    inviteDeviceBody.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      await apiFetch(`/phone-device/groups/${encodeURIComponent(groupName)}/invite`, {
        method: "POST",
        body: { deviceId },
      });
      toast("Invitation sent — their phone is ringing", "success");
      invitePicker.hidden = true;
      refreshGroup();
    } catch (err) {
      inviteDeviceBody.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      toast(`Invite failed: ${err.message}`, "error");
    }
  });

  // Phone-number tab — dial an external E.164 number.
  btnInviteNumber.addEventListener("click", async () => {
    const raw = (inviteNumberInput.value || "").trim();
    // Client-side sanity check; server enforces more rigorously.
    const digits = raw.replace(/[^\d+]/g, "");
    if (!digits || digits.replace(/\D/g, "").length < 10) {
      inviteNumberStatus.textContent = "Enter a valid phone number (include country code).";
      inviteNumberStatus.className = "num-status error";
      return;
    }
    btnInviteNumber.disabled = true;
    inviteNumberStatus.textContent = "Dialing…";
    inviteNumberStatus.className = "num-status";
    try {
      await apiFetch(
        `/phone-device/groups/${encodeURIComponent(groupName)}/invite-number`,
        { method: "POST", body: { phoneNumber: digits } }
      );
      inviteNumberStatus.textContent = "Calling now — they'll join as soon as they answer.";
      inviteNumberStatus.className = "num-status success";
      toast("Calling external number", "success");
      setTimeout(() => { invitePicker.hidden = true; }, 1000);
      refreshGroup();
    } catch (err) {
      inviteNumberStatus.textContent = `Couldn't dial: ${err.message}`;
      inviteNumberStatus.className = "num-status error";
      btnInviteNumber.disabled = false;
    }
  });

  // Enter key in the number field triggers the call.
  inviteNumberInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !btnInviteNumber.disabled) btnInviteNumber.click();
  });

  btnInviteClose.addEventListener("click", () => { invitePicker.hidden = true; });
  invitePicker.addEventListener("click", (e) => {
    if (e.target === invitePicker) invitePicker.hidden = true;
  });

  // ─── Leave flow ──────────────────────────────────────────────
  async function doLeave(nextAdminDeviceId) {
    leaving = true;
    try {
      await apiFetch(`/phone-device/groups/${encodeURIComponent(groupName)}/leave`, {
        method: "POST",
        body: nextAdminDeviceId ? { nextAdminDeviceId } : {},
      });
      toast("You've left the group", "success", 1500);
      setTimeout(() => window.jobcountPhone.closeGroupWindow(), 400);
    } catch (err) {
      leaving = false;
      // 400 with candidates means we must pick a successor.
      if (err.status === 400 && /nextAdminDeviceId/i.test(err.message)) {
        showSuccessorPicker();
      } else {
        toast(`Leave failed: ${err.message}`, "error");
      }
    }
  }

  function showSuccessorPicker() {
    if (!currentSnapshot) return;
    const candidates = currentSnapshot.participants.filter(
      (p) => String(p.deviceId) !== String(selfDeviceId)
    );
    successorPickerBody.innerHTML = candidates.map((p) => `
      <button type="button" class="modal-device ${p.online ? "online" : "offline"}"
              data-succ-id="${esc(p.deviceId)}">
        <div class="md-dot"></div>
        <div>
          <div class="md-name">${esc(p.label || "Device")}</div>
          <div class="md-sub">${p.online ? "Online" : "Offline"}${p.role === "admin" ? " · current admin" : ""}</div>
        </div>
      </button>
    `).join("");
    successorPicker.hidden = false;
  }

  successorPickerBody.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-succ-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-succ-id");
    successorPicker.hidden = true;
    await doLeave(id);
  });

  btnSuccessorCancel.addEventListener("click", () => { successorPicker.hidden = true; });

  btnLeave.addEventListener("click", async () => {
    if (leaving) return;
    if (!confirm("Leave the group call?")) return;
    await doLeave();
  });

  // Close button = leave then close.
  btnCloseWindow.addEventListener("click", async () => {
    if (leaving) { window.jobcountPhone.closeGroupWindow(); return; }
    if (!confirm("Close this window? You'll leave the group call.")) return;
    await doLeave();
  });

  // Kick off.
  boot().catch((e) => {
    console.error("group boot failed:", e);
    participantList.innerHTML = `<div class="empty">Boot failed: ${esc(e.message)}</div>`;
  });
})();
