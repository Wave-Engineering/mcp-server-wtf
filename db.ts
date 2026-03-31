/**
 * SQLite database module for WTF Server.
 *
 * Provides a singleton database connection with WAL mode enabled
 * and schema initialization for incidents, raw_entries, and
 * distilled_entries tables.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

let _db: Database | null = null;
let _dbPath: string | null = null;

/**
 * Initialize the database schema — creates all three tables
 * and indexes if they don't already exist.
 *
 * MIGRATION NOTE: The incidents table CHECK constraint was updated to include
 * 'suspended' status (previously only 'active' and 'archived'). SQLite's
 * CREATE TABLE IF NOT EXISTS does not alter existing tables, so databases
 * created before this change will reject 'suspended' values.
 *
 * Migration path: Delete existing .wtf/wtf.db file to recreate with new schema.
 * All historical data will be lost, but this is acceptable for a flight recorder
 * system focused on current troubleshooting sessions.
 */
function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT,
        started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        ended_at    TEXT,
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_entries (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id    INTEGER NOT NULL REFERENCES incidents(id),
        ts             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
        gen_type       TEXT NOT NULL CHECK (gen_type IN ('crafted', 'captured')),
        action_type    TEXT CHECK (action_type IN ('action', 'breadcrumb', 'theory') OR action_type IS NULL),
        text           TEXT,
        tool_name      TEXT,
        tool_input     TEXT,
        tool_response  TEXT,
        tool_use_id    TEXT,
        agent_id       TEXT,
        agent_type     TEXT,
        session_id     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_raw_incident ON raw_entries(incident_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS distilled_entries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_id          INTEGER NOT NULL REFERENCES raw_entries(id),
        incident_id     INTEGER NOT NULL REFERENCES incidents(id),
        ts              TEXT NOT NULL,
        action_type     TEXT NOT NULL CHECK (action_type IN ('action', 'breadcrumb', 'theory', 'noise')),
        summary         TEXT NOT NULL,
        is_noise        INTEGER NOT NULL DEFAULT 0,
        classified_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_distilled_incident ON distilled_entries(incident_id);
    CREATE INDEX IF NOT EXISTS idx_distilled_not_noise ON distilled_entries(incident_id) WHERE is_noise = 0;
  `);
}

/**
 * Open (or return the existing) SQLite database connection.
 *
 * @param dbPath - Path to the database file, or ":memory:" for an
 *                 in-memory database.  Defaults to `.wtf/wtf.db`
 *                 relative to the project root.
 * @returns The singleton Database instance.
 */
export function getDb(dbPath?: string): Database {
  const resolvedPath = dbPath ?? `${process.cwd()}/.wtf/wtf.db`;

  // Return the cached singleton if the path matches.
  if (_db !== null && _dbPath === resolvedPath) {
    return _db;
  }

  // Ensure the parent directory exists for file-backed databases.
  if (resolvedPath !== ":memory:") {
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolvedPath);

  // Enable WAL mode for concurrent read/write access.
  db.exec("PRAGMA journal_mode=WAL");

  initSchema(db);

  _db = db;
  _dbPath = resolvedPath;

  return db;
}

/**
 * Reset the singleton — used only by tests to ensure a fresh
 * database on each test run.
 */
export function resetDb(): void {
  if (_db !== null) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}
