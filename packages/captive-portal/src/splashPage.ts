import { getDisclosure } from "./disclosure.ts";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderSplashPage(input: { venueName: string; hashedDeviceId: string; termsVersion: string }): string {
  const disclosure = getDisclosure(input.venueName);
  const listItems = (items: string[]) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n        ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(disclosure.title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
    h1 { font-size: 1.25rem; }
    button { font-size: 1rem; padding: 0.6rem 1.2rem; cursor: pointer; }
    .status { margin-top: 1rem; font-weight: bold; }
  </style>
</head>
<body>
  <h1>${escapeHtml(disclosure.title)}</h1>
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
  <form id="consent-form">
    <button type="submit">Accept and connect</button>
  </form>
  <p class="status" id="status"></p>
  <script>
    document.getElementById("consent-form").addEventListener("submit", function (e) {
      e.preventDefault();
      fetch("/consent/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hashedDeviceId: ${JSON.stringify(input.hashedDeviceId)},
          termsVersion: ${JSON.stringify(input.termsVersion)}
        })
      }).then(function (res) {
        document.getElementById("status").textContent = res.ok ? "Connected." : "Something went wrong.";
      });
    });
  </script>
</body>
</html>`;
}
