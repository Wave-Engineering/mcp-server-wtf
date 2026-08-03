/**
 * Where the flight recorder keeps its data (#29).
 *
 * WHY THIS MOVED.
 *
 * The recorder used to write `<project>/.wtf/` — at the top level of the project
 * dir, beside the project's real contents. Two costs, and the second is the one
 * that forced the change:
 *
 *   1. Clutter. It sat next to source rather than with the other agent state.
 *   2. **It would not survive the container cut-over.** Oak and Wave runs agents
 *      in per-session containers (claudecode-workflow#959), and the durability
 *      plan (#1064) makes the project's `.claude/` dir host-backed so identity,
 *      wave plans and session state outlive the container. `.wtf/` at the project
 *      root sits OUTSIDE that boundary — a `docker rm` would destroy an incident
 *      timeline at precisely the moment you most want it.
 *
 * So the store is `<project>/.claude/wtf/`, inside the durable boundary.
 *
 * RESOLUTION ORDER — and why there is a fallback at all.
 *
 * Sessions have live `.wtf/` dirs right now, some of them mid-incident. Silently
 * switching paths would orphan a timeline someone is actively reading, so:
 *
 *   1. `<project>/.claude/wtf/` exists   -> use it (the new path always wins)
 *   2. legacy `<project>/.wtf/` exists   -> use it, and say so
 *   3. neither                           -> create and use the new path
 *
 * Rule 1 before rule 2 matters: with both present the new path wins, so a
 * migrated project never silently reverts to reading stale legacy data.
 *
 * DEPRECATION. The rule-2 fallback is READ COMPATIBILITY for in-flight
 * incidents, not a supported location. Remove it once no live `.wtf/` dirs
 * remain — tracked on #29. New data is never written to the legacy path.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";

/** Store dir relative to a project root, new location. */
export const STORE_SUBDIR = join(".claude", "wtf");

/** Store dir relative to a project root, legacy location (read-only fallback). */
export const LEGACY_STORE_SUBDIR = ".wtf";

export interface StoreResolution {
  /** Absolute path to the directory the recorder should use. */
  dir: string;
  /** True when we fell back to the pre-#29 location. */
  legacy: boolean;
}

/**
 * Resolve the recorder's store directory for a project root.
 *
 * `create` defaults to false so that read paths (a timeline query, a runbook
 * render) never manufacture a directory as a side effect of looking. Only the
 * writers ask for creation — otherwise merely *asking where the data lives*
 * would create an empty `.claude/wtf/` in every project the tool touched, and
 * then rule 2 could never fire because rule 1 would always match a dir we had
 * just made ourselves.
 */
export function resolveStoreDir(
  projectRoot: string = process.cwd(),
  opts: { create?: boolean } = {},
): StoreResolution {
  const preferred = join(projectRoot, STORE_SUBDIR);
  const legacy = join(projectRoot, LEGACY_STORE_SUBDIR);

  if (existsSync(preferred)) return { dir: preferred, legacy: false };
  if (existsSync(legacy)) return { dir: legacy, legacy: true };

  if (opts.create === true) mkdirSync(preferred, { recursive: true });
  return { dir: preferred, legacy: false };
}

/** Absolute path to a file inside the resolved store. */
export function storePath(
  filename: string,
  projectRoot: string = process.cwd(),
  opts: { create?: boolean } = {},
): string {
  return join(resolveStoreDir(projectRoot, opts).dir, filename);
}
