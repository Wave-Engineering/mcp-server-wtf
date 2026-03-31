/**
 * Unit tests for the wtf_freshell tool handler.
 *
 * Tests cover archiving with entries, new incident creation, entry counting,
 * title application, no-active-incident case, ended_at timestamp, and the
 * single-active-incident constraint.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getDb, resetDb } from "../db";
import { handleFreshell } from "../tools/freshell";
import { handleNow } from "../tools/now";

describe("wtf_freshell tool", () => {
  beforeEach(() => {
    resetDb();
  });

  afterEach(() => {
    resetDb();
  });

  test("archive with entries — archives active incident and returns correct entry count", () => {
    const db = getDb(":memory:");

    // Create an active incident with some entries via wtf_now
    handleNow({ gen_type: "crafted", text: "entry one" }, ":memory:");
    handleNow({ gen_type: "crafted", text: "entry two" }, ":memory:");
    handleNow({ gen_type: "captured", tool_name: "Bash", text: "entry three" }, ":memory:");

    const result = handleFreshell({}, ":memory:");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.archived_entries).toBe(3);
    expect(typeof parsed.new_incident_id).toBe("number");
  });

  test("new incident creation — creates a new active incident after archiving", () => {
    const db = getDb(":memory:");

    // Create initial incident
    handleNow({ gen_type: "crafted", text: "first entry" }, ":memory:");

    const result = handleFreshell({}, ":memory:");
    const parsed = JSON.parse(result.content[0].text);

    // Verify the new incident exists and is active
    const newIncident = db
      .query("SELECT * FROM incidents WHERE id = ?")
      .get(parsed.new_incident_id) as Record<string, unknown>;

    expect(newIncident).toBeDefined();
    expect(newIncident.status).toBe("active");
    expect(newIncident.ended_at).toBeNull();
  });

  test("entry count — archived_entries matches actual raw_entries count", () => {
    const db = getDb(":memory:");

    // Create incident and add exactly 5 entries
    handleNow({ gen_type: "crafted", text: "a" }, ":memory:");
    handleNow({ gen_type: "crafted", text: "b" }, ":memory:");
    handleNow({ gen_type: "crafted", text: "c" }, ":memory:");
    handleNow({ gen_type: "captured", tool_name: "Read", text: "d" }, ":memory:");
    handleNow({ gen_type: "captured", tool_name: "Edit", text: "e" }, ":memory:");

    // Get the incident id before archiving
    const activeIncident = db
      .query("SELECT id FROM incidents WHERE status = 'active'")
      .get() as { id: number };

    // Verify raw_entries count directly
    const directCount = db
      .query("SELECT COUNT(*) as count FROM raw_entries WHERE incident_id = ?")
      .get(activeIncident.id) as { count: number };
    expect(directCount.count).toBe(5);

    const result = handleFreshell({}, ":memory:");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.archived_entries).toBe(5);
  });

  test("title — optional title is stored on the archived incident", () => {
    const db = getDb(":memory:");

    // Create an active incident
    handleNow({ gen_type: "crafted", text: "some entry" }, ":memory:");

    const activeIncident = db
      .query("SELECT id FROM incidents WHERE status = 'active'")
      .get() as { id: number };

    handleFreshell({ title: "DNS resolution failure" }, ":memory:");

    // Verify title was stored on the archived incident
    const archived = db
      .query("SELECT * FROM incidents WHERE id = ?")
      .get(activeIncident.id) as Record<string, unknown>;

    expect(archived.title).toBe("DNS resolution failure");
    expect(archived.status).toBe("archived");
  });

  test("no-active case — creates a new incident with zero archived entries", () => {
    const db = getDb(":memory:");

    // No incident exists yet — call freshell directly
    const result = handleFreshell({}, ":memory:");
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.archived_entries).toBe(0);
    expect(typeof parsed.new_incident_id).toBe("number");

    // Verify a single active incident now exists
    const incidents = db
      .query("SELECT * FROM incidents WHERE status = 'active'")
      .all() as Array<Record<string, unknown>>;
    expect(incidents.length).toBe(1);
  });

  test("ended_at — archived incident has a non-null ended_at timestamp", () => {
    const db = getDb(":memory:");

    // Create an active incident
    handleNow({ gen_type: "crafted", text: "timestamp test" }, ":memory:");

    const activeIncident = db
      .query("SELECT id FROM incidents WHERE status = 'active'")
      .get() as { id: number };

    handleFreshell({}, ":memory:");

    const archived = db
      .query("SELECT * FROM incidents WHERE id = ?")
      .get(activeIncident.id) as Record<string, unknown>;

    expect(archived.ended_at).not.toBeNull();
    expect(typeof archived.ended_at).toBe("string");
    // Verify it looks like an ISO timestamp
    expect(archived.ended_at as string).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
    );
  });

  test("single active constraint — only one active incident exists after freshell", () => {
    const db = getDb(":memory:");

    // Create first incident with entries
    handleNow({ gen_type: "crafted", text: "first incident entry" }, ":memory:");

    // Run freshell to archive and create new
    handleFreshell({}, ":memory:");

    // Add entries to new incident
    handleNow({ gen_type: "crafted", text: "second incident entry" }, ":memory:");

    // Run freshell again
    handleFreshell({ title: "Second round" }, ":memory:");

    // There should be exactly one active incident
    const activeIncidents = db
      .query("SELECT * FROM incidents WHERE status = 'active'")
      .all() as Array<Record<string, unknown>>;
    expect(activeIncidents.length).toBe(1);

    // There should be exactly two archived incidents
    const archivedIncidents = db
      .query("SELECT * FROM incidents WHERE status = 'archived'")
      .all() as Array<Record<string, unknown>>;
    expect(archivedIncidents.length).toBe(2);

    // Total: 3 incidents (2 archived + 1 active)
    const total = db
      .query("SELECT COUNT(*) as count FROM incidents")
      .get() as { count: number };
    expect(total.count).toBe(3);
  });

  test("MCP response format — content array with type and text", () => {
    getDb(":memory:");

    const result = handleFreshell({}, ":memory:");

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBe(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty("ok");
    expect(parsed).toHaveProperty("archived_entries");
    expect(parsed).toHaveProperty("new_incident_id");
  });
});
