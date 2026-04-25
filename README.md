# JobCount Phone

Desktop softphone that turns any PC (Windows / Mac / Linux) into a phone
endpoint for a JobCount Automotive shop. Run it on as many machines as
you want — front desk, service writer, bay tablet, manager's office —
and every inbound call rings them all in parallel.

---

## TL;DR pairing

1. In JobCount's web UI, open the shop's **Phone** page.
2. On the **Paired Devices** panel, click **Pair**.
3. Click **Copy Pairing Info**.
4. In this app, paste the copied info into the "Pairing Info" box.
5. Click **Pair Device**.

No URL typing. No code typing. One click + one paste.

---

## Dev vs Production

The app doesn't care which server it's pairing with — the server URL lives
inside the pairing payload, so pairing against your dev ngrok URL lands
you on the dev server; pairing against prod lands you on prod. The same
binary works for both.

### Dev loop on your workstation

You need JobCount running locally (via `npm run dev:twilio` in the
`jobcount` repo, which also starts ngrok). Then, in this repo:

```powershell
npm install
npm run dev
```

That starts Electron with `JOBCOUNT_ENV=dev` so a yellow **DEV** ribbon
appears in the corner of the window — easy reminder you're pointing at
a staging tunnel.

Workflow:
1. Start ngrok + JobCount (`npm run dev:twilio` in the `jobcount` repo).
2. Start this app (`npm run dev`).
3. In the app, click **Unpair** if already paired against prod.
4. In your browser, open the dev JobCount → Phone page → Pair → Copy.
5. Paste into the desktop app. Done.

### Production deployment

```powershell
npm install
npm run build          # Windows installer + portable EXE in dist/
```

Give the installer to any shop PC. The installed shortcut runs
`npm start` (no dev flag) so no DEV ribbon shows. User pairs against
your production JobCount URL and calls start flowing.

### Switching a device between dev and prod

Click **Settings** (gear icon in the top bar) → **Unpair this device**.
Then pair again using the target environment's pairing info. Token is
cleared and a fresh one is minted against the new server.

---

## Architecture

```
┌──────────────────────────────┐           ┌────────────────────────┐
│  JobCount Phone (Electron)   │           │  JobCount server       │
│                              │           │                        │
│  main.js ─ safeStorage ───   │           │  /phone-pair/redeem    │
│     │                        │ HTTPS     │  /phone-device/*       │
│     └─► BrowserWindow ───────┼──────────►│  socket.io /phone-live │
│          (Twilio Voice SDK)  │           │                        │
│                              │           │  Twilio Voice webhooks │
└──────────────────────────────┘           └────────────────────────┘
                      ▲
                      │ Twilio WebRTC (audio)
                      ▼
                  Twilio Cloud
```

- **main.js** owns the device token (stored encrypted in OS keychain via
  `safeStorage`), the system tray, and every network request. No HTTP
  comes from the renderer — avoids CORS on `file://` origin.
- **preload.js** exposes a tiny typed bridge (`window.jobcountPhone`).
- **renderer/app.js** is the softphone state machine. Twilio Voice SDK
  runs here alongside the call UI.

---

## Troubleshooting

### "Failed fetch" on pairing
Fixed in 0.1.1 — pairing requests now run from the main process so `file://`
CORS doesn't apply. If you see this, make sure you're running a recent
build of the app.

### Code is accepted but no Online badge
Check that JobCount's server is still reachable from this PC — open the
Server URL shown under Advanced in your browser. If ngrok restarted, its
URL may have changed; press **Sync** in JobCount's phone console, then
re-pair.

### USB phone / headset not heard
Open **Settings** (gear icon) → pick the right microphone and speaker
from the dropdowns. Yealink, Jabra, Plantronics USB phones all show up as
normal audio devices.

### Token expired / device revoked
The app will show "Offline" in the top bar. Click **Settings → Unpair**
and repair. (A manager may have revoked this device from the JobCount UI.)

---

## Packaging notes

- Windows binary signing: unsigned EXEs show a SmartScreen warning on
  first run. Grab a code-signing cert (~$100/yr) and add `certificateFile`
  + `certificatePassword` to the `win` block in `package.json`.
- App icon: drop `icon.ico` / `icon.icns` / `icon.png` in `assets/` before
  building. Until then, the OS default icon is used. See
  `assets/README-ICONS.md` for ImageMagick commands.
