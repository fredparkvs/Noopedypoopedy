# Noo-Psyche K7 protocol

Decoded from the official Android app `com.nemo.caideng` version 2.0.3
(`noo_release_203.apk`). Everything below is what that app sends and reads.
Items marked *inferred* are not used by the official app and are worth
confirming against a real light (the new app's Diagnostics screen shows the raw
bytes).

## Transport

* The light has an ESP8266 WiFi module.
* It listens on **TCP port 8266**. One plain TCP connection, no TLS, no login.
* The ESP8266 typically accepts only one client at a time, so close the
  official app before using another one.
* Two network modes:
  * **LAN mode:** the light joins your home WiFi (2.4 GHz only). The official
    app provisions it with Espressif **EspTouch v1** (SmartConfig) and gets the
    light's IP back from the EspTouch result.
  * **AP mode:** the light runs its own hotspot named `K7_xxxxxxxx` (or
    `K7M...` for the K7 Mini). The phone joins it and the light is the DHCP
    server / gateway.
* The official app also contains a WeChat AirKiss provisioning screen
  (UDP broadcast to port 10000, listens on 24333). It is not reachable from
  the app's menus.

## Frames

All commands:

```
AA A5 10 <cmd> <payload...> BB
```

| cmd  | name                | payload                                   |
|------|---------------------|-------------------------------------------|
| `03` | sync clock          | `hh mm ss` (24h, local time)              |
| `04` | auto / manual       | `01` run schedule, `00` manual            |
| `05` | manual brightness   | 6 channel bytes, applied immediately      |
| `06` | preview             | 6 channel bytes, temporary preview        |
| `07` | save everything     | see below                                 |
| `08` | read everything     | none                                      |
| `09` | (password set)      | defined in the app but never sent         |
| `0A` | demo mode           | `00` start, `01` stop (inverted)          |

Channel bytes are percentages, `00`-`64` (0-100). A frame always carries six
channel bytes; 3-channel lights (K7 Mini) send zeros for channels 4-6.

### `07` save everything (208 bytes total)

```
AA A5 10 07
  m1 m2 m3 m4 m5 m6        manual-mode brightness
  18                       slot count (24)
  24 x [ hh mm c1 c2 c3 c4 c5 c6 ]
  aa                       01 = auto (schedule) mode, 00 = manual
  hh mm ss                 current time, sets the light's clock
BB
```

The official app always sends 24 slots with slot *i* at hour *i* (the hour
wheel is locked; only the minute can change). The chart in the official app
draws straight lines between slots and wraps from the last slot to the first
across midnight, so the light is expected to fade linearly between slots.

### Example frames

```
read all            aa a5 10 08 bb
sync 13:05:09       aa a5 10 03 0d 05 09 bb
schedule mode on    aa a5 10 04 01 bb
all channels 50%    aa a5 10 05 32 32 32 32 32 32 bb
```

## Replies

* `AB AA A5 A1`: acknowledgement after a command. The official app ignores it.
* Status block, sent after `08`: starts with `AB AA` and is **longer than 214
  bytes**.

| offset   | meaning                                                         |
|----------|-----------------------------------------------------------------|
| 0-1      | `AB AA`                                                         |
| 203      | `01` = auto (schedule) mode, otherwise manual  *(used by app)*  |
| 204-214  | device name, ASCII, e.g. `K7_1A2B3C4D` / `K7M...` *(used by app)* |
| 4-9      | manual brightness *(inferred, mirrors the `07` layout)*         |
| 10       | slot count `18` *(inferred)*                                    |
| 11-202   | 24 schedule slots *(inferred)*                                  |

The official app reads only byte 203 and the name. It **never reads the
schedule back from the light**: it keeps its own copy on the phone, keyed by
WiFi network name, light type and preset. That is why a reinstall, a new phone
or a renamed WiFi network shows the factory defaults instead of what the light
is actually running. The new app reads offsets 4-202 when they pass a sanity
check (hours 0-23, minutes 0-59, values 0-100) and falls back to its own saved
copy otherwise.

The app treats a reply of 214 bytes or fewer to `08` as a failed read.

## Light types

| name prefix | model      | channels                                    |
|-------------|------------|---------------------------------------------|
| `K7_`       | K7 / K7 Pro | 1 White, 2 Blue, 3 Green, 4 UV, 5 Cyan, 6 Red |
| `K7M`       | K7 Mini    | 1 White, 2 Blue, 3 UV                       |

Channel colours used by the official app: `#DBD8D9`, `#0055A5`, `#008F4D`,
`#88226E`, `#1FB5F8`, `#EB3D08` (Mini: `#DBD8D9`, `#0055A5`, `#88226E`).

## Official export / QR format

The official app exports a QR code whose text is:

```
<6 manual bytes as hex>#<24 slots x 8 bytes as hex>
```

e.g. `323232323232#0000000000000000 0100000000000000 ...` (no spaces). The new
app can import and export this text.

## Factory presets (K7)

Hours 0-8 and 21-23 are 0. Values are channels 1-6.

| hour | SPS | LPS | Soft coral |
|------|-----|-----|------------|
| 9    | 30 x6 | 0 10 0 3 10 0 | 5 20 20 20 20 0 |
| 10   | 50 x6 | 1 30 20 5 30 0 | 10 40 40 40 40 5 |
| 11-18 | 95 x6 | 5 80 50 10 80 0 | 30 90 90 70 90 20 |
| 19   | 50 x6 | 1 30 20 5 30 0 | 10 40 40 40 40 5 |
| 20   | 30 x6 | 0 10 0 3 10 0 | 5 20 20 20 20 0 |

Manual default: 50% on every channel.
