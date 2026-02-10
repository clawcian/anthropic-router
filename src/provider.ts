/**
 * Anthropic Router ProviderPlugin for OpenClaw
 *
 * Registers as an LLM provider in OpenClaw. The local proxy handles
 * routing — OpenClaw just sees a standard Anthropic Messages API at localhost.
 */

import type { ProviderPlugin } from "./types.js";
import { buildProviderModels } from "./models.js";

/** Default proxy base URL (before proxy starts, used for config loading). */
const DEFAULT_BASE_URL = "http://127.0.0.1:8403";

/** Active proxy base URL (set when proxy starts). */
let activeProxyBaseUrl: string = DEFAULT_BASE_URL;

/**
 * Update the proxy base URL (called from plugin.ts when the proxy starts).
 */
export function setActiveProxyUrl(baseUrl: string): void {
  activeProxyBaseUrl = baseUrl;
}

/**
 * Anthropic Router provider plugin definition.
 */
export const anthropicRouterProvider: ProviderPlugin = {
  id: "anthropic-router",
  label: "Anthropic Router",
  aliases: ["ar"],

  // Model definitions — dynamically set to proxy URL
  get models() {
    return buildProviderModels(activeProxyBaseUrl);
  },

  // No auth required — the proxy forwards per-request x-api-key from
  // OpenClaw's session. Users must be logged into Claude Code.
  auth: [],
};
