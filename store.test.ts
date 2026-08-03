import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveStoreDir, storePath, STORE_SUBDIR, LEGACY_STORE_SUBDIR } from "./store.ts";

// #29 — the recorder's data must live inside the durable `.claude/` boundary.
// At the project root it sat OUTSIDE the host-backed dir, so `docker rm` would
// destroy an incident timeline exactly when you most want it.
//
// Every case below is built against a real temp tree rather than mocked `fs`:
// the whole behaviour IS filesystem resolution, and a mocked existsSync would
// assert only that the code calls the function I told it to call.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wtf-store-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveStoreDir (#29)", () => {
  test("fresh project resolves to .claude/wtf, not the project root", () => {
    const r = resolveStoreDir(root);
    expect(r.dir).toBe(join(root, STORE_SUBDIR));
    expect(r.legacy).toBe(false);
  });

  test("a legacy .wtf/ is still readable — an in-flight incident is not orphaned", () => {
    mkdirSync(join(root, LEGACY_STORE_SUBDIR), { recursive: true });
    const r = resolveStoreDir(root);
    expect(r.dir).toBe(join(root, LEGACY_STORE_SUBDIR));
    expect(r.legacy).toBe(true);
  });

  test("both present → the NEW path wins", () => {
    // Order matters: if legacy were checked first, a migrated project would
    // silently revert to reading stale data it had already moved past.
    mkdirSync(join(root, LEGACY_STORE_SUBDIR), { recursive: true });
    mkdirSync(join(root, STORE_SUBDIR), { recursive: true });
    const r = resolveStoreDir(root);
    expect(r.dir).toBe(join(root, STORE_SUBDIR));
    expect(r.legacy).toBe(false);
  });

  test("resolving does NOT create anything by default", () => {
    // A read path that manufactures a directory would (a) litter every project
    // it looked at, and (b) make the legacy fallback unreachable forever —
    // rule 1 would always match a dir we had just created ourselves.
    resolveStoreDir(root);
    expect(existsSync(join(root, STORE_SUBDIR))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  test("create:true makes the new path, never the legacy one", () => {
    resolveStoreDir(root, { create: true });
    expect(existsSync(join(root, STORE_SUBDIR))).toBe(true);
    expect(existsSync(join(root, LEGACY_STORE_SUBDIR))).toBe(false);
  });

  test("create:true against a legacy-only project does NOT migrate or write anew", () => {
    // The fallback is read compatibility. Writing into .claude/wtf here would
    // split one incident across two stores mid-investigation.
    mkdirSync(join(root, LEGACY_STORE_SUBDIR), { recursive: true });
    const r = resolveStoreDir(root, { create: true });
    expect(r.dir).toBe(join(root, LEGACY_STORE_SUBDIR));
    expect(existsSync(join(root, STORE_SUBDIR))).toBe(false);
  });

  test("storePath composes onto the resolved dir", () => {
    expect(storePath("wtf.db", root)).toBe(join(root, STORE_SUBDIR, "wtf.db"));
    mkdirSync(join(root, LEGACY_STORE_SUBDIR), { recursive: true });
    expect(storePath("wtf.db", root)).toBe(join(root, LEGACY_STORE_SUBDIR, "wtf.db"));
  });

  test("the project root gains no .wtf/ — the clutter half of #29", () => {
    storePath("wtf.db", root, { create: true });
    storePath("hook-queue.jsonl", root, { create: true });
    storePath("runbook.md", root, { create: true });
    expect(existsSync(join(root, LEGACY_STORE_SUBDIR))).toBe(false);
  });

  test("recorder output is gitignored at the new path — asked of git, not of the file", async () => {
    // `.claude/` is not universally ignored (cc-workflow tracks .claude/plans),
    // so the new store needs its own rule or recorder data becomes stageable.
    //
    // Asks GIT whether the path is ignored rather than grepping .gitignore for a
    // substring. A text match proves a line exists; it does not prove the line
    // matches, is not overridden by a later negation, or covers the files the
    // recorder actually writes. Same distinction as parsing a workflow instead
    // of grepping it.
    const repo = import.meta.dir;
    for (const f of [
      ".claude/wtf/wtf.db",
      ".claude/wtf/runbook.md",
      ".claude/wtf/hook-queue.jsonl",
    ]) {
      const proc = Bun.spawn(["git", "check-ignore", "-q", f], {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      expect(proc.exitCode, `${f} is not ignored by git`).toBe(0);
    }
  });

  test("survives container replacement when .claude/ is host-backed", () => {
    // Simulate the cut-over: `.claude/` is the host-backed dir, everything else
    // is container-local and vanishes with `docker rm`.
    storePath("wtf.db", root, { create: true });
    writeFileSync(join(root, STORE_SUBDIR, "wtf.db"), "incident");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "ephemeral"), "container-local");

    // "docker rm": everything outside the host-backed .claude/ is destroyed.
    rmSync(join(root, "src"), { recursive: true, force: true });

    const r = resolveStoreDir(root);
    expect(r.dir).toBe(join(root, STORE_SUBDIR));
    expect(existsSync(join(r.dir, "wtf.db"))).toBe(true);
  });
});
