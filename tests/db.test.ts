/**
 * Unit tests for the WTF Server database module.
 *
 * Tests cover schema creation, WAL mode, directory creation,
 * and the singleton pattern.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, resetDb } from "../db";

describe("db module", () => {
  beforeEach(() => {
    resetDb();
  });

  afterEach(() => {
    resetDb();
  });

  test("schema creation — all three tables exist in a fresh DB", () => {
    const db = getDb(":memory:");

    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("incidents");
    expect(tableNames).toContain("raw_entries");
    expect(tableNames).toContain("distilled_entries");
  });

  test("WAL mode is enabled", () => {
    // WAL mode only works on file-backed databases, not :memory:
    const tmpDir = join(tmpdir(), `wtf-test-wal-${Date.now()}`);
    const dbPath = join(tmpDir, ".wtf", "wtf.db");

    try {
      const db = getDb(dbPath);

      const result = db.query("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(result.journal_mode).toBe("wal");
    } finally {
      resetDb();
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  test("directory creation — .wtf/ directory is created for file path", () => {
    const tmpDir = join(tmpdir(), `wtf-test-${Date.now()}`);
    const dbPath = join(tmpDir, ".wtf", "wtf.db");

    try {
      expect(existsSync(join(tmpDir, ".wtf"))).toBe(false);

      const db = getDb(dbPath);

      expect(existsSync(join(tmpDir, ".wtf"))).toBe(true);

      // Verify the database is functional
      const tables = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
        .all() as { name: string }[];
      expect(tables.length).toBe(3);
    } finally {
      resetDb();
      // Clean up the temporary directory
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  test("singleton — calling getDb twice returns the same instance", () => {
    const db1 = getDb(":memory:");
    const db2 = getDb(":memory:");

    expect(db1).toBe(db2);
  });

  test("singleton — different paths return different instances", () => {
    const tmpDir = join(tmpdir(), `wtf-test-singleton-${Date.now()}`);
    const dbPath1 = join(tmpDir, "a", "wtf.db");
    const dbPath2 = join(tmpDir, "b", "wtf.db");

    try {
      const db1 = getDb(dbPath1);
      resetDb();
      const db2 = getDb(dbPath2);

      // After reset and re-open with different path, should be a new instance
      expect(db1).not.toBe(db2);
    } finally {
      resetDb();
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  test("incidents table has correct columns", () => {
    const db = getDb(":memory:");

    const cols = db.query("PRAGMA table_info(incidents)").all() as {
      name: string;
    }[];
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain("id");
    expect(colNames).toContain("title");
    expect(colNames).toContain("started_at");
    expect(colNames).toContain("ended_at");
    expect(colNames).toContain("status");
  });

  test("raw_entries table has correct columns", () => {
    const db = getDb(":memory:");

    const cols = db.query("PRAGMA table_info(raw_entries)").all() as {
      name: string;
    }[];
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain("id");
    expect(colNames).toContain("incident_id");
    expect(colNames).toContain("ts");
    expect(colNames).toContain("gen_type");
    expect(colNames).toContain("action_type");
    expect(colNames).toContain("text");
    expect(colNames).toContain("tool_name");
    expect(colNames).toContain("tool_input");
    expect(colNames).toContain("tool_response");
    expect(colNames).toContain("tool_use_id");
    expect(colNames).toContain("agent_id");
    expect(colNames).toContain("agent_type");
    expect(colNames).toContain("session_id");
  });

  test("distilled_entries table has correct columns", () => {
    const db = getDb(":memory:");

    const cols = db.query("PRAGMA table_info(distilled_entries)").all() as {
      name: string;
    }[];
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain("id");
    expect(colNames).toContain("raw_id");
    expect(colNames).toContain("incident_id");
    expect(colNames).toContain("ts");
    expect(colNames).toContain("action_type");
    expect(colNames).toContain("summary");
    expect(colNames).toContain("is_noise");
    expect(colNames).toContain("classified_at");
  });

  test("indexes are created", () => {
    const db = getDb(":memory:");

    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_raw_incident");
    expect(indexNames).toContain("idx_distilled_incident");
    expect(indexNames).toContain("idx_distilled_not_noise");
  });
});
