/**
 * Unit tests for the wtf_happened tool handler.
 *
 * Tests cover empty state, raw fallback, summary 50-line cap,
 * full mode, duration calculation, and Markdown format.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getDb, resetDb } from "../db";
import { handleHappened } from "../tools/happened";
import { handleNow } from "../tools/now";

describe("wtf_happened tool", () => {
  beforeEach(() => {
    resetDb();
  });

  afterEach(() => {
    resetDb();
  });

  test("empty state — no active incident returns meaningful message", () => {
    getDb(":memory:");

    const result = handleHappened({}, ":memory:");

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No active or suspended incident found");
    expect(result.content[0].text).toContain("/wtf");
  });

  test("empty state — active incident with no entries returns empty message", () => {
    const db = getDb(":memory:");
    db.run("INSERT INTO incidents (title, status) VALUES ('Test Incident', 'active')");

    const result = handleHappened({}, ":memory:");

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("WTF Summary");
    expect(result.content[0].text).toContain("No entries recorded yet");
    expect(result.content[0].text).toContain("wtf_now");
  });

  test("raw fallback — shows raw entries with classifier notice", () => {
    getDb(":memory:");

    // Create some raw entries via wtf_now
    handleNow(
      { gen_type: "crafted", action_type: "breadcrumb", text: "Checked server logs" },
      ":memory:"
    );
    handleNow(
      { gen_type: "captured", tool_name: "Bash", text: "Ran diagnostic command" },
      ":memory:"
    );

    const result = handleHappened({}, ":memory:");
    const text = result.content[0].text;

    expect(result.isError).toBeUndefined();
    expect(text).toContain("Classifier has not processed entries yet");
    expect(text).toContain("BREADCRUMB");
    expect(text).toContain("Checked server logs");
    expect(text).toContain("Ran diagnostic command");
  });

  test("raw fallback — entries without action_type use tool_name or ENTRY", () => {
    getDb(":memory:");

    // Entry with tool_name but no action_type
    handleNow(
      { gen_type: "captured", tool_name: "Grep", text: "Searched for errors" },
      ":memory:"
    );
    // Entry with neither action_type nor tool_name
    handleNow(
      { gen_type: "crafted", text: "Just a note" },
      ":memory:"
    );

    const result = handleHappened({}, ":memory:");
    const text = result.content[0].text;

    // First entry: no action_type, has tool_name → should show tool_name
    expect(text).toContain("Grep");
    // Second entry: no action_type, no tool_name → should show "ENTRY"
    expect(text).toContain("ENTRY");
  });

  test("summary mode — caps output at 50 lines", () => {
    getDb(":memory:");

    // Insert 60 raw entries
    for (let i = 0; i < 60; i++) {
      handleNow(
        { gen_type: "crafted", action_type: "breadcrumb", text: `Entry number ${i + 1}` },
        ":memory:"
      );
    }

    const result = handleHappened({ detail: "summary" }, ":memory:");
    const text = result.content[0].text;

    // Count numbered entry lines (pattern: "N. [HH:MM] TYPE — text")
    const entryLines = text
      .split("\n")
      .filter((line: string) => /^\d+\.\s+\[/.test(line));

    expect(entryLines.length).toBe(50);
    expect(text).toContain("truncated to 50 lines");
    expect(text).toContain('"full"');
  });

  test("summary mode — is the default when detail not specified", () => {
    getDb(":memory:");

    // Insert 60 raw entries
    for (let i = 0; i < 60; i++) {
      handleNow(
        { gen_type: "crafted", action_type: "breadcrumb", text: `Entry ${i + 1}` },
        ":memory:"
      );
    }

    // No detail argument
    const result = handleHappened({}, ":memory:");
    const text = result.content[0].text;

    const entryLines = text
      .split("\n")
      .filter((line: string) => /^\d+\.\s+\[/.test(line));

    expect(entryLines.length).toBe(50);
    expect(text).toContain("truncated to 50 lines");
  });

  test("full mode — returns all entries without truncation", () => {
    getDb(":memory:");

    // Insert 60 raw entries
    for (let i = 0; i < 60; i++) {
      handleNow(
        { gen_type: "crafted", action_type: "action", text: `Action ${i + 1}` },
        ":memory:"
      );
    }

    const result = handleHappened({ detail: "full" }, ":memory:");
    const text = result.content[0].text;

    const entryLines = text
      .split("\n")
      .filter((line: string) => /^\d+\.\s+\[/.test(line));

    expect(entryLines.length).toBe(60);
    expect(text).not.toContain("truncated");
  });

  test("duration calculation — header shows duration in minutes", () => {
    const db = getDb(":memory:");

    // Insert incident with a known started_at (30 minutes ago)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.run(
      "INSERT INTO incidents (title, started_at, status) VALUES (?, ?, 'active')",
      ["Duration Test", thirtyMinAgo]
    );

    // Add an entry so we don't hit the empty state
    const incidentId = (
      db
        .query("SELECT id FROM incidents WHERE status = 'active' LIMIT 1")
        .get() as { id: number }
    ).id;
    db.run(
      "INSERT INTO raw_entries (incident_id, ts, gen_type, text) VALUES (?, ?, 'crafted', 'test entry')",
      [incidentId, thirtyMinAgo]
    );

    const result = handleHappened({}, ":memory:");
    const text = result.content[0].text;

    // Duration should be approximately 30 min (allow +-1 for timing)
    expect(text).toContain("**Duration:**");
    const durationMatch = text.match(/\*\*Duration:\*\*\s+(\d+)\s+min/);
    expect(durationMatch).not.toBeNull();
    const duration = parseInt(durationMatch![1], 10);
    expect(duration).toBeGreaterThanOrEqual(29);
    expect(duration).toBeLessThanOrEqual(31);
  });

  test("markdown format — header includes title, duration, counts, status", () => {
    const db = getDb(":memory:");

    db.run(
      "INSERT INTO incidents (title, status) VALUES ('Network Outage', 'active')"
    );

    const incidentId = (
      db
        .query("SELECT id FROM incidents WHERE status = 'active' LIMIT 1")
        .get() as { id: number }
    ).id;
    db.run(
      "INSERT INTO raw_entries (incident_id, gen_type, action_type, text) VALUES (?, 'crafted', 'action', 'Checked DNS')",
      [incidentId]
    );

    const result = handleHappened({}, ":memory:");
    const text = result.content[0].text;

    expect(text).toContain("## WTF Summary — Network Outage");
    expect(text).toContain("**Duration:**");
    expect(text).toContain("min");
    expect(text).toContain("**Entries:**");
    expect(text).toContain("1 raw");
    expect(text).toContain("0 distilled");
    expect(text).toContain("**Status:** active");
  });

  test("markdown format — entry lines follow numbered format", () => {
    getDb(":memory:");

    handleNow(
      { gen_type: "crafted", action_type: "theory", text: "Maybe it is DNS" },
      ":memory:"
    );
    handleNow(
      { gen_type: "crafted", action_type: "action", text: "Flushed DNS cache" },
      ":memory:"
    );

    const result = handleHappened({}, ":memory:");
    const text = result.content[0].text;

    // Check line format: "N. [HH:MM] TYPE — text"
    const entryLines = text
      .split("\n")
      .filter((line: string) => /^\d+\.\s+\[/.test(line));

    expect(entryLines.length).toBe(2);
    expect(entryLines[0]).toMatch(/^1\.\s+\[\d{2}:\d{2}\]\s+THEORY\s+—\s+Maybe it is DNS$/);
    expect(entryLines[1]).toMatch(/^2\.\s+\[\d{2}:\d{2}\]\s+ACTION\s+—\s+Flushed DNS cache$/);
  });

  test("distilled entries — used when available instead of raw", () => {
    const db = getDb(":memory:");

    db.run(
      "INSERT INTO incidents (title, status) VALUES ('Distilled Test', 'active')"
    );
    const incidentId = (
      db
        .query("SELECT id FROM incidents WHERE status = 'active' LIMIT 1")
        .get() as { id: number }
    ).id;

    // Insert a raw entry
    db.run(
      "INSERT INTO raw_entries (incident_id, gen_type, text) VALUES (?, 'crafted', 'raw text')",
      [incidentId]
    );
    const rawId = (
      db
        .query("SELECT id FROM raw_entries ORDER BY id DESC LIMIT 1")
        .get() as { id: number }
    ).id;

    // Insert a distilled entry
    db.run(
      "INSERT INTO distilled_entries (raw_id, incident_id, ts, action_type, summary, is_noise) VALUES (?, ?, datetime('now'), 'action', 'Distilled summary text', 0)",
      [rawId, incidentId]
    );

    const result = handleHappened({}, ":memory:");
    const text = result.content[0].text;

    // Should show distilled content, not raw
    expect(text).toContain("Distilled summary text");
    expect(text).not.toContain("Classifier has not processed");
  });

  test("distilled entries — noise entries are excluded", () => {
    const db = getDb(":memory:");

    db.run(
      "INSERT INTO incidents (title, status) VALUES ('Noise Test', 'active')"
    );
    const incidentId = (
      db
        .query("SELECT id FROM incidents WHERE status = 'active' LIMIT 1")
        .get() as { id: number }
    ).id;

    // Insert raw entries
    db.run(
      "INSERT INTO raw_entries (incident_id, gen_type, text) VALUES (?, 'crafted', 'raw 1')",
      [incidentId]
    );
    const rawId1 = (
      db
        .query("SELECT id FROM raw_entries ORDER BY id DESC LIMIT 1")
        .get() as { id: number }
    ).id;

    db.run(
      "INSERT INTO raw_entries (incident_id, gen_type, text) VALUES (?, 'crafted', 'raw 2')",
      [incidentId]
    );
    const rawId2 = (
      db
        .query("SELECT id FROM raw_entries ORDER BY id DESC LIMIT 1")
        .get() as { id: number }
    ).id;

    // Insert one signal and one noise distilled entry
    db.run(
      "INSERT INTO distilled_entries (raw_id, incident_id, ts, action_type, summary, is_noise) VALUES (?, ?, datetime('now'), 'action', 'Important signal', 0)",
      [rawId1, incidentId]
    );
    db.run(
      "INSERT INTO distilled_entries (raw_id, incident_id, ts, action_type, summary, is_noise) VALUES (?, ?, datetime('now'), 'noise', 'Just noise', 1)",
      [rawId2, incidentId]
    );

    const result = handleHappened({}, ":memory:");
    const text = result.content[0].text;

    expect(text).toContain("Important signal");
    expect(text).not.toContain("Just noise");
  });

  test("MCP response format — content array with type text", () => {
    getDb(":memory:");

    handleNow({ gen_type: "crafted", text: "test" }, ":memory:");

    const result = handleHappened({}, ":memory:");

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBe(1);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
  });
});
