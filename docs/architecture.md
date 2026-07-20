# WTF Server -- Architecture Reference

## 1. Overview

WTF (Why That Failed) is a flight recorder for incident troubleshooting sessions inside Claude Code. It captures every tool call and manual observation into a durable SQLite database that survives context compaction, then enriches raw entries through a background classifier (Claude Haiku via AWS Bedrock) into a distilled timeline. The system is composed of three layers: an **MCP server** that provides journal storage and retrieval via `wtf_now`, `wtf_happened`, and `wtf_freshell` tools; a **PostToolUse hook** that automatically captures every tool call Claude makes during a session into a JSONL queue for ingestion; and **skills** (`/wtf`, `/wtf now`) that provide user-facing entry points for starting incidents and adding manual journal entries.

---

## 2. System Context Diagram

```
+-----------------------------------------------------------------+
|                     Claude Code Session                         |
|                                                                 |
|  +------------+   +--------------+   +--------------------+    |
|  |  /wtf      |   |  /wtf now    |   |  Built-in Tools    |    |
|  |  skill     |   |  skill       |   |  (Bash, Read, etc) |    |
|  +-----+------+   +------+-------+   +--------+-----------+    |
|        |                 |                     |                |
|        |       +---------+          +----------+               |
|        |       |                    |                           |
|        |       v                    v                           |
|        |  +----------+     +------------------+                |
|        |  | wtf_now   |     | PostToolUse Hook |                |
|        |  | (MCP tool)|     | (auto-capture)   |                |
|        |  +----+-----+     +--------+---------+                |
|        |       |                    |                           |
|        |       |    +---------------+                           |
|        |       |    |                                           |
|        v       v    v                                           |
|  +----------------------------------------------------------+  |
|  |                  WTF MCP Server                           |  |
|  |                                                           |  |
|  |  Tools: wtf_now | wtf_happened | wtf_freshell             |  |
|  |                                                           |  |
|  |  +------------------------------------+                   |  |
|  |  |       SQLite DB (.wtf/wtf.db)      |                   |  |
|  |  |  +----------+  +----------------+  |                   |  |
|  |  |  |raw_entries|  |distilled_entries|  |                   |  |
|  |  |  +----------+  +----------------+  |                   |  |
|  |  |  +----------+                      |                   |  |
|  |  |  |incidents  |                      |                   |  |
|  |  |  +----------+                      |                   |  |
|  |  +------------------------------------+                   |  |
|  +----------------------------+------------------------------+  |
|                               |                                 |
|                               v                                 |
|  +-------------------------------------+                       |
|  |     Background Classifier            |                       |
|  |     (@anthropic-ai/bedrock-sdk)      |                       |
|  |                                      |                       |
|  |  Polls raw_entries for unclassified  |                       |
|  |  Writes to distilled_entries         |                       |
|  +-------------------------------------+                       |
|                                                                 |
|  On disk: .wtf/wtf.db, .wtf/runbook.md, .wtf/hook-queue.jsonl  |
+-----------------------------------------------------------------+
```

