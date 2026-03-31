/**
 * Classification prompt and schema for the WTF classifier.
 *
 * Builds a prompt with system instructions, category definitions,
 * few-shot contrastive examples, and a JSON Schema for structured
 * output with enum-constrained action_type.
 */

/** Valid action types for classification. */
export const ACTION_TYPES = ["action", "breadcrumb", "theory", "noise"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * JSON Schema for classifier structured output.
 *
 * Used as the tool input_schema so Haiku returns a well-typed
 * response with an enum-constrained action_type field.
 */
export const CLASSIFIER_SCHEMA = {
  type: "object" as const,
  properties: {
    action_type: {
      type: "string" as const,
      enum: ["action", "breadcrumb", "theory", "noise"],
      description:
        "The classification category for this entry.",
    },
    summary: {
      type: "string" as const,
      description:
        "A concise one-sentence summary of what this entry represents.",
    },
  },
  required: ["action_type", "summary"],
};

/**
 * Build the classification prompt for a single raw entry.
 *
 * Includes the system instruction with four category definitions,
 * few-shot contrastive examples, and a bias-toward-keeping instruction
 * so ambiguous entries are classified as the most likely non-noise
 * category rather than noise.
 *
 * @param entry - The raw entry object (typically a row from raw_entries).
 * @returns The full prompt string for the classifier.
 */
export function buildClassifierPrompt(entry: object): string {
  return `You are a troubleshooting log classifier. Your job is to categorize entries from an incident timeline into exactly one of four categories.

## Categories

- **action**: A deliberate step taken by the operator — a command executed, a configuration changed, a service restarted. These are things the operator *did*.
- **breadcrumb**: An observation or piece of evidence — an error message, a log line, a metric value, a health check result. These are things the operator *found*.
- **theory**: A hypothesis or reasoning about the root cause — "I think X is causing Y", "maybe the connection pool is exhausted". These are things the operator *thinks*.
- **noise**: An entry with no diagnostic value — listing directory contents, tab-completion artifacts, routine navigation commands. These add nothing to the incident story.

## Bias Toward Keeping

When in doubt, classify as the most likely non-noise category. It is better to keep a marginally useful entry than to discard something that might matter during post-incident review. Only classify as "noise" when the entry is clearly irrelevant to troubleshooting.

## Few-Shot Examples

Entry: {"tool_name": "Bash", "tool_input": "kubectl rollout restart deployment/api-server"}
Classification: {"action_type": "action", "summary": "Restarted the api-server deployment via kubectl rollout restart"}

Entry: {"tool_name": "Bash", "tool_input": "curl -s http://localhost:8080/health", "tool_response": "{\\"status\\": \\"degraded\\", \\"db\\": \\"timeout\\"}"}
Classification: {"action_type": "breadcrumb", "summary": "Health endpoint returned degraded status with database timeout"}

Entry: {"text": "I think the connection pool is exhausting under load because we increased the replica count without adjusting max_connections"}
Classification: {"action_type": "theory", "summary": "Hypothesis that connection pool exhaustion is caused by replica increase without adjusting max_connections"}

Entry: {"tool_name": "Bash", "tool_input": "ls /var/log"}
Classification: {"action_type": "noise", "summary": "Listed contents of /var/log directory"}

Entry: {"tool_name": "Bash", "tool_input": "grep OOM /var/log/syslog", "tool_response": "Mar 15 14:23:01 host kernel: Out of memory: Killed process 1234 (java)"}
Classification: {"action_type": "breadcrumb", "summary": "Found OOM killer event in syslog — kernel killed a Java process"}

## Entry to Classify

${JSON.stringify(entry)}

Respond with a JSON object containing "action_type" and "summary". Do not include any other text.`;
}
