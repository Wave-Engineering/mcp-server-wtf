/**
 * wtf_happened tool handler — returns a formatted Markdown timeline
 * of the current troubleshooting incident.
 *
 * Queries distilled_entries first (will be empty until the classifier
 * is implemented). Falls back to raw_entries with a notice.
 * Summary mode (default) caps output at 50 lines.
 *
 * Also generates a runbook skeleton at .wtf/runbook.md grouping
 * distilled entries by action_type into Problem, Root Cause,
 * Resolution Steps, and Verification sections.
 */

import { getDb } from "../db";
import { getOrCreateActiveIncident } from "./now";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Arguments accepted by the wtf_happened tool. */
export interface HappenedArgs {
  detail?: "summary" | "full";
}

/** Options for controlling file output paths (used by tests). */
export interface HappenedOptions {
  runbookPath?: string;
}

/** Shape of a distilled_entries row. */
export interface DistilledRow {
  id: number;
  ts: string;
  action_type: string;
  summary: string;
}

/** Shape of a raw_entries row. */
interface RawRow {
  id: number;
  ts: string;
  action_type: string | null;
  text: string | null;
  tool_name: string | null;
}

/** Shape of an incident row. */
interface IncidentRow {
  id: number;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
}

/** MCP tool response type. */
type McpResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

const SUMMARY_LINE_CAP = 50;

/**
 * Format a timestamp string to HH:MM.
 */
function formatTime(ts: string): string {
  const date = new Date(ts);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Calculate duration in minutes between two timestamp strings.
 * If endTs is not provided, uses the current time.
 */
function calcDurationMinutes(startTs: string, endTs?: string | null): number {
  const start = new Date(startTs).getTime();
  const end = endTs ? new Date(endTs).getTime() : Date.now();
  return Math.round((end - start) / 60000);
}

/**
 * Format a single distilled entry line.
 */
function formatDistilledLine(index: number, row: DistilledRow): string {
  const time = formatTime(row.ts);
  const type = row.action_type.toUpperCase();
  return `${index}. [${time}] ${type} — ${row.summary}`;
}

/**
 * Format a single raw entry line.
 */
function formatRawLine(index: number, row: RawRow): string {
  const time = formatTime(row.ts);
  const type = row.action_type
    ? row.action_type.toUpperCase()
    : row.tool_name ?? "ENTRY";
  const description = row.text ?? row.tool_name ?? "(no description)";
  return `${index}. [${time}] ${type} — ${description}`;
}

/**
 * Handle a wtf_happened tool invocation.
 *
 * Gets the active incident, queries for entries (distilled first,
 * raw fallback), and formats a Markdown timeline response.
 *
 * @param args - The tool arguments from the MCP request.
 * @param dbPath - Optional database path (used by tests).
 * @param options - Optional overrides for file paths (used by tests).
 * @returns MCP tool response with formatted Markdown timeline.
 */
export function handleHappened(
  args: HappenedArgs,
  dbPath?: string,
  options?: HappenedOptions,
): McpResponse {
  const detail = args.detail ?? "summary";
  const db = getDb(dbPath);

  // Check if there's an active or suspended incident
  const incidentRow = db
    .query(
      "SELECT * FROM incidents WHERE status IN ('active', 'suspended') ORDER BY id DESC LIMIT 1"
    )
    .get() as IncidentRow | null;

  if (!incidentRow) {
    return {
      content: [
        {
          type: "text",
          text: "No active or suspended incident found. Use `/wtf` to start a troubleshooting session.",
        },
      ],
    };
  }

  const incidentId = incidentRow.id;
  const title = incidentRow.title ?? "Untitled Incident";

  // Try distilled_entries first
  const distilledRows = db
    .query(
      "SELECT id, ts, action_type, summary FROM distilled_entries WHERE incident_id = ? AND is_noise = 0 ORDER BY ts ASC"
    )
    .all(incidentId) as DistilledRow[];

  let usingRaw = false;
  let lines: string[];

  if (distilledRows.length > 0) {
    // Use distilled entries
    lines = distilledRows.map((row, i) => formatDistilledLine(i + 1, row));
  } else {
    // Fallback to raw entries
    const rawRows = db
      .query(
        "SELECT id, ts, action_type, text, tool_name FROM raw_entries WHERE incident_id = ? ORDER BY ts ASC"
      )
      .all(incidentId) as RawRow[];

    if (rawRows.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `## WTF Summary — ${title}\n\nNo entries recorded yet. Use \`wtf_now\` to add observations, breadcrumbs, and theories.`,
          },
        ],
      };
    }

    usingRaw = true;
    lines = rawRows.map((row, i) => formatRawLine(i + 1, row));
  }

  // Count entries for the header
  const rawCount = (
    db
      .query(
        "SELECT COUNT(*) as count FROM raw_entries WHERE incident_id = ?"
      )
      .get(incidentId) as { count: number }
  ).count;

  const distilledCount = (
    db
      .query(
        "SELECT COUNT(*) as count FROM distilled_entries WHERE incident_id = ? AND is_noise = 0"
      )
      .get(incidentId) as { count: number }
  ).count;

  // Calculate duration
  const durationMin = calcDurationMinutes(
    incidentRow.started_at,
    incidentRow.ended_at
  );

  // Build header
  const header = `## WTF Summary — ${title}\n**Duration:** ${durationMin} min | **Entries:** ${rawCount} raw, ${distilledCount} distilled | **Status:** ${incidentRow.status}`;

  // Apply summary cap
  let truncated = false;
  if (detail === "summary" && lines.length > SUMMARY_LINE_CAP) {
    lines = lines.slice(0, SUMMARY_LINE_CAP);
    truncated = true;
  }

  // Build full output
  const parts: string[] = [header, ""];

  if (usingRaw) {
    parts.push(
      "> **Note:** Classifier has not processed entries yet. Showing raw entries.\n"
    );
  }

  parts.push(lines.join("\n"));

  if (truncated) {
    parts.push(
      `\n*...truncated to ${SUMMARY_LINE_CAP} lines. Use detail: "full" to see all entries.*`
    );
  }

  // --- Runbook generation ---
  const runbookPath = options?.runbookPath ?? resolve(process.cwd(), ".wtf", "runbook.md");
  const runbookContent = buildRunbook(title, distilledRows);
  writeRunbook(runbookPath, runbookContent);
  parts.push(`\nRunbook written to ${runbookPath}`);

  return {
    content: [
      {
        type: "text",
        text: parts.join("\n"),
      },
    ],
  };
}