**Layer 1 -- Skills:** `/wtf` and `/wtf now` are user-facing skill definitions that invoke MCP tools and inject behavioral instructions. Skills are delivered by [claudecode-workflow](https://github.com/Wave-Engineering/claudecode-workflow), not this repo.

**Layer 2 -- PostToolUse Hook:** A shell script (`scripts/hooks/wtf-post-tool-use.sh`) that fires on every Claude Code tool call, extracts fields from the hook payload, truncates large values, and appends a JSON line to `.wtf/hook-queue.jsonl`.

**Layer 3 -- MCP Server:** A Bun + TypeScript MCP server (`index.ts`) that exposes three tools over stdio transport, manages the SQLite database, ingests the hook queue, and runs a background classifier.

---

## 3. Data Flow

The data flow has two pipelines: the **capture pipeline** (tool calls into the database) and the **enrichment pipeline** (raw entries through classification into distilled entries).

### 3.1 Capture Pipeline

```
Tool call completes
    |
    v
PostToolUse hook fires (scripts/hooks/wtf-post-tool-use.sh)
    |  Reads JSON payload from stdin
    |  Extracts: tool_name, tool_input, tool_response, tool_use_id,
    |            session_id, agent_id, agent_type
    |  Truncates tool_input and tool_response to 4KB each
    |
    v
Appends JSON line to .wtf/hook-queue.jsonl
    |
    v
MCP server polls queue file every 2 seconds (queue.ts)
    |  Atomic rename: hook-queue.jsonl -> hook-queue.processing.jsonl
    |  Reads all lines from the processing file
    |  Parses each line as JSON
    |
    v
INSERT INTO raw_entries with gen_type = 'captured'
    |  Deletes the processing file after successful ingestion
    |
    v
raw_entries row stored in .wtf/wtf.db
```

### 3.2 Enrichment Pipeline

```
raw_entries (unclassified)
    |
    v
Background classifier polls for entries with no matching distilled_entries row
    |  Query: SELECT r.* FROM raw_entries r LEFT JOIN distilled_entries d
    |         ON r.id = d.raw_id WHERE d.id IS NULL ORDER BY r.id ASC LIMIT 1
    |
    v
Builds classification prompt (classifier/prompt.ts)
    |  System instruction with 4 category definitions
    |  5 few-shot contrastive examples
    |  Bias-toward-keeping instruction
    |  The raw entry serialized as JSON
    |
    v
Calls Claude Haiku via Bedrock SDK (classifier/client.ts)
    |  Model: us.anthropic.claude-haiku-4-5-20251001
    |  max_tokens: 256
    |  Structured output via tool_use (classify_entry tool)
    |  Fallback: claude --model haiku --print (CLI subprocess)
    |
    v
Parses response: { action_type, summary }
    |  Validates action_type is one of: action, breadcrumb, theory, noise
    |  Validates summary is a non-empty string
    |
    v
INSERT INTO distilled_entries
    |  Sets is_noise = 1 if action_type == 'noise'
    |
    v
distilled_entries row stored in .wtf/wtf.db
```

### 3.3 Retrieval Flow

```
wtf_happened called (tools/happened.ts)
    |
    v
Query distilled_entries for active incident (WHERE is_noise = 0)
    |
    +-- Has distilled entries? --> Format Markdown timeline
    |
    +-- No distilled entries? --> Fallback to raw_entries
    |                             Prepend "Classifier has not processed
    |                             entries yet" notice
    |
    v
Apply summary cap (50 lines) unless detail = 'full'
    |
    v
Return formatted Markdown with header:
    ## WTF Summary -- [title]
    **Duration:** N min | **Entries:** X raw, Y distilled | **Status:** active
```

---

## 4. SQLite Schema

The database lives at `.wtf/wtf.db` relative to the project root. It is opened in **WAL mode** (`PRAGMA journal_mode=WAL`) to support concurrent read/write access from the MCP server and background classifier. Schema initialization happens on first connection via `db.ts`.

### 4.1 incidents

Tracks troubleshooting sessions. Only one incident may be `active` at a time.

```sql
CREATE TABLE IF NOT EXISTS incidents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT,
    started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    ended_at    TEXT,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
);
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `title` | TEXT | Optional human-readable title, set by `wtf_freshell` |
| `started_at` | TEXT | ISO 8601 timestamp with milliseconds, set on creation |
| `ended_at` | TEXT | ISO 8601 timestamp, set when archived by `wtf_freshell` |
| `status` | TEXT | Either `'active'` or `'archived'`; constrained by CHECK |

### 4.2 raw_entries

Every tool call and manual observation, stored as-is before classification.

```sql
CREATE TABLE IF NOT EXISTS raw_entries (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id    INTEGER NOT NULL REFERENCES incidents(id),
    ts             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
    gen_type       TEXT NOT NULL CHECK (gen_type IN ('crafted', 'captured')),
    action_type    TEXT CHECK (action_type IN ('action', 'breadcrumb', 'theory') OR action_type IS NULL),
    text           TEXT,
    tool_name      TEXT,
    tool_input     TEXT,
    tool_response  TEXT,
    tool_use_id    TEXT,
    agent_id       TEXT,
    agent_type     TEXT,
    session_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_raw_incident ON raw_entries(incident_id);
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `incident_id` | INTEGER | FK to `incidents.id`; groups entries by incident |
| `ts` | TEXT | ISO 8601 timestamp with milliseconds, set on insertion |
| `gen_type` | TEXT | `'crafted'` (manual via `wtf_now`) or `'captured'` (hook via queue) |
| `action_type` | TEXT | Optional pre-classification: `'action'`, `'breadcrumb'`, or `'theory'`; nullable |
| `text` | TEXT | Freeform description (used by crafted entries) |
| `tool_name` | TEXT | Name of the Claude Code tool (e.g., `Bash`, `Read`) |
| `tool_input` | TEXT | JSON string of tool input, truncated to 4KB by the hook |
| `tool_response` | TEXT | JSON string of tool response, truncated to 4KB by the hook |
| `tool_use_id` | TEXT | Unique identifier for the tool invocation |
| `agent_id` | TEXT | Sub-agent ID, if the tool call came from a sub-agent |
| `agent_type` | TEXT | Agent type descriptor |
| `session_id` | TEXT | Claude Code session identifier |

### 4.3 distilled_entries

Classifier output: one summary line per raw entry, with a category assignment.

```sql
CREATE TABLE IF NOT EXISTS distilled_entries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_id          INTEGER NOT NULL REFERENCES raw_entries(id),
    incident_id     INTEGER NOT NULL REFERENCES incidents(id),
    ts              TEXT NOT NULL,
    action_type     TEXT NOT NULL CHECK (action_type IN ('action', 'breadcrumb', 'theory', 'noise')),
    summary         TEXT NOT NULL,
    is_noise        INTEGER NOT NULL DEFAULT 0,
    classified_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_distilled_incident ON distilled_entries(incident_id);
CREATE INDEX IF NOT EXISTS idx_distilled_not_noise ON distilled_entries(incident_id) WHERE is_noise = 0;
```

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Auto-incrementing primary key |
| `raw_id` | INTEGER | FK to `raw_entries.id`; 1:1 link to the source entry |
| `incident_id` | INTEGER | FK to `incidents.id`; denormalized for query efficiency |
| `ts` | TEXT | Timestamp copied from the raw entry (preserves original timing) |
| `action_type` | TEXT | Classifier-assigned category: `'action'`, `'breadcrumb'`, `'theory'`, or `'noise'` |
| `summary` | TEXT | One-sentence classifier-generated summary of the entry |
| `is_noise` | INTEGER | `1` if `action_type == 'noise'`, `0` otherwise; enables filtered partial index |
| `classified_at` | TEXT | ISO 8601 timestamp of when classification occurred |

---

## 5. MCP Tool Reference

The MCP server (`index.ts`) registers three tools over stdio transport using `@modelcontextprotocol/sdk`. The server name is `wtf-server` version `1.4.2`.

### 5.1 wtf_now

Records a journal entry into `raw_entries`.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `gen_type` | `string` enum: `"crafted"`, `"captured"` | Yes | How this entry was generated |
| `action_type` | `string` enum: `"action"`, `"breadcrumb"`, `"theory"` | No | Category (optional for captured entries) |
| `text` | `string` | No | Freeform description of what happened |
| `tool_name` | `string` | No | Tool name (for captured entries) |
| `tool_input` | `string` | No | Tool input as JSON string (for captured entries) |
| `tool_response` | `string` | No | Tool response as JSON string (for captured entries) |
| `tool_use_id` | `string` | No | Unique tool use ID (for captured entries) |
| `agent_id` | `string` | No | Sub-agent ID if applicable |
| `agent_type` | `string` | No | Agent type if applicable |
| `session_id` | `string` | No | Session identifier |

**Return value (success):**

```json
{ "ok": true, "entry_id": 42 }
```

**Error cases:**

| Condition | Response |
|-----------|----------|
| Invalid `gen_type` (not `"crafted"` or `"captured"`) | `{ "ok": false, "error": "Invalid gen_type: \"<value>\". Must be \"crafted\" or \"captured\"." }` with `isError: true` |
| No active incident | Auto-creates one (not an error) |

**Side effects:** If no active incident exists, one is created automatically via `getOrCreateActiveIncident()`.

### 5.2 wtf_freshell

Archives the current incident and starts a new one.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | `string` | No | Optional title for the archived incident |

**Return value (success):**

```json
{ "ok": true, "archived_entries": 127, "new_incident_id": 3 }
```

**Behavior:**
1. Finds the active incident (if any)
2. Counts its raw entries
3. Sets the incident to `status = 'archived'` with `ended_at` timestamp
4. If `title` is provided, sets the incident title
5. Creates a new incident with `status = 'active'`
6. Returns the count of archived entries and the new incident ID

**Error cases:**

| Condition | Response |
|-----------|----------|
| No active incident | Creates a new active incident; `archived_entries` is `0` |

### 5.3 wtf_happened

Returns a distilled timeline of the current incident.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `detail` | `string` enum: `"summary"`, `"full"` | No | `"summary"` (default, max 50 lines) or `"full"` (all entries) |

**Return value (success, with distilled entries):**

```markdown
## WTF Summary -- Untitled Incident
**Duration:** 45 min | **Entries:** 127 raw, 34 distilled | **Status:** active

1. [12:03] BREADCRUMB -- Health endpoint returning 503s intermittently
2. [12:05] THEORY -- Connection pool exhaustion, idle timeout set to 0
3. [12:08] ACTION -- Set DB_POOL_IDLE_TIMEOUT=30s in .env
```

**Return value (fallback to raw entries):**

```markdown
## WTF Summary -- Untitled Incident
**Duration:** 12 min | **Entries:** 45 raw, 0 distilled | **Status:** active

> **Note:** Classifier has not processed entries yet. Showing raw entries.

1. [12:03] Bash -- curl http://localhost:8080/health
2. [12:04] Read -- /var/log/app.log
```

**Error cases:**

| Condition | Response |
|-----------|----------|
| No active incident | `"No active incident found. Use wtf_now to start recording entries -- an incident will be created automatically."` |
| Active incident with no entries | `"No entries recorded yet. Use wtf_now to add observations, breadcrumbs, and theories."` |
| Distilled entries unavailable | Falls back to raw entries with a notice |

**Summary cap:** In `"summary"` mode, output is truncated to 50 lines with a truncation notice.

---

## 6. Classifier Design

The background classifier (`classifier/`) enriches raw entries by categorizing each one and generating a concise summary. It runs as an async loop within the MCP server process.

### 6.1 Prompt Structure

The classifier prompt (`classifier/prompt.ts` -- `buildClassifierPrompt()`) follows this structure:

1. **Role instruction:** "You are a troubleshooting log classifier."
2. **Category definitions:** Four categories with clear descriptions:
   - **action** -- A deliberate step taken by the operator (command executed, config changed, service restarted)
   - **breadcrumb** -- An observation or piece of evidence (error message, log line, metric value, health check result)
   - **theory** -- A hypothesis about root cause ("I think X is causing Y")
   - **noise** -- An entry with no diagnostic value (directory listing, tab completion, routine navigation)
3. **Bias-toward-keeping instruction:** "When in doubt, classify as the most likely non-noise category."
4. **Five few-shot contrastive examples** (see below)
5. **The raw entry** serialized as JSON
6. **Output instruction:** "Respond with a JSON object containing action_type and summary."

### 6.2 Few-Shot Examples

The prompt includes five contrastive examples that demonstrate each category:

| # | Entry | Classification | Category |
|---|-------|---------------|----------|
| 1 | `kubectl rollout restart deployment/api-server` | "Restarted the api-server deployment via kubectl rollout restart" | action |
| 2 | `curl -s http://localhost:8080/health` returning `{"status": "degraded", "db": "timeout"}` | "Health endpoint returned degraded status with database timeout" | breadcrumb |
| 3 | "I think the connection pool is exhausting under load because we increased the replica count without adjusting max_connections" | "Hypothesis that connection pool exhaustion is caused by replica increase without adjusting max_connections" | theory |
| 4 | `ls /var/log` | "Listed contents of /var/log directory" | noise |
| 5 | `grep OOM /var/log/syslog` returning an OOM killer event | "Found OOM killer event in syslog -- kernel killed a Java process" | breadcrumb |

### 6.3 Categorization Rules

- **action:** Things the operator *did* -- corrective steps, configuration changes, service restarts.
- **breadcrumb:** Things the operator *found* -- error messages, log lines, metric observations.
- **theory:** Things the operator *thinks* -- hypotheses about root cause, reasoned explanations.
- **noise:** Clearly irrelevant entries -- directory listings, tab completion, routine navigation commands.

### 6.4 Bias Toward Keeping

The classifier is explicitly instructed to err on the side of keeping entries. From the prompt:

> "When in doubt, classify as the most likely non-noise category. It is better to keep a marginally useful entry than to discard something that might matter during post-incident review. Only classify as 'noise' when the entry is clearly irrelevant to troubleshooting."

### 6.5 Structured Output via tool_use

The classifier uses Bedrock's tool_use mechanism to enforce structured output:

```typescript
tools: [
  {
    name: "classify_entry",
    description: "Classify a troubleshooting log entry.",
    input_schema: {
      type: "object",
      properties: {
        action_type: {
          type: "string",
          enum: ["action", "breadcrumb", "theory", "noise"],
          description: "The classification category for this entry."
        },
        summary: {
          type: "string",
          description: "A concise one-sentence summary of what this entry represents."
        }
      },
      required: ["action_type", "summary"]
    }
  }
],
tool_choice: { type: "tool", name: "classify_entry" }
```

This ensures the model always returns a valid JSON object with the correct shape. The `tool_choice` forces Haiku to use the `classify_entry` tool rather than responding with freeform text.

### 6.6 Fallback: Claude CLI

If the Bedrock SDK call fails (e.g., missing AWS credentials), the classifier falls back to spawning a CLI subprocess:

```
claude --model haiku --print -p <prompt>
```

The CLI output is parsed by extracting JSON from the response (handling potential markdown code fences). The parsed result is validated against the same schema. If both Bedrock and CLI fail, the entry is skipped and retried on the next poll cycle.

---

## 7. Hook Design

The PostToolUse hook (`scripts/hooks/wtf-post-tool-use.sh`) is a Bash script that runs after every Claude Code tool call.

### 7.1 Captured Fields

The hook reads the PostToolUse JSON payload from stdin and extracts:

| Field | Source | Description |
|-------|--------|-------------|
| `tool_name` | `.tool_name` | Name of the tool (e.g., `Bash`, `Read`, `Edit`) |
| `tool_input` | `.tool_input` | Tool input, truncated to 4KB |
| `tool_response` | `.tool_response` | Tool response, truncated to 4KB |
| `tool_use_id` | `.tool_use_id` | Unique identifier for this tool invocation |
| `session_id` | `.session_id` | Claude Code session identifier |
| `agent_id` | `.agent_id` | Sub-agent ID (if applicable) |
| `agent_type` | `.agent_type` | Agent type (if applicable) |

### 7.2 Truncation

Both `tool_input` and `tool_response` are truncated to **4,096 bytes** (4KB) using jq's string slicing:

```bash
tool_input=$(echo "$INPUT" | jq -r '(.tool_input // "" | tostring)[:4096]')
tool_response=$(echo "$INPUT" | jq -r '(.tool_response // "" | tostring)[:4096]')
```

This prevents oversized entries from commands with large output (e.g., `cat` on a big file) from bloating the database.

### 7.3 Queue File Format

The hook appends one JSON object per line to `.wtf/hook-queue.jsonl` (JSONL format):

```jsonl
{"tool_name":"Bash","tool_input":"curl http://localhost:8080/health","tool_response":"{\"status\":\"ok\"}","tool_use_id":"toolu_01ABC","session_id":"sess_xyz","agent_id":"","agent_type":""}
{"tool_name":"Read","tool_input":"/var/log/app.log","tool_response":"ERROR: connection refused","tool_use_id":"toolu_02DEF","session_id":"sess_xyz","agent_id":"","agent_type":""}
```

The queue file path is `${CLAUDE_PROJECT_DIR:-.}/.wtf/hook-queue.jsonl`. The directory is created if it does not exist.

### 7.4 Atomic Rename Ingestion

The MCP server (`queue.ts`) ingests the queue using an atomic rename pattern to avoid races with the hook script:

1. Check if `hook-queue.jsonl` exists
2. **Atomic rename** to `hook-queue.processing.jsonl` (prevents the hook from appending to a file being read)
3. Read all lines from the processing file
4. Parse each line as JSON and INSERT into `raw_entries` with `gen_type = 'captured'`
5. Delete the processing file after successful ingestion

If a line fails to parse as JSON, it is logged and skipped (other lines are still processed).

### 7.5 Hook Registration

The hook is registered in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "type": "command",
        "command": "/path/to/scripts/hooks/wtf-post-tool-use.sh"
      }
    ]
  }
}
```

---

## 8. File Layout

```
.wtf/                              # Runtime data directory (gitignored)
  wtf.db                           # SQLite database (WAL mode)
  wtf.db-wal                       # WAL file (SQLite-managed)
  wtf.db-shm                       # Shared memory file (SQLite-managed)
  hook-queue.jsonl                  # Hook queue (consumed by MCP server)
  runbook.md                       # Generated runbook skeleton (by wtf_happened)

