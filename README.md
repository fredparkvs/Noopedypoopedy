# Reef Light

A simpler app for **Noo-Psyche K7** reef lights (K7 Pro, K7, K7 Mini), for
**Android** and the **Mac**. It replaces the official "Noo-Psyche" app and
talks to the light directly over your WiFi. No account, no cloud, nothing sent
to the internet.

Built by decoding the official app (`noo_release_203.apk`). The protocol is
written up in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## What is different from the official app

| Official app | Reef Light |
|---|---|
| You edit 24 fixed hourly slots in small dialogs | You edit a handful of key points (sunrise, peak, sunset) on a chart. The app turns them into the light's 24 slots for you |
| Never reads the schedule back from the light; keeps its own copy on the phone, keyed by WiFi name, so a new phone or reinstall shows factory defaults | Reads the schedule from the light every time it connects, and checks it after each save ("The light confirmed the new settings") |
| Remembers the light by IP address | Remembers the light by its own name (`K7_xxxxxxxx`) and finds it again if the router gives it a new address |
| Connection fails silently | Clear status, automatic reconnect, searches the network for you, works on the light's own K7 hotspot too |
| Asks for camera, phone, storage and location access | Location only, and only when you set a light up on WiFi (Android requires it to read the WiFi name) |
| Manual mode: six sliders | Six sliders, plus an "All" slider that dims everything but keeps your mix, plus saved scenes |
| QR code export to the photo gallery | Backup file you can keep anywhere, plus import and export of the official app's QR code text |

## Install

1. Download `ReefLight-1.1.0.apk` to your phone (from the chat, or from the
   **Actions** tab of this repository: open the latest run and download the
   `ReefLight-apk` artifact).
2. Open it. Android will ask you to allow installs from that source (your
   browser or file manager). Allow it, then tap **Install**.
3. **Force-stop the official Noo-Psyche app** (Settings, Apps, Noo-Psyche,
   Force stop). Swiping it away is not enough: it keeps its connection open,
   and the light talks to one app at a time.
4. Connect your phone to the light, the same way you do for the official app
   (see below), then open **Reef Light**.

### On a Mac

1. Download the zip for your Mac: `ReefLight-1.1.0-mac-arm64.zip` for Apple
   silicon (M1, M2, M3, M4; Apple menu, About This Mac, "Chip"), or
   `ReefLight-1.1.0-mac-x64.zip` for an Intel Mac.
2. Double-click the zip and drag **Reef Light** into **Applications**.
3. The app is not signed with a paid Apple developer certificate, so macOS
   blocks it at first. Open **Terminal** and paste this once; it tells your Mac
   to trust this copy of the app:

   ```
   xattr -cr "/Applications/Reef Light.app" && codesign --force --deep --sign - "/Applications/Reef Light.app"
   ```

4. Open **Reef Light** from Applications. Force-stop the official app on your
   phone first if it is open (the light talks to one app at a time).

The Mac app has the same screens as the Android app. Differences:

* It keeps running in the **menu bar** when you close the window, so the
  natural cycle's daily updates continue. Its menu has **Open at login** and
  **Quit Reef Light**.
* **Put a light on WiFi** needs the Android app (it uses the phone's WiFi radio
  to send the light your WiFi details). Everything else works on the Mac.
* For the Mac to reach the light, the Mac must be on the light's hotspot or the
  light must be on the same WiFi as the Mac. A Mac that stays on your home WiFi
  works best with the light on your home WiFi too.

### Two ways to reach the light

* **The light's own hotspot** (the official app's "AP connection"): in your
  phone's WiFi settings, join the network named `K7_` plus some letters and
  numbers. Reef Light goes straight to the light and connects without you
  tapping anything. Android may warn that this network has no internet; that
  is expected, stay connected.
