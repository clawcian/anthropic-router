/**
 * Anthropic Router — Entry Point
 *
 * Starts the proxy server that routes requests to the cheapest
 * Anthropic model based on prompt complexity.
 *
 * Configuration via environment variables:
 *   ANTHROPIC_API_KEY  — Required. Anthropic API key.
 *   PORT               — Server port (default: 8403)
 *   LOG_ENABLED        — Enable JSONL logging (default: true, set "false" to disable)
 *   LOG_PATH           — Path to JSONL log file (default: ~/.openclaw/routing-log.jsonl)
 *   FORCE_MODEL        — Force a specific model for all requests (testing)
 */

import { serve } from "@hono/node-server";
import { createApp, buildConfig } from "./server.js";
import { expandPath } from "./logger.js";
import type { ProxyConfig } from "./server.js";

const routingConfig = buildConfig();

const config: ProxyConfig = {
  port: parseInt(process.env.PORT ?? "8403", 10),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  proxySecret: process.env.PROXY_SECRET ?? "",
  routingConfig,
  logEnabled: process.env.LOG_ENABLED !== "false",
  logPath: expandPath(process.env.LOG_PATH ?? "~/.openclaw/routing-log.jsonl"),
  forceModel: process.env.FORCE_MODEL || undefined,
};

if (!config.anthropicApiKey) {
  console.error("Error: ANTHROPIC_API_KEY environment variable is required");
  process.exit(1);
}

if (!config.proxySecret) {
  console.error("Error: PROXY_SECRET environment variable is required");
  process.exit(1);
}

const app = createApp(config);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Anthropic Router listening on http://localhost:${info.port}`);
  console.log(
    `Tiers: SIMPLE=${routingConfig.tiers.SIMPLE}, MEDIUM=${routingConfig.tiers.MEDIUM}, COMPLEX=${routingConfig.tiers.COMPLEX}`,
  );
});

// Re-export for programmatic use
export { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
export { createApp, buildConfig } from "./server.js";
export type { ProxyConfig } from "./server.js";
export type { RoutingDecision, Tier, RoutingConfig } from "./router/types.js";
