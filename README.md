# WTF (Why That Failed)

A flight recorder for incident troubleshooting inside Claude Code. WTF captures
every tool call and manual observation into a durable SQLite database that
survives context compaction, then enriches raw entries through a background
classifier into a distilled timeline.

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code](https://claude.ai/code) CLI (`claude`)
- `jq` (JSON processor)
- AWS credentials for Bedrock (optional — enables background classifier)

## Installation

```bash
git clone https://github.com/Wave-Engineering/mcp-server-wtf.git
cd mcp-server-wtf
./scripts/install.sh
```

Verify everything is configured:

```bash
./scripts/install.sh --check
```

## Quick Start

```bash
# Start troubleshooting
/wtf

# Investigate the issue... Claude records tool calls automatically

# Get the distilled timeline
wtf_happened

# Add your own observations
/wtf now "DNS resolver returning stale records"
```

## Architecture Overview

WTF is a three-layer system:

```
  /wtf, /wtf now          Skills (user-facing entry points)
        |
        v
  wtf_now, wtf_happened   MCP Server (journal storage, retrieval,
  wtf_freshell             background classification)
        ^
        |
  PostToolUse hook         Auto-capture (every tool call -> JSONL queue)
```

**Layer 1 -- Skills:** `/wtf` starts a troubleshooting session and activates
flight recorder mode. `/wtf now` adds manual journal entries.

**Layer 2 -- MCP Server:** A Bun + TypeScript server exposing four tools over
stdio transport. Manages a SQLite database, ingests the hook queue, and runs a
background classifier (Claude Haiku via AWS Bedrock) that categorizes entries as
actions, breadcrumbs, theories, or noise.

**Layer 3 -- PostToolUse Hook:** A shell script that fires on every Claude Code
tool call, extracts relevant fields, truncates large values, and appends a JSON
line to `.wtf/hook-queue.jsonl` for ingestion.

## Usage

### Starting a Session

```
/wtf
```

Archives any prior incident and creates a fresh one. Prompts for an optional
title, then puts Claude into flight recorder mode where significant observations
are journaled automatically.

### Recording Observations

```
/wtf now the health endpoint is returning 503s
/wtf now "theory: connection pool exhaustion under load"
/wtf now checked nginx logs — 502s started at 14:32
```

Adds a manual entry to the journal. Classification is handled by the background
classifier.

### Getting the Timeline

Call the `wtf_happened` MCP tool (Claude can invoke it directly, or you can ask
for it):

```
wtf_happened                  # summary (max 50 lines)
wtf_happened { detail: "full" }  # all entries
```

Returns a distilled Markdown timeline:

```
## WTF Summary -- DNS Resolution Failure
**Duration:** 45 min | **Entries:** 127 raw, 34 distilled | **Status:** active

1. [12:03] BREADCRUMB -- Health endpoint returning 503s intermittently
2. [12:05] THEORY -- Connection pool exhaustion, idle timeout set to 0
3. [12:08] ACTION -- Set DB_POOL_IDLE_TIMEOUT=30s in .env
```

### Suspending Recording

```
/wtf imout
```

Suspends the flight recorder without losing data. Useful when switching to
non-troubleshooting work. The hook still fires but entries are filtered.

### Generating a Runbook

`wtf_happened` also writes a runbook skeleton to `.wtf/runbook.md` that can be
refined into a reusable playbook.

### Clearing / Starting Fresh

```
wtf_freshell
```

Archives the current incident and starts a new one. Previous entries are
preserved in the database.

## Configuration

### Data Directory

All runtime data lives in `.wtf/` relative to the project root (gitignored):

```
.wtf/
  wtf.db              SQLite database (WAL mode)
  hook-queue.jsonl    Hook queue (consumed by MCP server)
  runbook.md          Generated runbook skeleton
```

### Tunable Values

| Parameter | Default | Location |
|-----------|---------|----------|
| Queue poll interval | 2,000 ms | `queue.ts` |
| Classifier poll interval | 5,000 ms | `classifier/worker.ts` |
| Classifier rate limit | 2,000 ms | `classifier/worker.ts` |
| Hook truncation limit | 4,096 bytes | `scripts/hooks/wtf-post-tool-use.sh` |
| Summary line cap | 50 lines | `tools/happened.ts` |

### MCP Server Registration

The installer registers the server at user scope:

```bash
claude mcp add --scope user --transport stdio wtf-server -- bun index.ts
```

### Hook Configuration

The PostToolUse hook is configured in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "type": "command",
        "command": "/absolute/path/to/scripts/hooks/wtf-post-tool-use.sh"
      }
    ]
  }
}
```

## Uninstall

```bash
./scripts/install.sh --uninstall
```

Removes the MCP server registration, skills, and hook configuration. The `.wtf/`
data directory is preserved (it contains incident history). To remove it:

```bash
rm -rf .wtf/
```

## License

MIT -- see [LICENSE](LICENSE).
