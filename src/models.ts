/**
 * Anthropic Router Model Definition for OpenClaw
 *
 * Exposes a single "auto" model that smart-routes to the cheapest
 * capable Anthropic model (haiku/sonnet/opus) per request.
 *
 * Pricing declared at haiku rates (cheapest tier) since that's what
 * most requests will use. maxTokens: 8192 is the safe minimum across
 * all tiers — requests will never exceed any model's limit.
 */

import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.js";

export const AUTO_MODEL: ModelDefinitionConfig = {
  id: "auto",
  name: "Anthropic Smart Router",
  api: "anthropic-messages",
  reasoning: false,
  input: ["text", "image"],
  cost: {
    input: 0.8,
    output: 4.0,
    cacheRead: 0.08,
    cacheWrite: 1.0,
  },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

export const OPENCLAW_MODELS: ModelDefinitionConfig[] = [AUTO_MODEL];

/**
 * Build a ModelProviderConfig for the Anthropic Router.
 *
 * @param baseUrl - The proxy's local base URL (e.g., "http://127.0.0.1:8403")
 */
export function buildProviderModels(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl,
    api: "anthropic-messages",
    models: OPENCLAW_MODELS,
  };
}
