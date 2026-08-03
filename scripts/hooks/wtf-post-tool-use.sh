#!/usr/bin/env bash
set -euo pipefail

# PostToolUse hook — captures tool calls to a JSONL queue file.
#
# Reads the PostToolUse JSON payload from stdin, extracts relevant
# fields, truncates large values, and appends to the queue file
# for later ingestion by the MCP server.

INPUT=$(cat)

# Extract fields from the PostToolUse JSON payload.
tool_name=$(echo "$INPUT" | jq -r '.tool_name // empty')
tool_input=$(echo "$INPUT" | jq -r '(.tool_input // "" | tostring)[:4096]')
tool_response=$(echo "$INPUT" | jq -r '(.tool_response // "" | tostring)[:4096]')
tool_use_id=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
session_id=$(echo "$INPUT" | jq -r '.session_id // empty')
agent_id=$(echo "$INPUT" | jq -r '.agent_id // empty')
agent_type=$(echo "$INPUT" | jq -r '.agent_type // empty')

# Determine queue file path (#29).
#
# THE HOOK MUST AGREE WITH THE SERVER. This script writes the queue; store.ts
# resolves where the server READS it. Moving one without the other splits the
# recorder in half — the hook appending to a file nothing consumes, silently,
# with an incident that looks empty rather than broken.
#
# Same resolution order as store.ts::resolveStoreDir, deliberately duplicated
# because a shell hook cannot import TypeScript:
#   1. .claude/wtf exists  -> use it (new path always wins)
#   2. legacy .wtf exists  -> use it (read/append compatibility, #29 deprecation)
#   3. neither             -> create the new path
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-.}"
if [[ -d "${PROJECT_ROOT}/.claude/wtf" ]]; then
  QUEUE_DIR="${PROJECT_ROOT}/.claude/wtf"
elif [[ -d "${PROJECT_ROOT}/.wtf" ]]; then
  QUEUE_DIR="${PROJECT_ROOT}/.wtf"
else
  QUEUE_DIR="${PROJECT_ROOT}/.claude/wtf"
fi
QUEUE_FILE="${QUEUE_DIR}/hook-queue.jsonl"
DB_FILE="${QUEUE_DIR}/wtf.db"

mkdir -p "$QUEUE_DIR"

# Quiescence mode: only capture if an active incident exists.
if [[ -f "$DB_FILE" ]]; then
  ACTIVE=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM incidents WHERE status = 'active'" 2>/dev/null || echo "0")
  if [[ "$ACTIVE" == "0" ]]; then
    # No active incident — exit without capturing
    exit 0
  fi
fi

# Build the output JSON and append to the queue file.
jq -cn \
  --arg tool_name "$tool_name" \
  --arg tool_input "$tool_input" \
  --arg tool_response "$tool_response" \
  --arg tool_use_id "$tool_use_id" \
  --arg session_id "$session_id" \
  --arg agent_id "$agent_id" \
  --arg agent_type "$agent_type" \
  '{
    tool_name: $tool_name,
    tool_input: $tool_input,
    tool_response: $tool_response,
    tool_use_id: $tool_use_id,
    session_id: $session_id,
    agent_id: $agent_id,
    agent_type: $agent_type
  }' >> "$QUEUE_FILE"
