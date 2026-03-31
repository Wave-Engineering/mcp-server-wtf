import { describe, test, expect, beforeEach } from "bun:test";
import { handleImout } from "../tools/imout";
import { getDb, resetDb } from "../db";

describe("wtf_imout tool", () => {
  beforeEach(() => {
    resetDb();
  });

  test("no active incident returns ok: false", () => {
    getDb(":memory:");

    const result = handleImout(":memory:");

    expect(result.ok).toBe(false);
    expect(result.incident_id).toBeNull();
    expect(result.message).toContain("No active incident");
  });

  test("suspends active incident successfully", () => {
    const db = getDb(":memory:");
    db.run("INSERT INTO incidents (title, status) VALUES ('Test', 'active')");

    const result = handleImout(":memory:");

    expect(result.ok).toBe(true);
    expect(result.incident_id).toBe(1);
    expect(result.message).toContain("suspended");

    // Verify status changed to suspended
    const incident = db
      .query("SELECT status FROM incidents WHERE id = 1")
      .get() as { status: string };
    expect(incident.status).toBe("suspended");
  });

  test("sets ended_at timestamp when suspending", () => {
    const db = getDb(":memory:");
    db.run("INSERT INTO incidents (title, status) VALUES ('Test', 'active')");

    handleImout(":memory:");

    const incident = db
      .query("SELECT ended_at FROM incidents WHERE id = 1")
      .get() as { ended_at: string | null };

    expect(incident.ended_at).not.toBeNull();
    expect(incident.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  test("suspends most recent active incident when multiple exist", () => {
    const db = getDb(":memory:");
    db.run("INSERT INTO incidents (title, status) VALUES ('Old', 'archived')");
    db.run("INSERT INTO incidents (title, status) VALUES ('Active1', 'active')");
    db.run("INSERT INTO incidents (title, status) VALUES ('Active2', 'active')");

    const result = handleImout(":memory:");

    expect(result.ok).toBe(true);
    expect(result.incident_id).toBe(3); // Most recent active incident

    // Verify only incident #3 was suspended
    const incidents = db
      .query("SELECT id, status FROM incidents ORDER BY id")
      .all() as Array<{ id: number; status: string }>;

    expect(incidents[0].status).toBe("archived"); // ID 1 unchanged
    expect(incidents[1].status).toBe("active"); // ID 2 unchanged
    expect(incidents[2].status).toBe("suspended"); // ID 3 suspended
  });

  test("returns correct JSON structure", () => {
    const db = getDb(":memory:");
    db.run("INSERT INTO incidents (status) VALUES ('active')");

    const result = handleImout(":memory:");

    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("incident_id");
    expect(result).toHaveProperty("message");
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.incident_id).toBe("number");
    expect(typeof result.message).toBe("string");
  });
});
