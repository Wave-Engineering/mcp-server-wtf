#!/usr/bin/env bun
/**
 * WTF (Why That Failed) MCP Server
 *
 * A flight recorder for incident troubleshooting inside Claude Code.
 * Captures tool calls, classifies events via background Haiku classifier,
 * and generates distilled timelines and runbooks.
 *
 * Run it: bun index.ts
 * Register: claude mcp add --scope user --transport stdio wtf-server -- bun index.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { handleNow } from "./tools/now";
import { handleFreshell } from "./tools/freshell";
import { handleHappened } from "./tools/happened";
import { handleImout } from "./tools/imout";
import { writeFileSync, readFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startQueueIngestion, processQueue } from "./queue";
import { startClassifier } from "./classifier/worker";

if (process.argv.includes("--help")) {
  console.log(`Usage: bun index.ts

An MCP tool server. Register with Claude Code:
  claude mcp add --scope user --transport stdio wtf-server -- bun index.ts

Flags:
  --help       Show this help message`);
  process.exit(0);
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: "wtf-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// --- Tool definitions --------------------------------------------------------

const TOOLS: Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "wtf_now",
    description:
      "Record a journal entry in the WTF flight recorder. Use gen_type 'crafted' for intentional entries, 'captured' for automatic hook entries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        gen_type: {
          type: "string",
          enum: ["crafted", "captured"],
          description: "How this entry was generated",
        },
        action_type: {
          type: "string",
          enum: ["action", "breadcrumb", "theory"],
          description: "Category (optional for captured)",
        },
        text: {
          type: "string",
          description: "Freeform description of what happened",
        },
        tool_name: {
          type: "string",
          description: "Tool name (for captured entries)",
        },
        tool_input: {
          type: "string",
          description: "Tool input as JSON string (for captured entries)",
        },
        tool_response: {
          type: "string",
          description: "Tool response as JSON string (for captured entries)",
        },
        tool_use_id: {
          type: "string",
          description: "Unique tool use ID (for captured entries)",
        },
        agent_id: {
          type: "string",
          description: "Sub-agent ID if applicable",
        },
        agent_type: {
          type: "string",
          description: "Agent type if applicable",
        },
        session_id: {
          type: "string",
          description: "Session identifier",
        },
      },
      required: ["gen_type"],
    },
  },
  {
    name: "wtf_freshell",
    description:
      "Archive the current incident and start a fresh journal. Previous entries are preserved in the database.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Optional title for the archived incident",
        },
      },
    },
  },
  {
    name: "wtf_happened",
    description:
      "Get a distilled timeline of the current troubleshooting incident. Writes a full runbook to .wtf/runbook.md.",
    inputSchema: {
      type: "object" as const,
      properties: {
        detail: {
          type: "string",
          enum: ["summary", "full"],
          description: "summary (default, max 50 lines) or full (all entries)",
        },
      },
    },
  },
  {
    name: "wtf_imout",
    description:
      "Suspend the active troubleshooting session. Stops recording but preserves captured data for later triage.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Background service lifecycle --------------------------------------------

const queuePath = `${process.cwd()}/.wtf/hook-queue.jsonl`;
const WTF_INDICATOR = "WTF ●";
let queueTimer: NodeJS.Timer | null = null;
let classifierHandle: { stop: () => void } | null = null;
let statuslineFile: string | null = null;

/** Resolve the project root, matching the agent identity hash convention. */
function resolveProjectRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {
    return process.cwd();
  }
}

/** Resolve the statusline indicator file path from the agent identity file. */
function resolveStatuslineFile(): string | null {
  const dirHash = createHash("md5").update(resolveProjectRoot()).digest("hex");
  const agentFile = `/tmp/claude-agent-${dirHash}.json`;
  if (!existsSync(agentFile)) return null;
  try {
    const identity = JSON.parse(readFileSync(agentFile, "utf-8"));
    if (identity.dev_name) return `/tmp/claude-statusline-${identity.dev_name}.json`;
  } catch {}
  return null;
}

/** Read the current indicators array from the statusline file. */
function readIndicators(path: string): string[] {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(data.indicators) ? data.indicators : [];
  } catch {
    return [];
  }
}

/** Atomically write indicators to the statusline file (temp + rename). */
function writeIndicators(path: string, indicators: string[]): void {
  const tmp = join(tmpdir(), `.claude-statusline-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ indicators }));
  renameSync(tmp, path);
}

/** Add our indicator to the statusline file. */
function addIndicator(): void {
  if (!statuslineFile) return;
  const indicators = readIndicators(statuslineFile);
  if (!indicators.includes(WTF_INDICATOR)) {
    indicators.unshift(WTF_INDICATOR);
  }
  writeIndicators(statuslineFile, indicators);
}

/** Remove our indicator from the statusline file. */
function removeIndicator(): void {
  if (!statuslineFile) return;
  const indicators = readIndicators(statuslineFile).filter((i) => i !== WTF_INDICATOR);
  if (indicators.length === 0) {
    try { unlinkSync(statuslineFile); } catch {}
  } else {
    writeIndicators(statuslineFile, indicators);
  }
}

/** Start queue ingestion and classifier if not already running. */
function ensureBackgroundServices(): void {
  if (queueTimer === null) {
    queueTimer = startQueueIngestion(queuePath);
  }
  if (classifierHandle === null) {
    classifierHandle = startClassifier();
  }
  if (statuslineFile === null) {
    statuslineFile = resolveStatuslineFile();
  }
  addIndicator();
}

/** Flush the queue once, then stop ingestion and classifier. */
function stopBackgroundServices(): void {
  processQueue(queuePath);

  if (queueTimer !== null) {
    clearInterval(queueTimer);
    queueTimer = null;
  }
  if (classifierHandle !== null) {
    classifierHandle.stop();
    classifierHandle = null;
  }
  removeIndicator();
}

// Clean up indicator if the server process exits.
process.on("exit", () => {
  removeIndicator();
});

// --- Handlers ----------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "wtf_now") {
    ensureBackgroundServices();
    return handleNow(args as unknown as Parameters<typeof handleNow>[0]);
  }

  if (name === "wtf_freshell") {
    ensureBackgroundServices();
    return handleFreshell(args as unknown as Parameters<typeof handleFreshell>[0]);
  }

  if (name === "wtf_happened") {
    ensureBackgroundServices();
    return handleHappened(args as unknown as Parameters<typeof handleHappened>[0]);
  }

  if (name === "wtf_imout") {
    const result = handleImout();
    stopBackgroundServices();
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// --- Start -------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// Background services (queue ingestion + classifier) start on first tool call,
// not at boot. See ensureBackgroundServices() above.
