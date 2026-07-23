# FloorSense ESP32 AP node firmware

**This firmware has not been compiled or tested on real hardware.**
This development environment has no ESP32 board, no Arduino IDE, no
`arduino-cli`, `platformio`, or ESP-IDF toolchain - every check that
was possible here was performed (the JSON field names/shapes this
firmware sends were verified character-for-character against the
real, automated-test-covered backend endpoints they call), but
compiling and flashing onto real hardware is the actual verification
step, and it's yours to run. Please report back anything that doesn't
compile or doesn't behave as described - the API names most likely to
have shifted between Arduino-ESP32 core versions are called out below.

## What this does

Turns an ESP32 into one AP node for a FloorSense venue: it broadcasts
an open WiFi network, redirects joining devices to this project's
existing consent page (`packages/captive-portal`), and reports
join/leave/signal-strength events to the FloorSense backend
(`packages/owner-portal`)'s `POST /hardware/events` endpoint.

You'll need a real FloorSense backend and captive-portal server
already running somewhere reachable on the same network (a laptop or
Raspberry Pi). This firmware is the AP node; it is not a replacement
for those. **Do this part first, before touching the ESP32** - the
main `README.md`'s "Testing with a real ESP32" section has the exact
commands, summarized here:

1. Start the owner-portal server (repo root: see the main README's
   "Try the owner dashboard" command) on a LAN-reachable address.
2. On its dashboard: register, create a venue, add an AP node.
3. Get that venue's `id` and `hardwareToken` from `GET /venues`.
4. Start the REAL captive-portal server for that venue (not the demo
   scripts in `packages/captive-portal/src/*Demo.ts` - those use an
   in-memory database and won't share data with the dashboard):
   ```bash
   node packages/captive-portal/src/startRealServer.ts <venueId>
   ```
   This exits with a clear error if `<venueId>` doesn't exist, rather
   than starting a broken server silently.

Only once both of those are running and you have the venue's real
`id`/`hardwareToken` should you move on to configuring and flashing
the ESP32 below.

## Requirements

- An ESP32 board (any variant with WiFi - this uses only SoftAP + the
  standard Arduino WiFi/WebServer/HTTPClient libraries, nothing
  board-specific).
- Arduino IDE with the **esp32** board package installed (Boards
  Manager -> search "esp32" -> install the espressif package). This
  firmware was written against the current stable Arduino-ESP32 core
  (2.x). No third-party libraries needed - `WiFi.h`, `DNSServer.h`,
  `WebServer.h`, `HTTPClient.h`, and `esp_wifi.h` all ship with the
  board package.

## Before flashing: edit the configuration block

Open `esp32_ap_node.ino` and edit the constants at the top:

| Constant | What it is | Where to find it |
|---|---|---|
| `AP_SSID` | The WiFi network name visitors will see and join | Your choice |
| `AP_PASSWORD` | Leave `""` for an open network | Your choice |
| `BACKEND_URL` | Where `@floorsense/owner-portal`'s server is running | e.g. `http://192.168.4.2:3000` - the LAN IP of the machine running it |
| `CONSENT_PORTAL_URL` | Where `@floorsense/captive-portal`'s server is running | e.g. `http://192.168.4.2:3001` |
| `VENUE_ID` | The venue this AP node belongs to | `GET /venues` while logged in as that venue's owner - the `id` field |
| `HARDWARE_TOKEN` | Authenticates this AP node's events, and is the salt device MACs are hashed with | Same `GET /venues` response - the `hardwareToken` field |
| `AP_NODE_ID` | Which AP node this is | Must already exist for the venue - create it first on the owner dashboard ("Add AP node"), matching its `apNodeId` |

`HARDWARE_TOKEN` is a real secret: anyone with it can inject fake
presence events for this venue and can correlate that venue's hashed
device IDs. Don't commit a filled-in copy of this file to a public
repo - keep your edited `.ino` local, or use a private fork.

## Flashing

1. Arduino IDE -> Tools -> Board -> pick your specific ESP32 board.
2. Tools -> Port -> pick the ESP32's serial port.
3. Upload.
4. Open the Serial Monitor (115200 baud) - on success you'll see
   `FloorSense AP node ready.` and the SoftAP's IP address.

## Testing it

1. Join the `AP_SSID` network from a phone or laptop.
2. Your device's OS should automatically open a captive-portal
   browser/webview pointed at the consent page. If it doesn't, open
   `http://192.168.4.1/generate_204` manually - the redirect happens
   from there.
3. Accept consent on that page (this is `packages/captive-portal`'s
   existing, unmodified page).
4. Within `SIGNAL_READING_INTERVAL_MS` (5 seconds by default), the
   owner dashboard's heatmap/stats for this venue should start
   reflecting the connected device - check the Serial Monitor for
   `Hardware event rejected: ...` lines if it doesn't (usually a wrong
   `VENUE_ID`/`HARDWARE_TOKEN`, or the device hasn't completed consent
   yet - events are silently rejected with `no_consent` until it has).

## Known limitations (real ones, not hedging)

- **API name drift across Arduino-ESP32 core versions.** This firmware
  uses `ARDUINO_EVENT_WIFI_AP_STACONNECTED`/`_STADISCONNECTED` (current
  core). Older core versions used `SYSTEM_EVENT_AP_STACONNECTED`/
  `_STADISCONNECTED` instead. If the sketch fails to compile on the
  event names, check your installed core version and rename those two
  identifiers.
- **Captive-portal redirect MAC lookup.** The Arduino `WebServer` API
  gives you the requester's IP, not its MAC, and there's no simple
  Arduino-level way to cross-reference the DHCP lease table. This
  firmware uses the first entry in the AP's station list, which is
  correct when one device is mid-onboarding at a time (the normal
  case: one visitor joins, sees the consent page, accepts). If two
  devices are simultaneously mid-redirect before either has completed
  consent, this simple approach can attach the wrong MAC to that
  particular redirect. A more robust version would need lower-level
  ESP-IDF DHCP-lease APIs, intentionally left out here to keep this
  firmware within the well-documented, stable Arduino WiFi library
  surface (see `docs/positioning-accuracy.md` and
  `docs/architecture.md`'s "Real hardware ingestion" section for the
  rest of the system this firmware feeds).
- **No promiscuous-mode sniffing.** This ESP32 only sees devices
  associated with ITS OWN SoftAP, not other AP nodes' traffic. For
  multiple AP nodes in one venue, flash each with the same venue's
  `VENUE_ID`/`HARDWARE_TOKEN` and its own distinct `AP_NODE_ID`.
