# Reef Light

A simpler Android app for **Noo-Psyche K7** reef lights (K7 Pro, K7, K7 Mini).
It replaces the official "Noo-Psyche" app and talks to the light directly over
your WiFi. No account, no cloud, nothing sent to the internet.

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

1. Download `ReefLight-1.0.1.apk` to your phone (from the chat, or from the
   **Actions** tab of this repository: open the latest run and download the
   `ReefLight-apk` artifact).
2. Open it. Android will ask you to allow installs from that source (your
   browser or file manager). Allow it, then tap **Install**.
3. **Close the official Noo-Psyche app** (swipe it away). The light accepts one
   connection at a time.
4. Open **Reef Light**. It searches your WiFi and lists the lights it finds.
   Tap **Use**.

Your phone must be on the same WiFi as the light, or connected to the light's
own `K7_...` hotspot.

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

**Manual tab.** Moving any slider switches the light to manual and applies
instantly. **Run schedule** switches back. **Save to light** also stores your
manual mix on the light, so it survives a power cut.

**Lights & backup tab.** Switch between lights, put a new light on WiFi,
save or restore a backup file, rename channels, and see diagnostics (the raw
bytes the light sent, useful if something looks wrong).

Channels on the K7 Pro, in order: White, Blue (royal blue), Green, UV, Cyan,
Red. The K7 Mini has White, Blue, UV. You can rename them.

## Troubleshooting

* **Light not found:** make sure the official app is fully closed, and that the
  phone is on 2.4 GHz WiFi with the light (or on the light's hotspot). Then tap
  **Search the network**. You can also type the light's IP address (your
  router's device list shows it).
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
    js/transport.js          native bridge, demo light, connection handling
    js/app.js                screens
  app/src/main/java/...      LightConnection (TCP), NetScanner, LightBridge, MainActivity
  app/src/test/...           socket tests against a fake light
docs/PROTOCOL.md             the decoded protocol
tests/                       Node and Playwright tests
```

Opening `android/app/src/main/assets/www/index.html` in a desktop browser runs
the app against a simulated light (demo mode).

```
node --test tests/*.test.js
npm install && npx playwright install chromium && npm run test:e2e
cd android && ./gradlew testDebugUnitTest assembleDebug
```

The APK is signed with `android/app/reeflight-sideload.keystore` so that every
build, local or CI, can update the installed app in place. It is only for this
sideloaded app.

Not affiliated with Noo-Psyche.
