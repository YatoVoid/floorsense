# Firmware

Real-hardware AP node firmware, separate from the npm-workspace
TypeScript packages under `packages/`.

- `esp32-ap-node/`: ESP32 firmware that broadcasts the venue's WiFi,
  redirects joining devices to the consent page, and reports
  join/leave/signal-strength events to the backend. See its own
  README before flashing - it has not been compiled or hardware-tested
  in this development environment.
