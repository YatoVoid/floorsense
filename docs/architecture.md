# FloorSense architecture

## What this is

A consent-based WiFi presence analytics system for physical venues
(restaurants, cafes). Visitors connect to an on-site open WiFi network;
a captive portal shows a consent/terms splash page before granting
internet access — that's where consent lives. Once connected, the venue's
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
local persistence (no native-module dependency), and Node's native
TypeScript type-stripping (no separate build step needed for
development — `.ts` files run directly via `node`).

Why Node/TS:
- The core domain (AP join/leave/signal events, real-time presence,
  eventually a network-facing captive-portal server) is fundamentally
  event-driven and I/O-bound — a strong fit for Node's async model.
- The eventual real deployment swaps a simulated AP adapter for one that
  talks to hostapd/dnsmasq and, further out, an ESP32-based AP. Keeping
  the adapter and the backend in one language avoids a schema/type-drift
  problem across a network boundary that will already be difficult
  enough (embedded device <-> server).
- `node:sqlite` avoids a native-module dependency (`better-sqlite3`
  requires prebuilt binaries or a working native toolchain); Node's
  built-in module has neither of those failure modes and is verified
  present and working on this project's target Node version (26.4.0+).

Python (FastAPI/SQLAlchemy + numpy/scipy) was considered for its
numeric-computing ecosystem, which is relevant to the later
trilateration/calibration math. It was not chosen for the initial
scaffold because the event pipeline and network-facing pieces are the
larger share of this system's code, and splitting the codebase across
two languages this early adds real coordination cost for no immediate
benefit. If calibration math later turns out to need heavier numeric
tooling than Node's ecosystem comfortably provides, a small Python
microservice for just that computation is a clean addition — it does
not require rewriting anything built in this scaffold.

## Package layout

- `packages/shared` — cross-package types (`APEvent` and friends) and the
  one hashing utility every identifier must pass through. No I/O, no
  framework dependency — pure logic, directly testable.
- `packages/ap-adapter-sim` — emits synthetic `APEvent` streams (device
  join/leave/signal-strength readings) for local development and demos.
  This is the intended swap point: a future `ap-adapter-hostapd` package
  implementing the same emitted-event contract replaces this one when
  running against a real access point, without the backend needing to
  change.
- `packages/backend` — ingests `APEvent`s, persists them (tenant-scoped),
  and will host the captive-portal web server, calibration/heatmap logic,
  and the owner-facing API in later key results. Local SQLite now is the
  other intended swap point — swapping to a remote database later is
  meant to be a persistence-layer change, not a rewrite of the ingestion
  or analytics logic above it.

## Local-first now, distributed later

Everything in this repo runs on a single machine today: the simulated
adapter, the backend, and (in later key results) the owner-facing web
app. The two swap points called out above (adapter, persistence) are
where the real-hardware/real-server version diverges from this proof of
concept — everything else is meant to carry over unchanged.
