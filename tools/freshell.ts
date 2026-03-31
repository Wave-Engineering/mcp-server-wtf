/**
 * wtf_freshell tool handler — archives the current incident and starts fresh.
 *
 * Finds the active incident, sets it to archived with an ended_at timestamp,
 * counts its raw entries, creates a new active incident, and returns a
 * summary. Ensures only one active incident exists at any time.
 */

import { getDb } from "../db";

/** Arguments accepted by the wtf_freshell tool. */
export interface FreshellArgs {
  title?: string;
}

/**
 * Handle a wtf_freshell tool invocation.
 *
 * Archives the current active incident (if any), counts its entries,
 * creates a new active incident, and returns an MCP-formatted response.
 *
 * @param args - The tool arguments from the MCP request.
 * @param dbPath - Optional database path (used by tests).
 * @returns MCP tool response with {ok, archived_entries, new_incident_id}.
 */
export function handleFreshell(
  args: FreshellArgs,
  dbPath?: string
): { content: Array<{ type: string; text: string }> } {
  const db = getDb(dbPath);

  // Find the currently active incident.
  const activeRow = db
    .query("SELECT id FROM incidents WHERE status = 'active' LIMIT 1")
    .get() as { id: number } | null;

  let archivedEntries = 0;

  if (activeRow) {
    // Count raw entries for the active incident before archiving.
    const countRow = db
      .query(
        "SELECT COUNT(*) as count FROM raw_entries WHERE incident_id = ?"
      )
      .get(activeRow.id) as { count: number };
    archivedEntries = countRow.count;

    // Archive the incident: set status, ended_at, and optional title.
    if (args.title) {
      db.run(
        `UPDATE incidents
         SET status = 'archived',
             ended_at = strftime('%Y-%m-%dT%H:%M:%f', 'now'),
             title = ?
         WHERE id = ?`,
        [args.title, activeRow.id]
      );
    } else {
      db.run(
        `UPDATE incidents
         SET status = 'archived',
             ended_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
         WHERE id = ?`,
        [activeRow.id]
      );
    }
  }

  // Create a new active incident.
  const result = db.run(
    "INSERT INTO incidents (status) VALUES ('active')"
  );
  const newIncidentId = Number(result.lastInsertRowid);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          archived_entries: archivedEntries,
          new_incident_id: newIncidentId,
        }),
      },
    ],
  };
}
