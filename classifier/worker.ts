/**
 * Background classifier worker for the WTF Server.
 *
 * Polls the database for unclassified raw_entries, sends each to
 * Claude Haiku via the Bedrock SDK for categorization, and writes
 * results to distilled_entries. Falls back to the Claude CLI if
 * the Bedrock SDK call fails.
 */

import { createLogger } from "@wave-engineering/mcp-logger";
import { getDb } from "../db";
import { getClassifierClient, CLASSIFIER_MODEL } from "./client";
import {
  buildClassifierPrompt,
  CLASSIFIER_SCHEMA,
  ACTION_TYPES,
  type ActionType,
} from "./prompt";

const log = createLogger("wtf");

/** Options for the classifier polling loop. */
export interface ClassifierOptions {
  pollIntervalMs?: number;
  rateLimitMs?: number;
}

/** Queue and worker pool configuration. */
const classificationQueue: Array<RawEntryRow> = [];
const WORKER_POOL_SIZE = 3;
const MAX_QUEUE_DEPTH_WARNING = 100;

/** Shape of a raw_entries row returned by the unclassified query. */
interface RawEntryRow {
  id: number;
  incident_id: number;
  ts: string;
  gen_type: string;
  action_type: string | null;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  session_id: string | null;
}

/** Parsed classifier response. */
interface ClassifierResult {
  action_type: ActionType;
  summary: string;
}

/**
 * Sleep for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate that a parsed response has the expected shape.
 *
 * @returns The validated result, or null if invalid.
 */
function validateResult(parsed: unknown): ClassifierResult | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (
    typeof obj.action_type !== "string" ||
    !ACTION_TYPES.includes(obj.action_type as ActionType)
  ) {
    return null;
  }

  if (typeof obj.summary !== "string" || obj.summary.length === 0) {
    return null;
  }

  return {
    action_type: obj.action_type as ActionType,
    summary: obj.summary,
  };
}

/**
 * Call Claude Haiku via the Bedrock SDK using tool_use for structured output.
 *
 * @param prompt - The classification prompt.
 * @returns The parsed classifier result, or null on failure.
 */
async function classifyViaBedrock(
  prompt: string
): Promise<ClassifierResult | null> {
  const client = getClassifierClient();

  const response = await client.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 256,
    tools: [
      {
        name: "classify_entry",
        description: "Classify a troubleshooting log entry.",
        input_schema: CLASSIFIER_SCHEMA,
      },
    ],
    tool_choice: { type: "tool" as const, name: "classify_entry" },
    messages: [{ role: "user", content: prompt }],
  });

  // Extract the tool_use block from the response.
  const toolUseBlock = response.content.find(
    (block) => block.type === "tool_use"
  );

  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    return null;
  }

  return validateResult(toolUseBlock.input);
}

/**
 * Fallback: call the Claude CLI when Bedrock is unavailable.
 *
 * Spawns `claude --model haiku --print -p <prompt>` and parses
 * the JSON output.
 *
 * @param prompt - The classification prompt.
 * @returns The parsed classifier result, or null on failure.
 */
async function classifyViaCli(
  prompt: string
): Promise<ClassifierResult | null> {
  const proc = Bun.spawn(["claude", "--model", "haiku", "--bare", "--print", "--no-session-persistence", "-p", prompt], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  // Try to extract JSON from the CLI output.
  const trimmed = output.trim();

  // The CLI might wrap the JSON in markdown code fences.
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) ??
    trimmed.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    return validateResult(parsed);
  } catch {
    return null;
  }
}

/**
 * Classify a single entry: try Bedrock first, fall back to CLI.
 *
 * @param prompt - The classification prompt.
 * @returns The parsed classifier result, or null if both methods fail.
 */
async function classifyEntry(
  prompt: string
): Promise<ClassifierResult | null> {
  try {
    const result = await classifyViaBedrock(prompt);
    if (result) return result;
  } catch (err) {
    log.warn("classifier", { method: "bedrock", error: String(err) }, "Bedrock failed, trying CLI fallback");
  }

  try {
    return await classifyViaCli(prompt);
  } catch (err) {
    log.error("classifier", { method: "cli", error: String(err) }, "CLI fallback also failed");
    return null;
  }
}

/**
 * Producer: polls DB for unclassified entries and feeds the queue.
 */
