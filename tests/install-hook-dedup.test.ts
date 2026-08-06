/**
 * The installer must register the PostToolUse hook exactly once, however the
 * existing settings happen to spell its path (#34).
 *
 * `install-remote.sh` builds `HOOK_PATH` from `$HOME`, so it is always absolute,
 * while a settings file seeded from a template declares the same hook as
 * `~/.local/share/...`. The original idempotency check compared `.command` as a
 * raw string, so those two spellings of one file compared unequal and the
 * recorder was registered twice — firing twice on every tool use. Reproduced on
 * the Oak-and-Wave image, whose template seeds the tilde form before the
 * installer runs.
 *
 * These drive the REAL `configure_hook` by sourcing each installer. A test that
 * reimplemented the jq program would have reimplemented the bug and agreed with
 * it.
 *
 * The two installers are NOT interchangeable, and an earlier version of this file
 * assumed they were: `install.sh` is the dev installer and points HOOK_PATH at the
 * repo checkout (`$PROJECT_DIR/scripts/hooks/...`), which is a genuinely different
 * file from `~/.local/share/...`. Registering both is correct there, so the
 * spelling cases are derived per-installer rather than hardcoded.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const INSTALLERS = [
  resolve(import.meta.dir, "..", "scripts", "install.sh"),
  resolve(import.meta.dir, "..", "scripts", "install-remote.sh"),
];

function freshHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, ".claude"), { recursive: true });
  return home;
}

/** Ask the installer itself where its hook lives, under a given $HOME. */
function hookPathOf(installer: string, home: string): string {
  const proc = spawnSync("bash", ["-c", `source "${installer}"; echo "$HOOK_PATH"`], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  if (proc.status !== 0) throw new Error(`could not read HOOK_PATH: ${proc.stderr}`);
  return proc.stdout.trim();
}

/** Run the installer's own configure_hook against a throwaway $HOME. */
function configureHook(installer: string, home: string, initialSettings: unknown | null) {
  const settings = join(home, ".claude", "settings.json");
  if (initialSettings !== null) {
    writeFileSync(settings, JSON.stringify(initialSettings, null, 2));
  }
  const proc = spawnSync(
    "bash",
    ["-c", `source "${installer}"; configure_hook >/dev/null 2>&1`],
    { env: { ...process.env, HOME: home }, encoding: "utf8" },
  );
  if (proc.status !== 0) {
    throw new Error(`configure_hook failed: ${proc.stderr}\n${proc.stdout}`);
  }
  return JSON.parse(readFileSync(settings, "utf8"));
}

/** Every PostToolUse command, flattened across matcher groups. */
function postToolUseCommands(settings: any): string[] {
  return (settings?.hooks?.PostToolUse ?? []).flatMap((g: any) =>
    (g.hooks ?? []).map((h: any) => h.command),
  );
}

function hookHits(settings: any): string[] {
  return postToolUseCommands(settings).filter((c) => c.includes("wtf-post-tool-use.sh"));
}

for (const installer of INSTALLERS) {
  const name = installer.split("/").pop()!;

  describe(`${name} configure_hook`, () => {
    test("registers the hook exactly once on empty settings", () => {
      const home = freshHome("wtf-hook-");
      expect(hookHits(configureHook(installer, home, {}))).toHaveLength(1);
    });

    test("is idempotent across repeated installs", () => {
      const home = freshHome("wtf-hook-idem-");
      configureHook(installer, home, {});
      const settings = configureHook(installer, home, null);
      expect(hookHits(settings)).toHaveLength(1);
    });

    test("adds no duplicate when settings already spell the path with ~ or $HOME", () => {
      // THE REGRESSION, but only meaningful where the hook actually lives under
      // $HOME. install.sh points at the repo checkout, so there is no tilde
      // spelling of it to collide with — assert that fact rather than skipping
      // silently, so this stays honest if HOOK_PATH ever moves.
      const home = freshHome("wtf-hook-spell-");
      const hookPath = hookPathOf(installer, home);

      if (!hookPath.startsWith(home + "/")) {
        expect(name).toBe("install.sh"); // the dev installer, repo-relative by design
        return;
      }

      const rel = hookPath.slice(home.length + 1);
      // Each spelling gets a fresh $HOME so `rel` is recomputed per case; an
      // earlier version also computed a `relFresh` and str-replaced it in, which
      // was always a no-op and read as if it were doing something.
      for (const spelling of [
        `~/${rel}`,
        `$HOME/${rel}`,
        `\${HOME}/${rel}`,
        // Oak-and-Wave rewrites hook commands so a hook absent from an older
        // image is inert rather than fatal (cc-workflow#1107). The fleet that
        // reported this bug has settings in exactly this shape, so keying on the
        // wrapper's `[` would re-add the duplicate on every one of them.
        `[ -x ~/${rel} ] || exit 0; ~/${rel}`,
      ]) {
        const fresh = freshHome("wtf-hook-spell-case-");
        const existing = spelling;
        const settings = configureHook(installer, fresh, {
          hooks: {
            PostToolUse: [
              { matcher: "", hooks: [{ type: "command", command: existing }] },
            ],
          },
        });
        const hits = hookHits(settings);
        expect(hits).toHaveLength(1);
        // The existing spelling is left alone — dedup recognises it, it does not
        // rewrite it.
        expect(hits[0]).toBe(existing);
      }
    });

    test("still adds the hook alongside an unrelated PostToolUse hook", () => {
      // Normalising must not collapse DIFFERENT hooks into one.
      const home = freshHome("wtf-hook-other-");
      const settings = configureHook(installer, home, {
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "~/.claude/scripts/other-hook.sh" }],
            },
          ],
        },
      });
      expect(hookHits(settings)).toHaveLength(1);
      expect(postToolUseCommands(settings)).toContain("~/.claude/scripts/other-hook.sh");
    });

    test("the --check verifier agrees that a ~-spelled hook is configured", () => {
      // do_check carried the SAME raw-string compare, so it reported "hook not
      // found" on a host where the hook is configured and working, just spelled
      // with a `~`. A verifier that disagrees with the installer about what
      // "installed" means is worse than no verifier — it sends people looking for
      // a problem that is not there.
      const home = freshHome("wtf-hook-check-");
      const hookPath = hookPathOf(installer, home);
      if (!hookPath.startsWith(home + "/")) {
        expect(name).toBe("install.sh"); // repo-relative by design; no tilde form
        return;
      }
      const rel = hookPath.slice(home.length + 1);
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PostToolUse: [
              { matcher: "", hooks: [{ type: "command", command: `~/${rel}` }] },
            ],
          },
        }),
      );

      // Drive do_check ITSELF. An earlier version of this test pasted the jq
      // predicate inline, which would have passed even with the raw-string
      // compare still in the script — the test would have been checking its own
      // copy of the fix rather than the shipped one. do_check reports other
      // failures against a fake $HOME (no binary, no MCP registration); only its
      // hook verdict is asserted here.
      const proc = spawnSync("bash", ["-c", `source "${installer}"; do_check || true`], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
      const out = proc.stdout + proc.stderr;
      expect(out).toContain("PostToolUse hook configured");
      expect(out).not.toContain("PostToolUse hook not found");
    });

    test("uninstall removes a ~-spelled entry, not just the absolute one", () => {
      // The uninstall path deletes the data dir. A raw-string compare left the
      // ~-spelled entry behind, pointing at the script that just went away — so
      // every tool call afterwards printed "not found". Broken, not untidy.
      const home = freshHome("wtf-hook-uninst-");
      const hookPath = hookPathOf(installer, home);
      if (!hookPath.startsWith(home + "/")) {
        expect(name).toBe("install.sh"); // repo-relative by design
        return;
      }
      const rel = hookPath.slice(home.length + 1);
      const settingsPath = join(home, ".claude", "settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            PostToolUse: [
              { matcher: "", hooks: [{ type: "command", command: `~/${rel}` }] },
            ],
          },
        }),
      );

      const proc = spawnSync(
        "bash",
        ["-c", `source "${installer}"; do_uninstall >/dev/null 2>&1 || true`],
        { env: { ...process.env, HOME: home }, encoding: "utf8" },
      );
      expect(proc.status).toBe(0);
      expect(hookHits(JSON.parse(readFileSync(settingsPath, "utf8")))).toHaveLength(0);
    });

    test.if(name === "install-remote.sh")(
      "still dispatches when piped from stdin (curl | bash)",
      () => {
        // THE CRITICAL CASE, and the one that nearly shipped broken. `curl … |
        // bash` feeds the script on STDIN, where BASH_SOURCE is unset — under
        // `set -u` a bare `${BASH_SOURCE[0]}` aborts with "unbound variable"
        // before dispatch, killing the documented install path entirely.
        //
        // Scoped to the remote installer on purpose: install.sh resolves
        // PROJECT_DIR from BASH_SOURCE because it installs FROM a checkout, so it
        // cannot work piped and asserting that it does would assert something
        // false.
        const home = freshHome("wtf-hook-piped-");
        const proc = spawnSync("bash", ["-s", "--", "--definitely-not-a-flag"], {
          input: readFileSync(installer, "utf8"),
          env: { ...process.env, HOME: home },
          encoding: "utf8",
        });
        const out = proc.stdout + proc.stderr;
        expect(out).not.toContain("unbound variable");
        expect(out).toContain("Unknown flag");
      },
    );

    test("sourcing the installer does not run an install", () => {
      // The source guard is what makes every test above drive the real function.
      const home = freshHome("wtf-hook-src-");
      const proc = spawnSync("bash", ["-c", `source "${installer}"; echo SOURCED_OK`], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
      expect(proc.status).toBe(0);
      expect(proc.stdout).toContain("SOURCED_OK");
      expect(proc.stdout).not.toContain("Installation Summary");
    });

    test("still dispatches when EXECUTED as a file", () => {
      // The other half of the source guard: making sourcing inert must not make
      // normal execution inert too. An unknown flag proves dispatch ran without
      // installing anything.
      const home = freshHome("wtf-hook-exec-");
      const proc = spawnSync("bash", [installer, "--definitely-not-a-flag"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
      const out = proc.stdout + proc.stderr;
      expect(out).not.toContain("unbound variable");
      expect(out).toContain("Unknown flag");
    });
  });
}
