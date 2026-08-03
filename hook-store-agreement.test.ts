import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveStoreDir } from "./store.ts";

// #29 — THE HOOK AND THE SERVER MUST AGREE ON WHERE THE STORE IS.
//
// The PostToolUse hook is a shell script that APPENDS the queue; store.ts
// resolves where the server READS it. They cannot share code — a shell hook
// cannot import TypeScript — so the resolution order is duplicated, and
// duplicated logic drifts.
//
// Moving one without the other splits the recorder in half: the hook appending
// to a file nothing consumes, silently, producing an incident that looks EMPTY
// rather than broken. That is the worse failure, because an empty timeline reads
// as "nothing happened" instead of "the recorder is misconfigured".
//
// So this drives the REAL hook script against a real temp project and asserts
// the file lands exactly where store.ts says it should — for every resolution
// state, not just the happy one.

const HOOK = join(import.meta.dir, "scripts", "hooks", "wtf-post-tool-use.sh");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wtf-agree-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function runHook(projectRoot: string) {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "true" },
    tool_response: { exit_code: 0 },
    tool_use_id: "t1",
    session_id: "s1",
  });
  const proc = Bun.spawn(["bash", HOOK], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode;
}

describe("hook / store agreement (#29)", () => {
  test("fresh project: the hook writes where store.ts reads", async () => {
    expect(await runHook(root)).toBe(0);
    const expected = join(resolveStoreDir(root).dir, "hook-queue.jsonl");
    expect(existsSync(expected)).toBe(true);
    expect(expected).toBe(join(root, ".claude", "wtf", "hook-queue.jsonl"));
    // The clutter half of #29: nothing appears at the project root.
    expect(existsSync(join(root, ".wtf"))).toBe(false);
  });

  test("legacy project: the hook keeps appending to the legacy store", async () => {
    // An in-flight incident must not be split across two locations mid-run.
    mkdirSync(join(root, ".wtf"), { recursive: true });
    expect(await runHook(root)).toBe(0);
    const resolved = resolveStoreDir(root);
    expect(resolved.legacy).toBe(true);
    expect(existsSync(join(resolved.dir, "hook-queue.jsonl"))).toBe(true);
    expect(existsSync(join(root, ".claude", "wtf", "hook-queue.jsonl"))).toBe(false);
  });

  test("both present: hook and store both pick the NEW path", async () => {
    mkdirSync(join(root, ".wtf"), { recursive: true });
    mkdirSync(join(root, ".claude", "wtf"), { recursive: true });
    expect(await runHook(root)).toBe(0);
    expect(existsSync(join(root, ".claude", "wtf", "hook-queue.jsonl"))).toBe(true);
    expect(existsSync(join(root, ".wtf", "hook-queue.jsonl"))).toBe(false);
    expect(resolveStoreDir(root).dir).toBe(join(root, ".claude", "wtf"));
  });
});
