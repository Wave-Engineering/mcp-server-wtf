/**
 * Unit tests for the wtf_now tool handler.
 *
 * Tests cover crafted entries, captured entries, auto-creation of
 * incidents, invalid gen_type, optional action_type, and timestamps.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getDb, resetDb } from "../db";
import { handleNow, getOrCreateActiveIncident } from "../tools/now";

describe("wtf_now tool", () => {
  beforeEach(() => {
    resetDb();
  });

  afterEach(() => {
    resetDb();
  });

  test("crafted entry — persists all fields to raw_entries", () => {
    const db = getDb(":memory:");

    const result = handleNow(
      {
        gen_type: "crafted",
        action_type: "breadcrumb",
        text: "Found a suspicious log line in syslog",
        session_id: "sess-001",
      },
      ":memory:"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.entry_id).toBe("number");
    expect(result.isError).toBeUndefined();

    // Verify the row in raw_entries
    const row = db
      .query("SELECT * FROM raw_entries WHERE id = ?")
      .get(parsed.entry_id) as Record<string, unknown>;

    expect(row.gen_type).toBe("crafted");
    expect(row.action_type).toBe("breadcrumb");
    expect(row.text).toBe("Found a suspicious log line in syslog");
    expect(row.session_id).toBe("sess-001");
    expect(row.incident_id).toBeDefined();
  });

  test("captured entry — persists tool fields correctly", () => {
    const db = getDb(":memory:");

    const result = handleNow(
      {
        gen_type: "captured",
        tool_name: "Bash",
        tool_input: '{"command": "ls -la"}',
        tool_response: "total 48\ndrwxr-xr-x ...",
        tool_use_id: "toolu_abc123",
        agent_id: "agent-42",
        agent_type: "main",
        session_id: "sess-002",
      },
      ":memory:"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.entry_id).toBe("number");

    const row = db
      .query("SELECT * FROM raw_entries WHERE id = ?")
      .get(parsed.entry_id) as Record<string, unknown>;

    expect(row.gen_type).toBe("captured");
    expect(row.tool_name).toBe("Bash");
    expect(row.tool_input).toBe('{"command": "ls -la"}');
    expect(row.tool_response).toBe("total 48\ndrwxr-xr-x ...");
    expect(row.tool_use_id).toBe("toolu_abc123");
    expect(row.agent_id).toBe("agent-42");
    expect(row.agent_type).toBe("main");
    expect(row.session_id).toBe("sess-002");
  });

  test("auto-create incident — creates one when none exists", () => {
    const db = getDb(":memory:");

    // Verify no incidents exist
    const before = db
      .query("SELECT COUNT(*) as count FROM incidents")
      .get() as { count: number };
    expect(before.count).toBe(0);

    handleNow({ gen_type: "crafted", text: "first entry" }, ":memory:");

    // Should now have exactly one active incident
    const after = db
      .query("SELECT * FROM incidents WHERE status = 'active'")
      .all() as Array<Record<string, unknown>>;
    expect(after.length).toBe(1);
    expect(after[0].status).toBe("active");
  });

  test("auto-create incident — reuses existing active incident", () => {
    const db = getDb(":memory:");

    // Create first entry (auto-creates incident)
    handleNow({ gen_type: "crafted", text: "entry one" }, ":memory:");

    // Create second entry (should reuse the same incident)
    handleNow({ gen_type: "crafted", text: "entry two" }, ":memory:");

    // Still only one incident
    const incidents = db
      .query("SELECT * FROM incidents WHERE status = 'active'")
      .all() as Array<Record<string, unknown>>;
    expect(incidents.length).toBe(1);

    // Both entries linked to the same incident
    const entries = db
      .query("SELECT incident_id FROM raw_entries ORDER BY id")
      .all() as Array<{ incident_id: number }>;
    expect(entries.length).toBe(2);
    expect(entries[0].incident_id).toBe(entries[1].incident_id);
  });

  test("invalid gen_type — returns error response", () => {
    getDb(":memory:");

    const result = handleNow(
      { gen_type: "invalid_type" as "crafted" },
      ":memory:"
    );

    expect(result.isError).toBe(true);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid gen_type");
    expect(parsed.error).toContain("invalid_type");
  });

  test("optional action_type — entry persists without action_type", () => {
    const db = getDb(":memory:");

    const result = handleNow(
      { gen_type: "crafted", text: "no action type here" },
      ":memory:"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);

    const row = db
      .query("SELECT * FROM raw_entries WHERE id = ?")
      .get(parsed.entry_id) as Record<string, unknown>;

    expect(row.action_type).toBeNull();
    expect(row.text).toBe("no action type here");
  });

  test("optional action_type — valid action_type values are stored", () => {
    const db = getDb(":memory:");

    for (const actionType of ["action", "breadcrumb", "theory"]) {
      resetDb();
      const freshDb = getDb(":memory:");

      const result = handleNow(
        { gen_type: "crafted", action_type: actionType, text: `testing ${actionType}` },
        ":memory:"
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);

      const row = freshDb
        .query("SELECT action_type FROM raw_entries WHERE id = ?")
        .get(parsed.entry_id) as { action_type: string };
      expect(row.action_type).toBe(actionType);
    }
  });

  test("timestamps — each entry has a non-null ts field", () => {
    const db = getDb(":memory:");

    handleNow({ gen_type: "crafted", text: "timestamp test" }, ":memory:");

    const row = db
      .query("SELECT ts FROM raw_entries LIMIT 1")
      .get() as { ts: string };

    expect(row.ts).not.toBeNull();
    expect(typeof row.ts).toBe("string");
    // Verify it looks like an ISO timestamp
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("getOrCreateActiveIncident — returns existing incident id", () => {
    const db = getDb(":memory:");

    // Manually insert an active incident
    db.run("INSERT INTO incidents (status) VALUES ('active')");
    const existing = db
      .query("SELECT id FROM incidents WHERE status = 'active'")
      .get() as { id: number };

    const incidentId = getOrCreateActiveIncident(":memory:");
    expect(incidentId).toBe(existing.id);
  });

  test("getOrCreateActiveIncident — ignores archived incidents", () => {
    const db = getDb(":memory:");

    // Insert an archived incident — should not be returned
    db.run("INSERT INTO incidents (status) VALUES ('archived')");

    const incidentId = getOrCreateActiveIncident(":memory:");

    // Should have created a new active incident, not returned the archived one
    const incident = db
      .query("SELECT * FROM incidents WHERE id = ?")
      .get(incidentId) as Record<string, unknown>;
    expect(incident.status).toBe("active");

    // Total incidents: 1 archived + 1 new active = 2
    const count = db
      .query("SELECT COUNT(*) as count FROM incidents")
      .get() as { count: number };
    expect(count.count).toBe(2);
  });

  test("MCP response format — content array with type and text", () => {
    getDb(":memory:");

    const result = handleNow(
      { gen_type: "crafted", text: "format check" },
      ":memory:"
    );

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBe(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty("ok");
    expect(parsed).toHaveProperty("entry_id");
  });
});
