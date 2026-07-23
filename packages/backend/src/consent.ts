import type { DatabaseSync } from "node:sqlite";

export interface ConsentGrant {
  tenantId: string;
  venueId: string;
  hashedDeviceId: string;
  acceptedAt: number;
  termsVersion: string;
}

/** Re-granting the same (tenant, venue, device) triple updates the existing row instead of adding a new one. */
export function recordConsentGrant(
  db: DatabaseSync,
  input: { tenantId: string; venueId: string; hashedDeviceId: string; termsVersion: string }
): ConsentGrant {
  const acceptedAt = Date.now();
  db.prepare(
    `INSERT INTO consent_grants (tenant_id, venue_id, hashed_device_id, accepted_at, terms_version)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, venue_id, hashed_device_id)
     DO UPDATE SET accepted_at = excluded.accepted_at, terms_version = excluded.terms_version`
  ).run(input.tenantId, input.venueId, input.hashedDeviceId, acceptedAt, input.termsVersion);
  return { ...input, acceptedAt };
}

export function hasConsent(
  db: DatabaseSync,
  tenantId: string,
  venueId: string,
  hashedDeviceId: string
): boolean {
  const row = db
    .prepare("SELECT 1 FROM consent_grants WHERE tenant_id = ? AND venue_id = ? AND hashed_device_id = ?")
    .get(tenantId, venueId, hashedDeviceId);
  return row !== undefined;
}