index.ts                           # Server entry point, tool registration, transport setup
db.ts                              # SQLite connection singleton, schema init, WAL mode
queue.ts                           # Hook queue ingestion (polls hook-queue.jsonl)
package.json                       # Dependencies: @modelcontextprotocol/sdk, @anthropic-ai/bedrock-sdk
tsconfig.json                      # TypeScript strict mode, ESNext target, Bun types
bun.lock                           # Frozen dependency lockfile
tools/
  now.ts                           # wtf_now handler + getOrCreateActiveIncident
  happened.ts                      # wtf_happened handler + timeline formatting
  freshell.ts                      # wtf_freshell handler + incident archival
  imout.ts                         # wtf_imout handler + session suspension
classifier/
  client.ts                        # Bedrock SDK client factory + model constant
  prompt.ts                        # Classification prompt template + few-shot examples + JSON schema
  worker.ts                        # Background classification loop (poll, classify, insert)
tests/
  db.test.ts                       # Schema + WAL mode tests
  now.test.ts                      # wtf_now unit tests
  happened.test.ts                 # wtf_happened unit tests
  freshell.test.ts                 # wtf_freshell unit tests
  imout.test.ts                    # wtf_imout unit tests
  classifier.test.ts               # Classifier prompt + parsing tests
  queue.test.ts                    # Hook queue ingestion tests

