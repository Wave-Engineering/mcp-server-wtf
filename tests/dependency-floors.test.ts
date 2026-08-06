/**
 * Vulnerable dependencies stay fixed (#30).
 *
 * Three HIGH advisories were live here:
 *   fast-uri    CVE-2026-16221  (fixed 3.1.4)
 *   fast-uri    CVE-2026-18446  (fixed 3.1.5)
 *   ip-address  CVE-2026-69192  (fixed 10.3.1)
 *
 * The issue asked for fast-uri 3.1.4, which still leaves CVE-2026-18446 live —
 * the two advisories have different fixed versions and only the later one covers
 * both.
 *
 * **This reads the INSTALLED TREE, not the lockfile.** `trivy` parses `bun.lock`
 * and is therefore structurally blind to a vulnerable copy nested under a parent
 * whose declared range excludes the fix: the top-level entry reads fixed, the
 * scan agrees, and the CVE is live. That is precisely how a bump becomes
 * cosmetic, and `ip-address` was one range away from it here —
 * express-rate-limit <8.6.0 pinned it at EXACTLY 10.1.0, so forcing a fix
 * without also bumping the parent would have produced a private nested copy.
 *
 * The probe is validated against a planted nested copy before its zeroes are
 * trusted: a probe that has only ever run on a clean tree has not been tested.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const NODE_MODULES = join(REPO, "node_modules");

/** Every installed copy of `pkg`, at any depth, by reading `name` from the file. */
function installedVersions(pkg: string): { version: string; path: string }[] {
  const found: { version: string; path: string }[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p, depth + 1);
      } else if (e === "package.json") {
        try {
          const d = JSON.parse(readFileSync(p, "utf8"));
          // Identity comes from `name` in the file — NEVER from the path. Path
          // matching fails in both directions: `*/node_modules/` matches an
          // absolute prefix, and a package's own `benchmark/package.json`
          // declares a different version of the same-looking thing.
          if (d?.name === pkg && typeof d.version === "string") {
            found.push({ version: d.version, path: p });
          }
        } catch {
          /* not a manifest we can read */
        }
      }
    }
  };

  walk(NODE_MODULES, 0);
  return found;
}

function atLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

describe("dependency floors (#30)", () => {
  test("the probe can see a NESTED copy", () => {
    // Validate the instrument before trusting its zeroes. Planted at the depth a
    // real nested copy lives at; if this is not found, every assertion below is
    // vacuous rather than reassuring.
    const nest = join(NODE_MODULES, "ajv", "node_modules", "fast-uri");
    let planted = false;
    try {
      mkdirSync(nest, { recursive: true });
      writeFileSync(
        join(nest, "package.json"),
        JSON.stringify({ name: "fast-uri", version: "0.0.1-planted" }),
      );
      planted = true;
      const hits = installedVersions("fast-uri");
      expect(hits.some((h) => h.version === "0.0.1-planted")).toBe(true);
      expect(hits.length).toBeGreaterThan(1);
    } finally {
      if (planted) rmSync(join(NODE_MODULES, "ajv", "node_modules"), { recursive: true, force: true });
    }
  });

  for (const [pkg, floor, cves] of [
    ["fast-uri", "3.1.5", "CVE-2026-16221 (3.1.4), CVE-2026-18446 (3.1.5)"],
    ["ip-address", "10.3.1", "CVE-2026-69192"],
  ] as const) {
    test(`${pkg} is at or above ${floor} in EVERY installed copy — ${cves}`, () => {
      const hits = installedVersions(pkg);
      // A zero here would mean the dependency chain vanished rather than that
      // the pin held — chain-absence wearing a pass's clothes.
      expect(hits.length).toBeGreaterThan(0);
      const bad = hits.filter((h) => !atLeast(h.version, floor));
      expect(bad).toEqual([]);
    });
  }

  test("express-rate-limit is new enough to ACCEPT a fixed ip-address", () => {
    // <8.6.0 pinned ip-address at exactly 10.1.0. Overriding ip-address without
    // this bump forces a version the parent does not declare, which is how a
    // private nested copy appears and the fix becomes cosmetic.
    const hits = installedVersions("express-rate-limit");
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(atLeast(h.version, "8.6.0")).toBe(true);
  });

  test("the floors are DECLARED, not just currently resolved", () => {
    // A lockfile that happens to resolve high is not a constraint; the next
    // `bun install` can walk it back without anyone noticing.
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    const o = pkg.overrides ?? {};
    expect(o["fast-uri"]).toBeDefined();
    expect(o["ip-address"]).toBeDefined();
    expect(o["express-rate-limit"]).toBeDefined();
  });
});