async function producer(
  dbPath: string | undefined,
  pollIntervalMs: number,
  running: () => boolean
): Promise<void> {
  while (running()) {
    try {
      const db = getDb(dbPath);

      // Fetch a batch of unclassified entries
      const rows = db
        .query(
          `SELECT r.* FROM raw_entries r
           LEFT JOIN distilled_entries d ON r.id = d.raw_id
           WHERE d.id IS NULL
           ORDER BY r.id ASC
           LIMIT 10`
        )
        .all() as RawEntryRow[];

      if (rows.length > 0) {
        // Deduplicate: only add entries not already in queue
        const queueIds = new Set(classificationQueue.map((e) => e.id));
        const newRows = rows.filter((r) => !queueIds.has(r.id));

        if (newRows.length > 0) {
          classificationQueue.push(...newRows);
          log.debug("queue_depth", { queued: newRows.length, depth: classificationQueue.length });

          // Emit warning if queue depth exceeds threshold
          if (classificationQueue.length >= MAX_QUEUE_DEPTH_WARNING) {
            log.warn("queue_depth", { depth: classificationQueue.length, threshold: MAX_QUEUE_DEPTH_WARNING }, "Queue depth exceeds threshold");
          }
        }
      }

      await sleep(pollIntervalMs);
    } catch (err) {
      log.error("classifier", { component: "producer", error: String(err) }, "Error in producer loop");
      await sleep(pollIntervalMs);
    }
  }
}

/**
 * Consumer: processes entries from the queue.
 */
async function consumer(
  workerId: number,
  dbPath: string | undefined,
  rateLimitMs: number,
  running: () => boolean
): Promise<void> {
  while (running()) {
    const row = classificationQueue.shift();

    if (!row) {
      // Queue empty - sleep briefly and retry
      await sleep(100);
      continue;
    }

    log.debug("classifier", { worker_id: workerId, entry_id: row.id, queue_depth: classificationQueue.length });

    try {
      const prompt = buildClassifierPrompt({
        id: row.id,
        gen_type: row.gen_type,
        action_type: row.action_type,
        text: row.text,
        tool_name: row.tool_name,
        tool_input: row.tool_input,
        tool_response: row.tool_response,
        tool_use_id: row.tool_use_id,
      });

      const result = await classifyEntry(prompt);

      if (!result) {
        log.error("classifier", { worker_id: workerId, entry_id: row.id }, "Classification failed, skipping");
        await sleep(rateLimitMs);
        continue;
      }

      const isNoise = result.action_type === "noise" ? 1 : 0;
      const db = getDb(dbPath);

      db.run(
        `INSERT INTO distilled_entries
         (raw_id, incident_id, ts, action_type, summary, is_noise)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.incident_id,
          row.ts,
          result.action_type,
          result.summary,
          isNoise,
        ]
      );

      await sleep(rateLimitMs);
    } catch (err) {
      log.error("classifier", { worker_id: workerId, entry_id: row.id, error: String(err) }, "Error processing entry");
      await sleep(rateLimitMs);
    }
  }
}

/**
 * Start the background classifier loop.
 *
 * Polls for unclassified raw_entries, classifies each via Haiku,
 * and inserts results into distilled_entries.
 *
 * @param dbPath - Optional database path (for tests).
 * @param options - Polling and rate-limit configuration.
 * @returns A cleanup function that stops the loop.
 */
export function startClassifier(
  dbPath?: string,
  options?: ClassifierOptions
): { stop: () => void } {
  const pollIntervalMs = options?.pollIntervalMs ?? 5000;
  const rateLimitMs = options?.rateLimitMs ?? 2000;

  let running = true;
  const isRunning = () => running;

  // Launch producer
  producer(dbPath, pollIntervalMs, isRunning);

  // Launch worker pool
  for (let i = 0; i < WORKER_POOL_SIZE; i++) {
    consumer(i, dbPath, rateLimitMs, isRunning);
  }

  log.info("state_change", { what: "classifier", to: "running", workers: WORKER_POOL_SIZE, poll_ms: pollIntervalMs, rate_limit_ms: rateLimitMs });

  return {
    stop: () => {
      running = false;
      log.info("state_change", { what: "classifier", to: "stopped" });
    },
  };
}
