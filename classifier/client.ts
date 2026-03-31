/**
 * Bedrock SDK client factory for the classifier.
 *
 * Provides a singleton-style accessor for the AnthropicBedrock client
 * and the model constant used for classification.
 */

import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";

/** Haiku model ID for classification calls via Bedrock. */
export const CLASSIFIER_MODEL = "us.anthropic.claude-haiku-4-5-20251001";

/**
 * Create and return an AnthropicBedrock client instance.
 *
 * Uses the AWS_REGION environment variable (defaults to us-east-1)
 * and relies on the default AWS credential provider chain.
 */
export function getClassifierClient(): AnthropicBedrock {
  return new AnthropicBedrock({
    awsRegion: process.env.AWS_REGION ?? "us-east-1",
  });
}
