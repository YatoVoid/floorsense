# FloorSense captive-portal AP — real-deployment templates

This directory holds configuration **templates** for running FloorSense's
captive-portal consent flow on a real WiFi access point (a Linux box today —
e.g. a Raspberry Pi or a laptop with a WiFi card in AP mode — with an
ESP32-based device as the eventual production target).

**These are templates and documentation only.** Nothing in this repository
executes hostapd, dnsmasq, nftables/iptables, or any wireless-interface
command against a real network. Every file here has placeholder values
(`<LIKE_THIS>`) that an operator fills in and applies manually, on hardware
they control, as a deliberate step outside of any automated process.

## Why a captive portal, not passive sniffing

This is the project's locked, non-negotiable mechanism for turning a nearby
phone into tracked data: the device must join an open WiFi network, see a
plain-language consent splash page, and explicitly accept before anything
about it is stored. There is no passive-listening mode anywhere in this
design — a device that never joins the network is never seen by any part of
this system.

## The end-to-end flow

1. **Association** — a device joins the open SSID configured in
   `hostapd.conf.template`. No password; open by design, since gating
   happens at the HTTP layer, not the network-auth layer.
2. **DHCP + DNS hijack** — `dnsmasq.conf.template` hands the device an IP
   address and resolves every DNS query it makes to the AP's own address
   (`address=/#/<AP_IP>`), so any web request it tries lands on the AP.
3. **Redirect to the portal** — `redirect-rules.nft.template` intercepts
   the device's HTTP(S) traffic and forwards it to
   `@floorsense/captive-portal`'s HTTP server (built in this KR — see
   `packages/captive-portal`), running on `<AP_IP>:<PORTAL_PORT>`.
4. **Splash page + accept** — the device sees the portal's splash page
   (`GET /?deviceId=<hashed-id>`, see `packages/captive-portal/src/splashPage.ts`)
   and, if it accepts, `POST /consent/accept` records a `consent_grants`
   row via `@floorsense/backend`'s `recordConsentGrant`.
5. **Unlock** — a real deployment's glue step (not built in this KR —
   see the note in `redirect-rules.nft.template`) adds the device's MAC to
   the `allowed_devices` nftables set once its consent POST succeeds,
   after which its traffic flows to the real internet instead of the
   portal, and the AP's own event stream can start reporting its presence
   through `ingestApEvent` (which, per the backend's consent gate, would
   have rejected any event for this device before this point regardless).
6. **Ongoing presence** — while joined, the AP node(s) report join/
   signal_reading/leave events for the device exactly as
   `@floorsense/ap-adapter-sim`'s simulator does today for local
   development; a real deployment's AP firmware/daemon is the eventual
   swap-in for the simulator, emitting the same `ApEvent` shape.

## What's simulated today vs. real hardware later

| Piece | Today (this repo) | Real deployment |
|---|---|---|
| AP / WiFi radio | `SimulatedApAdapter` (in-process event emitter) | hostapd + real WiFi hardware (ESP32 eventually) |
| Captive portal HTTP server | `packages/captive-portal` — already real, runs identically on real hardware | same code, deployed on the AP device |
| DHCP/DNS/redirect | N/A (no real network involved) | `dnsmasq.conf.template` + `redirect-rules.nft.template`, filled in and applied by an operator |
| Consent storage | `consent_grants` table via SQLite — already real | same, unchanged |
| MAC-to-hash matching for unlocking traffic | N/A | the not-yet-built glue step described above |

## Explicitly out of scope for this KR

- Writing or running the glue script that reads the AP's DHCP lease
  table, hashes a MAC, and updates the nftables set.
- Provisioning real hardware, running `hostapd`/`dnsmasq`/`nft` against
  any interface, or testing this flow over a live radio.
- ESP32 firmware — this template targets a Linux-based AP as the nearer-
  term real-deployment step; ESP32 is the intended target after that.
