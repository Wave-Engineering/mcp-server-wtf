/**
 * Unit tests for runbook generation in the wtf_happened tool.
 *
 * Tests cover distilled entry usage, noise filtering, runbook file
 * creation, section structure, graceful handling of missing theories,
 * and chronological ordering of resolution steps.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, resetDb } from "../db";
import { handleHappened, buildRunbook } from "../tools/happened";

/** Helper: create a temp directory and return its runbook path. */
function makeTempRunbook(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "wtf-runbook-test-"));
  return { dir, path: join(dir, "runbook.md") };
}

/** Helper: seed an incident and return its id. */
function seedIncident(title: string): number {
  const db = getDb(":memory:");
  db.run(
    "INSERT INTO incidents (title, status) VALUES (?, 'active')",
    [title],
  );
  return (
    db
      .query("SELECT id FROM incidents WHERE status = 'active' LIMIT 1")
      .get() as { id: number }
  ).id;
}

/**
 * Helper: insert a raw entry and matching distilled entry.
 * Returns the distilled entry id.
 */
function seedDistilledEntry(
  incidentId: number,
  actionType: string,
  summary: string,
  ts: string,
  isNoise = false,
): number {
  const db = getDb(":memory:");

  db.run(
    "INSERT INTO raw_entries (incident_id, gen_type, action_type, text, ts) VALUES (?, 'crafted', ?, ?, ?)",
    [incidentId, actionType === "noise" ? null : actionType, summary, ts],
  );
  const rawId = (
    db.query("SELECT id FROM raw_entries ORDER BY id DESC LIMIT 1").get() as {
      id: number;
    }
  ).id;

  db.run(
    "INSERT INTO distilled_entries (raw_id, incident_id, ts, action_type, summary, is_noise) VALUES (?, ?, ?, ?, ?, ?)",
    [rawId, incidentId, ts, actionType, summary, isNoise ? 1 : 0],
  );
  return (
    db
      .query("SELECT id FROM distilled_entries ORDER BY id DESC LIMIT 1")
      .get() as { id: number }
  ).id;
}

