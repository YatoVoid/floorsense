# Captive-portal AP: real-deployment templates

This directory holds configuration templates for running FloorSense's
captive-portal consent flow on a real WiFi access point (a Linux box
today, e.g. a Raspberry Pi or a laptop with a WiFi card in AP mode, with
an ESP32-based device as the eventual production target).

These are templates and documentation only. Nothing in this repository
executes hostapd, dnsmasq, nftables/iptables, or any wireless-interface
command against a real network. Every file here has placeholder values
(`<LIKE_THIS>`) that an operator fills in and applies manually, on
hardware they control.

## Why a captive portal, not passive sniffing

This is the project's locked mechanism for turning a nearby phone into
tracked data: the device must join an open WiFi network, see a
plain-language consent splash page, and explicitly accept before
anything about it is stored. There is no passive-listening mode
anywhere in this design. A device that never joins the network is
never seen by any part of this system.

## The end-to-end flow

1. **Association.** A device joins the open SSID configured in
   `hostapd.conf.template`. No password, open by design, since gating
   happens at the HTTP layer, not the network-auth layer.
2. **DHCP + DNS hijack.** `dnsmasq.conf.template` hands the device an IP
   address and resolves every DNS query to the AP's own address
   (`address=/#/<AP_IP>`), so any web request it tries lands on the AP.
3. **Redirect to the portal.** `redirect-rules.nft.template` intercepts
   the device's HTTP(S) traffic and forwards it to
   `@floorsense/captive-portal`'s HTTP server (see `packages/captive-portal`),
   running on `<AP_IP>:<PORTAL_PORT>`.
4. **Splash page + accept.** The device sees the portal's splash page
   (`GET /?deviceId=<hashed-id>`, see `packages/captive-portal/src/splashPage.ts`).
   If it accepts, `POST /consent/accept` records a `consent_grants` row
   via `@floorsense/backend`'s `recordConsentGrant`.
5. **Unlock.** A glue step not built yet (see the note in
   `redirect-rules.nft.template`) adds the device's MAC to the
   `allowed_devices` nftables set once its consent POST succeeds. Its
   traffic then flows to the real internet instead of the portal, and
   the AP's event stream can start reporting its presence through
   `ingestApEvent` (which would have rejected any event for this device
   before this point anyway, per the backend's consent gate).
6. **Ongoing presence.** While joined, the AP node(s) report join/
   signal_reading/leave events for the device the same way
   `@floorsense/ap-adapter-sim`'s simulator does today for local
   development. A real deployment's AP firmware/daemon is the eventual
   swap-in for the simulator, emitting the same `ApEvent` shape.

## Simulated today vs. real hardware later

| Piece | Today (this repo) | Real deployment |
|---|---|---|
| AP / WiFi radio | `SimulatedApAdapter` (in-process event emitter) | hostapd + real WiFi hardware (ESP32 eventually) |
| Captive portal HTTP server | `packages/captive-portal`, already real | same code, deployed on the AP device |
| DHCP/DNS/redirect | not involved (no real network) | `dnsmasq.conf.template` + `redirect-rules.nft.template`, filled in and applied by an operator |
| Consent storage | `consent_grants` table via SQLite, already real | same, unchanged |
| MAC-to-hash matching to unlock traffic | not built yet | the glue step described above |

## Out of scope here

- The glue script that reads the AP's DHCP lease table, hashes a MAC,
  and updates the nftables set.
- Provisioning real hardware, running `hostapd`/`dnsmasq`/`nft` against
  any interface, or testing this flow over a live radio.
- ESP32 firmware. This template targets a Linux-based AP as the nearer
  step; ESP32 comes after that.
