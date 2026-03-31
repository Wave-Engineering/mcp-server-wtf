# Project Instructions for Claude Code

This is **mcp-server-wtf** — a flight recorder MCP server for incident
troubleshooting inside Claude Code.

## Platform

This project is on **GitHub**. Use `gh` CLI for all operations.

## Project Structure

- `index.ts` — MCP server entry point (stdio transport)
- `db.ts` — SQLite singleton, schema init
- `queue.ts` — Hook queue ingestion (polls .wtf/hook-queue.jsonl)
- `tools/` — Tool handlers (now, happened, freshell, imout)
- `classifier/` — Background Haiku classifier (Bedrock SDK)
- `tests/` — Bun test suite
- `scripts/install.sh` — Idempotent installer
- `scripts/hooks/` — PostToolUse hook
- `skills/` — Skill definitions (SKILL.md files)
- `docs/` — PRD and architecture reference

## Testing

```bash
bun test                    # Run all tests
bun run lint                # TypeScript strict check
scripts/ci/validate.sh      # Full CI validation
```

## Commit Convention

```
type(scope): brief description

Closes #NNN
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

## Mandatory Rules

1. **Always have an issue** — never begin work without one
2. **Test before push** — run `bun test` and `bun run lint`
3. **Pre-commit gate** — run `/precheck` before committing

Dev-Team: mcp-server-wtf
