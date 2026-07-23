import assert from "node:assert";
import { test } from "node:test";
import { getDisclosure } from "./disclosure.ts";
import { renderSignagePage } from "./signage.ts";
import { escapeHtml } from "./splashPage.ts";

test("signage page includes the venue name, SSID, and portal URL", () => {
  const html = renderSignagePage({ venueName: "Test Cafe", ssidName: "Test-Guest-WiFi", portalUrl: "http://10.0.0.1:8080/" });
  assert.match(html, /Test Cafe/);
  assert.match(html, /Test-Guest-WiFi/);
  assert.match(html, /http:\/\/10\.0\.0\.1:8080\//);
});

test("signage page includes a QR-code placeholder, not a real QR image", () => {
  const html = renderSignagePage({ venueName: "Test Cafe", ssidName: "Test-Guest-WiFi", portalUrl: "http://10.0.0.1:8080/" });
  assert.match(html, /QR code placeholder/);
  assert.doesNotMatch(html, /<img/, "no real QR image generation is in scope for this KR");
});

test("signage page uses print-friendly CSS", () => {
  const html = renderSignagePage({ venueName: "Test Cafe", ssidName: "Test-Guest-WiFi", portalUrl: "http://10.0.0.1:8080/" });
  assert.match(html, /@media print/);
});

test("signage consent copy matches getDisclosure exactly, no duplicate prose drifting out of sync", () => {
  const venueName = "Test Cafe";
  const html = renderSignagePage({ venueName, ssidName: "Test-Guest-WiFi", portalUrl: "http://10.0.0.1:8080/" });
  const disclosure = getDisclosure(venueName);
  const asPattern = (text: string) => new RegExp(escapeHtml(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  assert.match(html, asPattern(disclosure.title));
  assert.match(html, asPattern(disclosure.intro));
  for (const item of disclosure.collected) {
    assert.match(html, asPattern(item));
  }
  for (const item of disclosure.notCollected) {
    assert.match(html, asPattern(item));
  }
});
