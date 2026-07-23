import { getDisclosure } from "./disclosure.ts";
import { escapeHtml } from "./splashPage.ts";

export interface SignageInput {
  venueName: string;
  ssidName: string;
  portalUrl: string;
}

/** Printable signage page. Shares getDisclosure() with the splash page so the wording never drifts apart. */
export function renderSignagePage(input: SignageInput): string {
  const disclosure = getDisclosure(input.venueName);
  const listItems = (items: string[]) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n        ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(input.venueName)} — WiFi Notice</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { font-size: 1.5rem; text-align: center; }
    .ssid { text-align: center; font-size: 1.1rem; font-weight: bold; margin: 1rem 0; }
    .qr-placeholder {
      width: 8rem; height: 8rem; margin: 1.5rem auto; border: 2px dashed #888;
      display: flex; align-items: center; justify-content: center; text-align: center; font-size: 0.75rem; color: #555;
    }
    .summary { font-size: 0.95rem; }
    @media print {
      body { margin: 0; padding: 1rem; }
      .qr-placeholder { border: 2px solid #000; color: #000; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(disclosure.title)}</h1>
  <p class="ssid">Network: ${escapeHtml(input.ssidName)}</p>
  <div class="qr-placeholder">[ QR code placeholder ]<br />${escapeHtml(input.portalUrl)}</div>
  <div class="summary">
    <p>${escapeHtml(disclosure.intro)}</p>
    <p><strong>Collected:</strong></p>
    <ul>
        ${listItems(disclosure.collected)}
    </ul>
    <p><strong>Never collected:</strong></p>
    <ul>
        ${listItems(disclosure.notCollected)}
    </ul>
    <p>${escapeHtml(disclosure.retentionAndOptOut)}</p>
  </div>
</body>
</html>`;
}

/** Run directly: `node src/signage.ts` (writes deploy/signage/notice.html) */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  const outPath = join(REPO_ROOT, "deploy", "signage", "notice.html");

  const html = renderSignagePage({
    venueName: "Demo Cafe",
    ssidName: "FloorSense-Guest",
    portalUrl: "http://10.90.0.1:8080/",
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf-8");
  console.log(`Wrote ${outPath}`);
}
