/**
 * Queue ingestion module for WTF Server.
 *
 * Polls a JSONL queue file written by the PostToolUse hook script,
 * atomically renames it for processing, parses each line, and inserts
 * entries into raw_entries with gen_type "captured".
 */

import { existsSync, renameSync, readFileSync, unlinkSync } from "node:fs";
import { getDb } from "./db";
import { getOrCreateActiveIncident } from "./tools/now";

/** Shape of a single queued entry from the hook script. */
interface QueueEntry {
  tool_name?: string;
  tool_input?: string;
  tool_response?: string;
  tool_use_id?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
}

/**
 * Process a single queue cycle: rename the queue file, read lines,
 * parse each as JSON, and insert into raw_entries.
 *
 * @param queuePath - Path to the hook-queue.jsonl file.
 * @param dbPath - Optional database path (used by tests).
 */
export function processQueue(queuePath: string, dbPath?: string): void {
  if (!existsSync(queuePath)) {
    return;
  }

  const processingPath = queuePath.replace(/\.jsonl$/, ".processing.jsonl");

  // Atomic rename to avoid races with the hook script.
  renameSync(queuePath, processingPath);

  let content: string;
  try {
    content = readFileSync(processingPath, "utf-8");
  } catch {
    return;
  }

  const db = getDb(dbPath);
  const incidentId = getOrCreateActiveIncident(dbPath);

  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  for (const line of lines) {
    let entry: QueueEntry;
    try {
      entry = JSON.parse(line) as QueueEntry;
    } catch {
      console.error(`Malformed queue entry, skipping: ${line}`);
      continue;
    }

    db.run(
      `INSERT INTO raw_entries (
        incident_id, gen_type, tool_name, tool_input,
        tool_response, tool_use_id, agent_id, agent_type, session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        incidentId,
        "captured",
        entry.tool_name ?? null,
        entry.tool_input ?? null,
        entry.tool_response ?? null,
        entry.tool_use_id ?? null,
        entry.agent_id ?? null,
        entry.agent_type ?? null,
        entry.session_id ?? null,
      ]
    );
  }

  // Remove the processing file after successful ingestion.
  try {
    unlinkSync(processingPath);
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * Start polling the queue file at a regular interval.
 *
 * @param queuePath - Path to the hook-queue.jsonl file.
 * @param intervalMs - Polling interval in milliseconds (default: 2000).
 * @param dbPath - Optional database path (used by tests).
 * @returns The interval timer so callers/tests can clear it.
 */
export function startQueueIngestion(
  queuePath: string,
  intervalMs: number = 2000,
  dbPath?: string
): NodeJS.Timer {
  return setInterval(() => {
    processQueue(queuePath, dbPath);
  }, intervalMs);
}
