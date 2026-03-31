/**
 * Unit tests for queue ingestion and PostToolUse hook script.
 *
 * Tests cover single-line ingestion, multi-line processing, queue file
 * consumption, malformed JSON handling, and hook script output validation.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, resetDb } from "../db";
import { processQueue } from "../queue";

/** Create a unique temp directory for each test run. */
function makeTempDir(): string {
  const dir = join(tmpdir(), `wtf-queue-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("queue ingestion", () => {
  let tempDir: string;
  let queuePath: string;

  beforeEach(() => {
    resetDb();
    tempDir = makeTempDir();
    queuePath = join(tempDir, "hook-queue.jsonl");
  });

  afterEach(() => {
    resetDb();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  test("single JSONL line ingestion — raw_entry created", () => {
    const db = getDb(":memory:");

    const entry = {
      tool_name: "Bash",
      tool_input: '{"command": "ls"}',
      tool_response: "file1.txt\nfile2.txt",
      tool_use_id: "toolu_001",
      session_id: "sess-100",
      agent_id: "agent-1",
      agent_type: "main",
    };

    writeFileSync(queuePath, JSON.stringify(entry) + "\n");
    processQueue(queuePath, ":memory:");

    const rows = db
      .query("SELECT * FROM raw_entries")
      .all() as Array<Record<string, unknown>>;

    expect(rows.length).toBe(1);
    expect(rows[0].gen_type).toBe("captured");
    expect(rows[0].tool_name).toBe("Bash");
    expect(rows[0].tool_input).toBe('{"command": "ls"}');
    expect(rows[0].tool_response).toBe("file1.txt\nfile2.txt");
    expect(rows[0].tool_use_id).toBe("toolu_001");
    expect(rows[0].session_id).toBe("sess-100");
    expect(rows[0].agent_id).toBe("agent-1");
    expect(rows[0].agent_type).toBe("main");
    expect(rows[0].incident_id).toBeDefined();
  });

  test("multiple lines in order — all entries created in sequence", () => {
    const db = getDb(":memory:");

    const entries = [
      { tool_name: "Read", tool_use_id: "toolu_a" },
      { tool_name: "Write", tool_use_id: "toolu_b" },
      { tool_name: "Grep", tool_use_id: "toolu_c" },
    ];

    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(queuePath, content);
    processQueue(queuePath, ":memory:");

    const rows = db
      .query("SELECT tool_name, tool_use_id FROM raw_entries ORDER BY id")
      .all() as Array<{ tool_name: string; tool_use_id: string }>;

    expect(rows.length).toBe(3);
    expect(rows[0].tool_name).toBe("Read");
    expect(rows[0].tool_use_id).toBe("toolu_a");
    expect(rows[1].tool_name).toBe("Write");
    expect(rows[1].tool_use_id).toBe("toolu_b");
    expect(rows[2].tool_name).toBe("Grep");
    expect(rows[2].tool_use_id).toBe("toolu_c");
  });

  test("queue file consumed after processing — no unbounded growth", () => {
    getDb(":memory:");

    const entry = { tool_name: "Bash", tool_use_id: "toolu_x" };
    writeFileSync(queuePath, JSON.stringify(entry) + "\n");

    expect(existsSync(queuePath)).toBe(true);

    processQueue(queuePath, ":memory:");

    // Original queue file should be gone (renamed and deleted).
    expect(existsSync(queuePath)).toBe(false);

    // Processing file should also be gone.
    const processingPath = queuePath.replace(/\.jsonl$/, ".processing.jsonl");
    expect(existsSync(processingPath)).toBe(false);
  });

  test("malformed JSON skipped without crash — valid entries still ingested", () => {
    const db = getDb(":memory:");

    const content = [
      JSON.stringify({ tool_name: "Read", tool_use_id: "toolu_good1" }),
      "this is not valid json {{{",
      JSON.stringify({ tool_name: "Write", tool_use_id: "toolu_good2" }),
    ].join("\n") + "\n";

    writeFileSync(queuePath, content);
    processQueue(queuePath, ":memory:");

    const rows = db
      .query("SELECT tool_name FROM raw_entries ORDER BY id")
      .all() as Array<{ tool_name: string }>;

    // The two valid entries should be ingested; the malformed one skipped.
    expect(rows.length).toBe(2);
    expect(rows[0].tool_name).toBe("Read");
    expect(rows[1].tool_name).toBe("Write");
  });

  test("missing queue file — no-op without error", () => {
    getDb(":memory:");

    // queuePath does not exist; this should not throw.
    expect(() => processQueue(queuePath, ":memory:")).not.toThrow();
  });

  test("hook script output — produces valid JSONL with expected fields", async () => {
    const scriptPath = join(
      import.meta.dir,
      "..",
      "scripts",
      "hooks",
      "wtf-post-tool-use.sh"
    );

    const hookInput = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello",
      tool_use_id: "toolu_hook_test",
      session_id: "sess-hook",
      agent_id: "agent-hook",
      agent_type: "sub",
    });

    const outputDir = join(tempDir, ".wtf");
    const outputFile = join(outputDir, "hook-queue.jsonl");

    const proc = Bun.spawn(["bash", scriptPath], {
      stdin: new Response(hookInput),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: tempDir },
    });

    await proc.exited;

    expect(existsSync(outputFile)).toBe(true);

    const output = readFileSync(outputFile, "utf-8").trim();
    const parsed = JSON.parse(output);

    expect(parsed.tool_name).toBe("Bash");
    expect(parsed.tool_use_id).toBe("toolu_hook_test");
    expect(parsed.session_id).toBe("sess-hook");
    expect(parsed.agent_id).toBe("agent-hook");
    expect(parsed.agent_type).toBe("sub");
    // tool_input is stringified by jq tostring, so it becomes the JSON string
    expect(typeof parsed.tool_input).toBe("string");
    expect(typeof parsed.tool_response).toBe("string");
  });

  test("hook script truncation — large values truncated to 4096 bytes", async () => {
    const scriptPath = join(
      import.meta.dir,
      "..",
      "scripts",
      "hooks",
      "wtf-post-tool-use.sh"
    );

    // Create input with values larger than 4096 bytes.
    const largeString = "x".repeat(8192);
    const hookInput = JSON.stringify({
      tool_name: "Bash",
      tool_input: largeString,
      tool_response: largeString,
      tool_use_id: "toolu_trunc",
      session_id: "sess-trunc",
      agent_id: "",
      agent_type: "",
    });

    const outputDir = join(tempDir, ".wtf");
    const outputFile = join(outputDir, "hook-queue.jsonl");

    const proc = Bun.spawn(["bash", scriptPath], {
      stdin: new Response(hookInput),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: tempDir },
    });

    await proc.exited;

    const output = readFileSync(outputFile, "utf-8").trim();
    const parsed = JSON.parse(output);

    expect(parsed.tool_input.length).toBeLessThanOrEqual(4096);
    expect(parsed.tool_response.length).toBeLessThanOrEqual(4096);
  });
});
