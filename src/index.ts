/**
 * Anthropic Router — Main Entry Point
 *
 * Default export is the OpenClaw plugin definition.
 * Named exports provide programmatic access to the routing engine.
 */

// Plugin default export (used by OpenClaw's plugin loader)
export { default } from "./plugin.js";

// Re-export for programmatic use
export { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
export { createApp, buildConfig } from "./server.js";
export type { ProxyConfig } from "./server.js";
export type { RoutingDecision, Tier, RoutingConfig } from "./router/types.js";
export { anthropicRouterProvider } from "./provider.js";
export { OPENCLAW_MODELS } from "./models.js";