/**
 * Group distilled entries by action_type and build a runbook skeleton.
 *
 * Sections:
 *   - Problem: from breadcrumb entries
 *   - Root Cause: from theory entries
 *   - Resolution Steps: from action entries (chronological)
 *   - Verification: from breadcrumb entries that appear after the last action
 *
 * Handles missing sections gracefully with placeholder messages.
 */
export function buildRunbook(title: string, distilledRows: DistilledRow[]): string {
  const timestamp = new Date().toISOString();

  // Group entries by action_type
  const breadcrumbs: DistilledRow[] = [];
  const theories: DistilledRow[] = [];
  const actions: DistilledRow[] = [];

  for (const row of distilledRows) {
    switch (row.action_type) {
      case "breadcrumb":
        breadcrumbs.push(row);
        break;
      case "theory":
        theories.push(row);
        break;
      case "action":
        actions.push(row);
        break;
      // noise entries are already filtered out by the query
    }
  }

  // Find the timestamp of the last action to split breadcrumbs into
  // "problem" (before/during) and "verification" (after last action)
  const lastActionTs = actions.length > 0
    ? actions[actions.length - 1].ts
    : null;

  const problemBreadcrumbs: DistilledRow[] = [];
  const verificationBreadcrumbs: DistilledRow[] = [];

  for (const bc of breadcrumbs) {
    if (lastActionTs && bc.ts > lastActionTs) {
      verificationBreadcrumbs.push(bc);
    } else {
      problemBreadcrumbs.push(bc);
    }
  }

  // Build the Markdown runbook
  const parts: string[] = [];
  parts.push(`# Runbook — ${title}`);
  parts.push(`_Generated: ${timestamp}_`);
  parts.push("");

  // Problem section
  parts.push("## Problem");
  if (problemBreadcrumbs.length > 0) {
    for (const row of problemBreadcrumbs) {
      parts.push(`- ${row.summary}`);
    }
  } else {
    parts.push("No problem breadcrumbs were recorded.");
  }
  parts.push("");

  // Root Cause section
  parts.push("## Root Cause");
  if (theories.length > 0) {
    for (const row of theories) {
      parts.push(`- ${row.summary}`);
    }
  } else {
    parts.push("No root cause theory was recorded.");
  }
  parts.push("");

  // Resolution Steps section (chronological order preserved from ASC query)
  parts.push("## Resolution Steps");
  if (actions.length > 0) {
    actions.forEach((row, i) => {
      parts.push(`${i + 1}. ${row.summary}`);
    });
  } else {
    parts.push("No resolution actions were recorded.");
  }
  parts.push("");

  // Verification section
  parts.push("## Verification");
  if (verificationBreadcrumbs.length > 0) {
    for (const row of verificationBreadcrumbs) {
      parts.push(`- ${row.summary}`);
    }
  } else {
    parts.push("No post-resolution verification was recorded.");
  }
  parts.push("");

  return parts.join("\n");
}

/**
 * Write the runbook content to disk, ensuring the parent directory exists.
 */
function writeRunbook(runbookPath: string, content: string): void {
  const dir = dirname(runbookPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(runbookPath, content, "utf-8");
}