scripts/
  ci/
    validate.sh                    # CI entry point (runs lint.sh then test.sh)
    lint.sh                        # TypeScript strict check + shellcheck on shell scripts
    test.sh                        # bun install --frozen-lockfile + bun test
  hooks/
    wtf-post-tool-use.sh           # PostToolUse hook (captures tool calls to JSONL queue)

docs/
  PRD-wtf-server.md                # Product requirements document
  architecture.md                  # This document
```

---

## 9. Configuration

The following values are tunable in the codebase. All defaults are set in the source files listed below.

| Parameter | Default | Location | Description |
|-----------|---------|----------|-------------|
| Queue poll interval | 2,000 ms | `queue.ts` `startQueueIngestion()` `intervalMs` parameter | How often the MCP server checks `hook-queue.jsonl` for new entries |
| Classifier poll interval | 5,000 ms | `classifier/worker.ts` `ClassifierOptions.pollIntervalMs` | How often the classifier checks for unclassified entries when idle |
| Classifier rate limit | 2,000 ms | `classifier/worker.ts` `ClassifierOptions.rateLimitMs` | Minimum delay between consecutive classification API calls |
| Classifier max tokens | 256 | `classifier/worker.ts` `classifyViaBedrock()` | Maximum tokens for Haiku classification response |
| Classifier model | `us.anthropic.claude-haiku-4-5-20251001` | `classifier/client.ts` `CLASSIFIER_MODEL` | Bedrock model ID for classification |
| AWS region | `us-east-1` | `classifier/client.ts` `getClassifierClient()` | AWS region for Bedrock API calls (overridable via `AWS_REGION` env var) |
| Hook truncation limit | 4,096 bytes | `scripts/hooks/wtf-post-tool-use.sh` `[:4096]` | Maximum size for `tool_input` and `tool_response` in hook entries |
| Summary line cap | 50 lines | `tools/happened.ts` `SUMMARY_LINE_CAP` | Maximum lines returned by `wtf_happened` in summary mode |
| Database path | `.wtf/wtf.db` | `db.ts` `getDb()` default | SQLite database file location (relative to `process.cwd()`) |
| Queue file path | `.wtf/hook-queue.jsonl` | `index.ts` `queuePath` | JSONL queue file location (relative to `process.cwd()`) |

---

## 10. Failure Modes

### 10.1 Classifier Crash

**Scenario:** The background classifier encounters an unrecoverable error or the Bedrock API becomes unreachable.

**Behavior:** The classifier loop catches all exceptions, logs them, and continues polling. If both Bedrock and CLI fallback fail for a specific entry, that entry is skipped (with a sleep delay to avoid tight-looping). The MCP server continues to function normally -- `wtf_now` records entries, `wtf_freshell` manages incidents, and `wtf_happened` falls back to reading `raw_entries` directly with a notice that the classifier has not processed entries yet.

**Recovery:** The classifier automatically retries on its next poll cycle. No manual intervention is needed unless the underlying cause (e.g., expired AWS credentials) is not resolved.

### 10.2 Queue Backup

**Scenario:** The MCP server stops polling the queue (e.g., server crash or restart) while the PostToolUse hook continues appending to `hook-queue.jsonl`.

**Behavior:** The JSONL file grows on disk. The hook script uses simple append operations, so there is no data loss. When the MCP server resumes, it will process all accumulated entries on its next poll cycle via the atomic rename mechanism. Entries that were mid-processing (in `hook-queue.processing.jsonl`) when the server crashed are lost -- they were already renamed away from the hook's append target.

**Recovery:** Restart the MCP server. All entries in `hook-queue.jsonl` will be ingested. Entries in `hook-queue.processing.jsonl` from a prior crash are orphaned and can be manually reviewed or deleted.

### 10.3 Database Lock Contention

**Scenario:** The MCP server (queue ingestion + tool handlers) and the background classifier both write to the SQLite database simultaneously.

**Behavior:** SQLite WAL mode (`PRAGMA journal_mode=WAL`) is enabled on first connection (`db.ts`). WAL mode allows concurrent readers and a single writer without blocking. Since both the MCP server and classifier run within the same Bun process and share the same database singleton (`getDb()`), write contention is managed by SQLite's internal locking. Short write transactions (single INSERT statements) minimize lock hold time.

**Recovery:** No intervention needed. SQLite handles the concurrency. In pathological cases (extremely high hook throughput), queue entries may experience slight ingestion delay, but no data is lost.

### 10.4 Malformed Queue Entries

**Scenario:** The hook script produces a line that is not valid JSON (e.g., due to a jq failure or concurrent write corruption).

**Behavior:** The queue ingestion loop (`queue.ts` `processQueue()`) catches JSON parse errors per line, logs a warning (`"Malformed queue entry, skipping: ..."`), and continues processing remaining lines in the file. Valid entries are not affected by a single bad line.

**Recovery:** Automatic. The malformed line is logged and discarded. The processing file is deleted after all parseable lines are ingested.