describe("wtf_happened runbook generation", () => {
  let tempDir: string;
  let runbookPath: string;

  beforeEach(() => {
    resetDb();
    const tmp = makeTempRunbook();
    tempDir = tmp.dir;
    runbookPath = tmp.path;
  });

  afterEach(() => {
    resetDb();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("distilled entries are used when available", () => {
    const incidentId = seedIncident("Distilled Runbook Test");
    seedDistilledEntry(incidentId, "breadcrumb", "Server returned 503", "2025-01-15T10:00:00.000");
    seedDistilledEntry(incidentId, "action", "Restarted nginx", "2025-01-15T10:05:00.000");

    const result = handleHappened({}, ":memory:", { runbookPath });
    const text = result.content[0].text;

    // Timeline should use distilled entries (no raw fallback notice)
    expect(text).not.toContain("Classifier has not processed");
    expect(text).toContain("Distilled Runbook Test");

    // Runbook file should exist and contain distilled summaries
    const runbook = readFileSync(runbookPath, "utf-8");
    expect(runbook).toContain("Server returned 503");
    expect(runbook).toContain("Restarted nginx");
  });

  test("noise entries are excluded from runbook", () => {
    const incidentId = seedIncident("Noise Filter Test");
    seedDistilledEntry(incidentId, "breadcrumb", "CPU spike observed", "2025-01-15T10:00:00.000");
    seedDistilledEntry(incidentId, "noise", "Routine heartbeat check", "2025-01-15T10:01:00.000", true);
    seedDistilledEntry(incidentId, "action", "Scaled up replicas", "2025-01-15T10:05:00.000");

    handleHappened({}, ":memory:", { runbookPath });

    const runbook = readFileSync(runbookPath, "utf-8");
    expect(runbook).toContain("CPU spike observed");
    expect(runbook).toContain("Scaled up replicas");
    expect(runbook).not.toContain("Routine heartbeat check");
  });

  test(".wtf/runbook.md is created on every call", () => {
    const incidentId = seedIncident("File Creation Test");
    seedDistilledEntry(incidentId, "breadcrumb", "Something happened", "2025-01-15T10:00:00.000");

    expect(existsSync(runbookPath)).toBe(false);

    handleHappened({}, ":memory:", { runbookPath });

    expect(existsSync(runbookPath)).toBe(true);
  });

  test("runbook has all 4 sections: Problem, Root Cause, Resolution, Verification", () => {
    const incidentId = seedIncident("Full Sections Test");
    seedDistilledEntry(incidentId, "breadcrumb", "Alert fired for high latency", "2025-01-15T10:00:00.000");
    seedDistilledEntry(incidentId, "theory", "Database connection pool exhausted", "2025-01-15T10:02:00.000");
    seedDistilledEntry(incidentId, "action", "Increased pool size to 50", "2025-01-15T10:05:00.000");
    seedDistilledEntry(incidentId, "action", "Deployed config change", "2025-01-15T10:06:00.000");
    seedDistilledEntry(incidentId, "breadcrumb", "Latency returned to normal", "2025-01-15T10:10:00.000");

    handleHappened({}, ":memory:", { runbookPath });
    const runbook = readFileSync(runbookPath, "utf-8");

    expect(runbook).toContain("## Problem");
    expect(runbook).toContain("## Root Cause");
    expect(runbook).toContain("## Resolution Steps");
    expect(runbook).toContain("## Verification");

    // Check content in each section
    expect(runbook).toContain("Alert fired for high latency");
    expect(runbook).toContain("Database connection pool exhausted");
    expect(runbook).toContain("Increased pool size to 50");
    expect(runbook).toContain("Deployed config change");
    expect(runbook).toContain("Latency returned to normal");
  });

  test("graceful handling when no theories exist", () => {
    const incidentId = seedIncident("No Theories Test");
    seedDistilledEntry(incidentId, "breadcrumb", "Service went down", "2025-01-15T10:00:00.000");
    seedDistilledEntry(incidentId, "action", "Restarted the service", "2025-01-15T10:05:00.000");

    handleHappened({}, ":memory:", { runbookPath });
    const runbook = readFileSync(runbookPath, "utf-8");

    expect(runbook).toContain("## Root Cause");
    expect(runbook).toContain("No root cause theory was recorded");
  });

  test("resolution steps are chronologically ordered", () => {
    const incidentId = seedIncident("Chronological Test");
    // Insert actions with explicit timestamps to verify ordering
    seedDistilledEntry(incidentId, "breadcrumb", "Problem observed", "2025-01-15T10:00:00.000");
    seedDistilledEntry(incidentId, "action", "Step 1: Checked logs", "2025-01-15T10:01:00.000");
    seedDistilledEntry(incidentId, "action", "Step 2: Identified root cause", "2025-01-15T10:02:00.000");
    seedDistilledEntry(incidentId, "action", "Step 3: Applied fix", "2025-01-15T10:03:00.000");
    seedDistilledEntry(incidentId, "action", "Step 4: Verified fix", "2025-01-15T10:04:00.000");

    handleHappened({}, ":memory:", { runbookPath });
    const runbook = readFileSync(runbookPath, "utf-8");

    // Extract resolution steps section
    const resolutionMatch = runbook.match(/## Resolution Steps\n([\s\S]*?)(?=\n## |$)/);
    expect(resolutionMatch).not.toBeNull();
    const resolutionSection = resolutionMatch![1];

    // Verify numbered and chronological
    expect(resolutionSection).toContain("1. Step 1: Checked logs");
    expect(resolutionSection).toContain("2. Step 2: Identified root cause");
    expect(resolutionSection).toContain("3. Step 3: Applied fix");
    expect(resolutionSection).toContain("4. Step 4: Verified fix");

    // Verify ordering by checking index positions
    const idx1 = resolutionSection.indexOf("Step 1");
    const idx2 = resolutionSection.indexOf("Step 2");
    const idx3 = resolutionSection.indexOf("Step 3");
    const idx4 = resolutionSection.indexOf("Step 4");
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
    expect(idx3).toBeLessThan(idx4);
  });

  test("runbook includes incident title", () => {
    const incidentId = seedIncident("DNS Resolution Failure");
    seedDistilledEntry(incidentId, "breadcrumb", "DNS lookups timing out", "2025-01-15T10:00:00.000");

    handleHappened({}, ":memory:", { runbookPath });
    const runbook = readFileSync(runbookPath, "utf-8");

    expect(runbook).toContain("# Runbook — DNS Resolution Failure");
  });

  test("runbook includes generation timestamp", () => {
    const incidentId = seedIncident("Timestamp Test");
    seedDistilledEntry(incidentId, "breadcrumb", "Something happened", "2025-01-15T10:00:00.000");

    const before = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
    handleHappened({}, ":memory:", { runbookPath });
    const runbook = readFileSync(runbookPath, "utf-8");

    expect(runbook).toContain("_Generated:");
    // Timestamp should contain today's date prefix
    expect(runbook).toContain(before);
  });

  test("tool response includes path to runbook file", () => {
    const incidentId = seedIncident("Response Path Test");
    seedDistilledEntry(incidentId, "breadcrumb", "Error observed", "2025-01-15T10:00:00.000");

    const result = handleHappened({}, ":memory:", { runbookPath });
    const text = result.content[0].text;

    expect(text).toContain("Runbook written to");
    expect(text).toContain(runbookPath);
  });

  test("runbook with only raw entries produces empty-section runbook", () => {
    // When there are no distilled entries, the runbook should still be
    // generated but with graceful empty-section messages
    const db = getDb(":memory:");
    db.run(
      "INSERT INTO incidents (title, status) VALUES ('Raw Only Test', 'active')",
    );
    const incidentId = (
      db
        .query("SELECT id FROM incidents WHERE status = 'active' LIMIT 1")
        .get() as { id: number }
    ).id;
    // Only raw entries, no distilled
    db.run(
      "INSERT INTO raw_entries (incident_id, gen_type, action_type, text) VALUES (?, 'crafted', 'breadcrumb', 'raw breadcrumb')",
      [incidentId],
    );

    handleHappened({}, ":memory:", { runbookPath });
    const runbook = readFileSync(runbookPath, "utf-8");

    // All sections should have graceful empty messages since no distilled entries
    expect(runbook).toContain("No problem breadcrumbs were recorded.");
    expect(runbook).toContain("No root cause theory was recorded.");
    expect(runbook).toContain("No resolution actions were recorded.");
    expect(runbook).toContain("No post-resolution verification was recorded.");
  });

  test("verification section contains only breadcrumbs after last action", () => {
    const incidentId = seedIncident("Verification Split Test");
    // Breadcrumb before actions -> Problem
    seedDistilledEntry(incidentId, "breadcrumb", "Initial symptom", "2025-01-15T10:00:00.000");
    // Action
    seedDistilledEntry(incidentId, "action", "Applied fix", "2025-01-15T10:05:00.000");
    // Breadcrumb after action -> Verification
    seedDistilledEntry(incidentId, "breadcrumb", "Confirmed fix worked", "2025-01-15T10:10:00.000");
    seedDistilledEntry(incidentId, "breadcrumb", "Monitoring stable", "2025-01-15T10:15:00.000");

    handleHappened({}, ":memory:", { runbookPath });
    const runbook = readFileSync(runbookPath, "utf-8");

    // Problem section should contain the pre-action breadcrumb
    const problemMatch = runbook.match(/## Problem\n([\s\S]*?)(?=\n## )/);
    expect(problemMatch).not.toBeNull();
    expect(problemMatch![1]).toContain("Initial symptom");
    expect(problemMatch![1]).not.toContain("Confirmed fix worked");

    // Verification section should contain post-action breadcrumbs
    const verifyMatch = runbook.match(/## Verification\n([\s\S]*?)$/);
    expect(verifyMatch).not.toBeNull();
    expect(verifyMatch![1]).toContain("Confirmed fix worked");
    expect(verifyMatch![1]).toContain("Monitoring stable");
    expect(verifyMatch![1]).not.toContain("Initial symptom");
  });
});

describe("buildRunbook (unit)", () => {
  test("produces valid markdown with all sections", () => {
    const rows = [
      { id: 1, ts: "2025-01-15T10:00:00.000", action_type: "breadcrumb", summary: "Problem A" },
      { id: 2, ts: "2025-01-15T10:01:00.000", action_type: "theory", summary: "Theory A" },
      { id: 3, ts: "2025-01-15T10:02:00.000", action_type: "action", summary: "Action A" },
      { id: 4, ts: "2025-01-15T10:10:00.000", action_type: "breadcrumb", summary: "Verify A" },
    ];

    const md = buildRunbook("Test Incident", rows);

    expect(md).toContain("# Runbook — Test Incident");
    expect(md).toContain("## Problem");
    expect(md).toContain("- Problem A");
    expect(md).toContain("## Root Cause");
    expect(md).toContain("- Theory A");
    expect(md).toContain("## Resolution Steps");
    expect(md).toContain("1. Action A");
    expect(md).toContain("## Verification");
    expect(md).toContain("- Verify A");
  });

  test("empty entries produce graceful placeholders", () => {
    const md = buildRunbook("Empty Incident", []);

    expect(md).toContain("No problem breadcrumbs were recorded.");
    expect(md).toContain("No root cause theory was recorded.");
    expect(md).toContain("No resolution actions were recorded.");
    expect(md).toContain("No post-resolution verification was recorded.");
  });
});
