/**
 * wtf_now tool handler — records journal entries into raw_entries.
 *
 * Supports both crafted (manual) and captured (hook) entries with
 * optional action_type classification.
 */

import { getDb } from "../db";

/** Arguments accepted by the wtf_now tool. */
export interface NowArgs {
  gen_type: string;
  action_type?: string;
  text?: string;
  tool_name?: string;
  tool_input?: string;
  tool_response?: string;
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
  session_id?: string;
}

/**
 * Get the active incident, or create one if none exists.
 *
 * @returns The incident ID of the active incident.
 */
export function getOrCreateActiveIncident(dbPath?: string): number {
  const db = getDb(dbPath);

  const row = db
    .query("SELECT id FROM incidents WHERE status = 'active' LIMIT 1")
    .get() as { id: number } | null;

  if (row) {
    return row.id;
  }

  const result = db.run(
    "INSERT INTO incidents (status) VALUES ('active')"
  );
  return Number(result.lastInsertRowid);
}

/**
 * Handle a wtf_now tool invocation.
 *
 * Gets or creates an active incident, validates inputs, inserts into
 * raw_entries, and returns an MCP-formatted response.
 *
 * @param args - The tool arguments from the MCP request.
 * @param dbPath - Optional database path (used by tests).
 * @returns MCP tool response with {ok, entry_id} or error.
 */
export function handleNow(
  args: NowArgs,
  dbPath?: string
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  // Validate gen_type
  if (args.gen_type !== "crafted" && args.gen_type !== "captured") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: `Invalid gen_type: "${args.gen_type}". Must be "crafted" or "captured".`,
          }),
        },
      ],
      isError: true,
    };
  }

  const db = getDb(dbPath);
  const incidentId = getOrCreateActiveIncident(dbPath);

  const result = db.run(
    `INSERT INTO raw_entries (
      incident_id, gen_type, action_type, text,
      tool_name, tool_input, tool_response, tool_use_id,
      agent_id, agent_type, session_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      incidentId,
      args.gen_type,
      args.action_type ?? null,
      args.text ?? null,
      args.tool_name ?? null,
      args.tool_input ?? null,
      args.tool_response ?? null,
      args.tool_use_id ?? null,
      args.agent_id ?? null,
      args.agent_type ?? null,
      args.session_id ?? null,
    ]
  );

  const entryId = Number(result.lastInsertRowid);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: true, entry_id: entryId }),
      },
    ],
  };
}
