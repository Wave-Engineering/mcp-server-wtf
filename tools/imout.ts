/**
 * wtf_imout — Suspend the active troubleshooting session.
 *
 * Stops recording tool calls but preserves all captured data for
 * later triage. Sets the incident status to 'suspended' and records
 * the ended_at timestamp.
 */

import { getDb } from "../db";

/**
 * Suspend the currently active incident.
 *
 * @param dbPath - Optional database path (for tests).
 * @returns Success status and the suspended incident ID.
 */
export function handleImout(dbPath?: string): {
  ok: boolean;
  incident_id: number | null;
  message?: string;
} {
  const db = getDb(dbPath);

  // Find the active incident
  const incident = db
    .query(
      `SELECT id FROM incidents WHERE status = 'active' ORDER BY id DESC LIMIT 1`
    )
    .get() as { id: number } | null;

  if (!incident) {
    return {
      ok: false,
      incident_id: null,
      message: "No active incident to suspend",
    };
  }

  // Suspend the incident (preserve data, stop recording)
  db.run(
    `UPDATE incidents SET status = 'suspended', ended_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?`,
    [incident.id]
  );

  return {
    ok: true,
    incident_id: incident.id,
    message: `Incident ${incident.id} suspended`,
  };
}