* **Your home WiFi** (the official app's "LAN connection"): put the light on
  your home WiFi once with **Put a light on WiFi**. After that the phone stays
  on your normal WiFi and Reef Light searches the network for the light.

### How to tell it is talking to your actual light

* The name at the top changes from an address (like `192.168.4.1`) to the
  light's own name (like `K7_1A2B3C4D`). That name comes from the light's
  reply, and it is the same name as its hotspot.
* **Lights & backup, This light** shows *Identity: Confirmed* in green once the
  light has answered, and whether you are connected through its hotspot.
* **Blink the light** makes the light go dark twice and then puts it back
  exactly as it was.

## Using it

**Schedule tab.** The chart shows each channel across the day, with a dashed
line at the current time and bars underneath showing what the light is doing
now. Tap a point (on the chart or in the list) to change its time or
brightness; with "Show on the light while I edit" ticked, the light previews
your change live. Tap an empty part of the chart to add a point. Changes stay
on the phone until you tap **Save to light**.

* **Quick setup** builds a whole day from four answers: sunrise start, dark by,
  ramp lengths, and peak brightness per channel (plus optional moonlight).
* **Presets** has the factory SPS, LPS and Soft coral schedules, and lets you
  save your own.
* One rule comes from the light itself: it stores one point per clock hour, so
  you cannot put two points in the same hour (the app tells you if you try).

**Natural cycle** (Schedule tab). Runs the light on a real reef's sunrise,
sunset, seasons and moon, recalculated every day, following the coral
spawning research of the Horniman Museum's Project Coral (Craggs et al. 2017)
and the moonrise studies after it. Pick a reef (Singapore, the Great Barrier
Reef or Palau, or any latitude and longitude), set when midday should fall on
your tank, and the app does the rest, including the dark gap between sunset
and moonrise on the nights after a full moon that triggers spawning. A
calendar shows the next five weeks of nights. Details, references and limits:
[docs/NATURAL_CYCLE.md](docs/NATURAL_CYCLE.md).

**Manual tab.** Moving any slider switches the light to manual and applies
instantly. **Run schedule** switches back. **Save to light** also stores your
manual mix on the light, so it survives a power cut.

**Lights & backup tab.** Switch between lights, put a new light on WiFi,
save or restore a backup file, rename channels, and see diagnostics (the raw
bytes the light sent, useful if something looks wrong).

Channels on the K7 Pro, in order: White, Blue (royal blue), Green, UV, Cyan,
Red. The K7 Mini has White, Blue, UV. You can rename them.

## Troubleshooting

* **"A VPN is switched on":** Android sends the app's traffic into the VPN, so
  it never reaches the light. Turn the VPN off while you adjust the light, or
  in the VPN app exclude Reef Light (split tunnelling) or allow LAN
  connections. ProtonVPN, for example, has both options.
* **Light not found:** make sure the official app is force-stopped, and that
  the phone is joined to the light's `K7_...` hotspot (or the light is on your
  home WiFi). Then tap **Search the network**. Devices that accept a
  connection but do not answer like a light are never offered as lights.
* **"Refused the connection":** another phone or the official app is connected
  to the light.
* **Status block not readable** (Lights & backup tab, Diagnostics): the app
  could not decode the schedule from the light and is showing the copy saved
  on this phone. Saving still works. Please send me the hex shown there.

## Status

* Built and tested against a simulated light that speaks the same protocol
  (protocol tests, browser UI tests, native socket tests). It has **not yet
  been run against a real K7**. Every command is byte-for-byte what the
  official app sends.
* Reading the schedule back assumes the light's status reply uses the same
  layout as the save command. The official app only ever reads two fields of
  that reply, so this is the main thing to confirm on a real light. If it does
  not match, the app falls back to the copy saved on the phone and says so.

## For developers

```
android/                     Android project (Kotlin shell + WebView UI)
  app/src/main/assets/www/   the app UI: plain HTML, CSS and JavaScript
    js/protocol.js           frames, parser, stream reassembly
    js/schedule.js           key points <-> 24 device slots, presets
    js/astro.js              sun and moon positions, phase (checked against PyEphem)
    js/natural.js            natural cycle: daily curve and best 24-point fit
    js/transport.js          native bridge, demo light, connection handling
    js/app.js                screens
  app/src/main/java/...      LightConnection (TCP), NetScanner, LightBridge, MainActivity
  app/src/test/...           socket tests against a fake light
desktop/                     Mac app (Electron) using the same interface
  core.js                    TCP connection, network search, daily updates (plain Node)
  main.js, preload.js        window, menu bar, bridge to the interface
  scripts/build-mac.sh       builds the Apple silicon and Intel apps
docs/PROTOCOL.md             the decoded protocol
docs/NATURAL_CYCLE.md        the natural cycle model and its research
tests/                       Node and Playwright tests
```

Opening `android/app/src/main/assets/www/index.html` in a desktop browser runs
the app against a simulated light (demo mode).

```
node --test tests/*.test.js
npm install && npx playwright install chromium && npm run test:e2e
cd android && ./gradlew testDebugUnitTest assembleDebug
cd desktop && npm install && npm test && ./scripts/sync-www.sh && xvfb-run -a node test/app.e2e.js
cd desktop && ./scripts/build-mac.sh
```

The APK is signed with `android/app/reeflight-sideload.keystore` so that every
build, local or CI, can update the installed app in place. It is only for this
sideloaded app.

Not affiliated with Noo-Psyche.
