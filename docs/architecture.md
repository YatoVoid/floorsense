# FloorSense architecture

## What this is

A consent-based WiFi presence analytics system for physical venues
(restaurants, cafes). Visitors connect to an on-site open WiFi network.
A captive portal shows a consent splash page before granting internet
access, and that's where consent lives. Once connected, the venue's
access point(s) observe signal strength from the joined device, and the
system builds seating heatmaps, dwell-time stats, and return-visit
tracking for the business owner.

## Locked invariants (non-negotiable, apply to every part of this codebase)

1. **Consent-first only.** A device only ever appears in this system
   because it joined the venue's WiFi network and passed through the
   consent splash page. There is no passive-sniffing code path anywhere
   in this repo, and none should ever be added.
2. **No raw device identifiers, ever.** A device's real MAC address is
   salted+hashed at the point of capture, in one shared, non-bypassable
   code path (`@floorsense/shared`'s hashing utility). No raw MAC is ever
   stored, logged, or transmitted beyond that single point.
3. **Multi-tenant from day one.** Every business owner's data is isolated
   from every other owner's. There is no code path that reads across
   tenants.

## Tech stack

**Node.js + TypeScript**, using Node's built-in `node:sqlite` module for
local persistence (no native-module dependency) and Node's native
TypeScript execution (no build step, `.ts` files run directly via `node`).

Why Node/TS:
- The core domain (AP join/leave/signal events, real-time presence, a
  network-facing captive-portal server) is event-driven and I/O-bound, a
  strong fit for Node's async model.
- The eventual real deployment swaps the simulated AP adapter for one
  that talks to hostapd/dnsmasq and real ESP32-based AP nodes. Keeping
  the adapter and the backend in one language avoids type drift across
  that boundary.
- `node:sqlite` skips the native-module dependency `better-sqlite3`
  would need (prebuilt binaries or a working toolchain). Verified
  present and working on this project's Node version (26.4.0+).

Python (FastAPI/SQLAlchemy + numpy/scipy) was considered for the
trilateration/calibration math, but the event pipeline and
network-facing pieces are the bigger share of this system's code, and
splitting across two languages this early wasn't worth the coordination
cost. A small Python microservice just for calibration math is still a
clean option later if Node's numeric tooling ever falls short.

## Package layout

- `packages/shared`: cross-package types (`ApEvent` and friends) and
  the device-hashing utility every identifier passes through.
- `packages/ap-adapter-sim`: simulates a WiFi access point's presence
  events (join/leave/signal readings) for local development and demos.
  The intended swap point for a real hostapd-backed adapter later.
- `packages/positioning`: RSSI-to-position math: trilateration from 3+
  AP nodes, weighted-centroid fallback for 1-2.
- `packages/backend`: SQLite persistence, multi-tenant data model,
  consent gating, calibration fitting, session/dwell-time
  reconstruction, heatmap generation, subscription tiers, and
  simulated billing (signup + monthly transactions).
- `packages/captive-portal`: the device-facing HTTP server: the
  consent splash page and the accept endpoint a joining device hits.
- `packages/owner-portal`: the owner-facing HTTP server: login,
  registration, the dashboard page, and the venue/heatmap/stats/
  calibration API.

## Local-first now, distributed later

Everything here runs on a single machine: the simulated adapter, the
backend, and the owner-facing web app. Two places are meant as swap
points for a real deployment: the AP adapter (simulated now, hostapd/
ESP32-backed later) and the persistence layer (local SQLite now, a
remote database later). Everything else should carry over unchanged.

## Real hardware ingestion

`POST /hardware/events` (owner-portal) is the real swap point that
exists today: any AP node reports join/leave/signal_reading events
over plain HTTP, authenticated by a random per-venue `hardwareToken`
generated at venue creation. That same token is used
as the salt for hashing the device's raw MAC server-side, immediately,
never storing or logging the raw value (invariant #2 above still
holds - hardware never sees or computes the hash itself). Rotating a
venue's token resets return-visit continuity for that venue, since the
hash changes; there's no separate rotation endpoint today.

Real ESP32 AP-node firmware implementing this contract lives in
`firmware/esp32-ap-node/` (Arduino, outside the npm workspaces since
it targets different hardware entirely). It has not been compiled or
hardware-tested in this development environment - see its own README.

See `docs/positioning-accuracy.md` for what accuracy to realistically
expect from the calibration/trilateration this hardware feeds.

## Randomized MAC addresses

Modern iOS (14+) and Android (10+) devices don't present their real,
permanent MAC address to a WiFi network by default - they generate a
**randomized MAC per network** instead. The important detail: this
randomization is *persistent per network*, not per connection attempt.
The same phone presents a different random MAC to two different
venues' WiFi, but the SAME random MAC every time it reconnects to one
specific venue's WiFi - which is exactly the stability return-visit
tracking needs.

This system never had to special-case this. `hashDeviceId` (and every
consumer of it - the consent flow, `POST /hardware/events`) treats
whatever identifier a device presents at consent/association time as
an opaque string: no MAC-format validation, no assumption that it's a
device's one "real," globally-fixed address. Whatever MAC a device
happens to show up with, hashed with this venue's salt, becomes its
stable identifier for this venue - whether that MAC is
factory-permanent or per-network-randomized makes no difference to the
hashing, consent-gating, or return-visit logic.

The other kind of MAC randomization - rotating per *probe request*
during passive WiFi scanning, before a device ever joins anything - is
architecturally irrelevant here, not because it's been specifically
handled, but because invariant #1 already rules out looking at
probe-request traffic at all. This system only ever observes the MAC a
device presents at actual association time, once it has joined and is
headed toward the consent page.
