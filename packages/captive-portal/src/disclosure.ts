/**
 * The single source of consent-disclosure copy, shared by the splash page
 * (server.ts) and the printable signage deliverable, so the two never
 * drift into inconsistent wording about what is and isn't collected.
 */
export interface Disclosure {
  title: string;
  intro: string;
  collected: string[];
  notCollected: string[];
  retentionAndOptOut: string;
}

export function getDisclosure(venueName: string): Disclosure {
  return {
    title: `Connecting to ${venueName} WiFi`,
    intro:
      `${venueName} uses this free WiFi network to understand how busy the space is at different times ` +
      `and to improve service. Here's exactly what that means:`,
    collected: [
      "A one-way scrambled code derived from your device — it cannot be reversed back into your device's real address.",
      "Signal strength readings, used only to estimate where in the venue your device is.",
      "Timestamps of when your device is seen, and for how long.",
    ],
    notCollected: [
      "Your device's real hardware (MAC) address — never stored or transmitted.",
      "Any browsing activity, app usage, or message content.",
      "Your location once you leave the venue's WiFi range.",
      "Any personal details — name, phone number, or account — unless you separately give them to staff.",
    ],
    retentionAndOptOut:
      "This data is kept by the venue for their own use and is never sold. You can decline and still use the venue " +
      "normally without connecting to this WiFi network — connecting is optional.",
  };
}
