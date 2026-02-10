/**
 * Anthropic Router — Proxy Server
 *
 * Accepts Anthropic Messages API requests, scores prompt complexity,
 * rewrites the model field to the cheapest capable model, and forwards
 * to api.anthropic.com with zero-copy SSE streaming.
 *
 * Routing logic adapted from ClawRouter (MIT licensed, BlockRunAI)
 * https://github.com/BlockRunAI/ClawRouter
 */

import { Hono } from "hono";
import { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
import type { RoutingConfig, Tier } from "./router/types.js";
import { logDecision } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Known Anthropic Messages API request fields (allowlist). */
export type AnthropicMessagesRequest = {
  model?: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  metadata?: { user_id?: string };
};

// Map short tier model names to full Anthropic API model IDs
const TIER_TO_MODEL: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-6",
};

export type ProxyConfig = {
  port: number;
  /** Fallback API key for standalone mode. In plugin mode, extracted per-request from x-api-key header. */
  anthropicApiKey?: string;
  routingConfig: RoutingConfig;
  logEnabled: boolean;
  logPath: string;
  forceModel?: string;
};

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

/**
 * Merge user config with defaults.
 * Preserves all default values when user only overrides specific fields.
 */
export function buildConfig(
  overrides?: Partial<{
    tiers: Partial<RoutingConfig["tiers"]>;
    scoring: Partial<RoutingConfig["scoring"]>;
    overrides: Partial<RoutingConfig["overrides"]>;
  }>,
): RoutingConfig {
  const config = structuredClone(DEFAULT_ROUTING_CONFIG);
  if (!overrides) return config;

  if (overrides.tiers) {
    Object.assign(config.tiers, overrides.tiers);
  }

  if (overrides.scoring) {
    if (overrides.scoring.dimensionWeights) {
      Object.assign(
        config.scoring.dimensionWeights,
        overrides.scoring.dimensionWeights,
      );
    }
    if (overrides.scoring.tierBoundaries) {
      Object.assign(
        config.scoring.tierBoundaries,
        overrides.scoring.tierBoundaries,
      );
    }
    if (overrides.scoring.confidenceThreshold !== undefined) {
      config.scoring.confidenceThreshold =
        overrides.scoring.confidenceThreshold;
    }
    if (overrides.scoring.confidenceSteepness !== undefined) {
      config.scoring.confidenceSteepness =
        overrides.scoring.confidenceSteepness;
    }
  }

  if (overrides.overrides) {
    Object.assign(config.overrides, overrides.overrides);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract text content from an Anthropic message content field.
 * Content can be a string or an array of content blocks.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" && b !== null && b.type === "text",
      )
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}

/**
 * Resolve a tier model name (e.g., "haiku") to a full Anthropic API model ID.
 * Falls through to the raw name if no mapping exists.
 */
function resolveModelId(tierModel: string): string {
  return TIER_TO_MODEL[tierModel] ?? tierModel;
}

/**
 * Build an allowlisted request body from raw parsed JSON.
 * Only known Anthropic API fields are forwarded; everything else is dropped.
 */
function buildAllowlistedBody(
  raw: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  const body: AnthropicMessagesRequest = {
    messages: raw.messages,
  };
  if (raw.model !== undefined) body.model = raw.model;
  if (raw.system !== undefined) body.system = raw.system;
  if (raw.stream !== undefined) body.stream = raw.stream;
  if (raw.max_tokens !== undefined) body.max_tokens = raw.max_tokens;
  if (raw.temperature !== undefined) body.temperature = raw.temperature;
  if (raw.top_p !== undefined) body.top_p = raw.top_p;
  if (raw.top_k !== undefined) body.top_k = raw.top_k;
  if (raw.stop_sequences !== undefined) body.stop_sequences = raw.stop_sequences;
  if (raw.metadata !== undefined) body.metadata = raw.metadata;
  return body;
}

type ErrorType = "invalid_request" | "authentication_error" | "internal_error";

/** Consistent error envelope used across all endpoints. */
function errorResponse(type: ErrorType, message: string) {
  return { error: { type, message } };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Create the Hono proxy application.
 */
export function createApp(config: ProxyConfig): Hono {
  const app = new Hono();

  // In-memory routing stats (O(1) per request, no file reads)
  const stats = {
    totalRequests: 0,
    tierCounts: {} as Record<string, number>,
    modelCounts: {} as Record<string, number>,
    totalTokens: 0,
    totalConfidence: 0,
  };

  function recordStats(tier: string, model: string, tokens: number, confidence: number): void {
    stats.totalRequests++;
    stats.tierCounts[tier] = (stats.tierCounts[tier] ?? 0) + 1;
    stats.modelCounts[model] = (stats.modelCounts[model] ?? 0) + 1;
    stats.totalTokens += tokens;
    stats.totalConfidence += confidence;
  }

  // -- Health check --
  app.get("/health", (c) =>
    c.json({ status: "ok", plugin: "anthropic-router", port: config.port }),
  );

  // -- Test endpoint — score a prompt without forwarding --
  app.post("/test", async (c) => {
    const body = await c.req.json<{ prompt: string; system?: string }>();
    const decision = route(body.prompt, body.system, {
      config: config.routingConfig,
    });
    return c.json({
      ...decision,
      resolvedModel: resolveModelId(decision.model),
    });
  });

  // -- Stats endpoint — in-memory accumulators (O(1), no file reads) --
  app.get("/stats", (c) => {
    return c.json({
      totalRequests: stats.totalRequests,
      tierDistribution: stats.tierCounts,
      modelDistribution: stats.modelCounts,
      averageTokens: stats.totalRequests > 0
        ? Math.round(stats.totalTokens / stats.totalRequests)
        : 0,
      averageConfidence: stats.totalRequests > 0
        ? Math.round((stats.totalConfidence / stats.totalRequests) * 100) / 100
        : 0,
    });
  });

  // -- Main proxy endpoint — Anthropic Messages API format --
  app.post("/v1/messages", async (c) => {
    let rawBody: AnthropicMessagesRequest;
    try {
      rawBody = await c.req.json<AnthropicMessagesRequest>();
    } catch {
      return c.json(
        errorResponse("invalid_request", "Invalid JSON body"),
        400,
      );
    }

    if (!rawBody.messages || !Array.isArray(rawBody.messages)) {
      return c.json(
        errorResponse("invalid_request", "Missing or invalid messages array"),
        400,
      );
    }

    try {
      // Build allowlisted body (#002)
      const body = buildAllowlistedBody(rawBody);

      // Extract prompt text for scoring
      const lastUserMessage = body.messages.findLast((m) => m.role === "user");
      const promptText = extractText(lastUserMessage?.content);
      const systemText =
        typeof body.system === "string" ? body.system : "";

      // Score and select model
      let model: string;
      let tier: Tier | undefined;
      let confidence: number | undefined;

      if (config.forceModel) {
        model = config.forceModel;
      } else {
        const decision = route(promptText, systemText, {
          config: config.routingConfig,
        });
        tier = decision.tier;
        confidence = decision.confidence;
        model = resolveModelId(config.routingConfig.tiers[tier]);

        recordStats(tier, model, decision.estimatedTokens, decision.confidence);

        if (config.logEnabled) {
          logDecision(decision, promptText, config.logPath);
        }
      }

      // Rewrite model and forward to Anthropic
      body.model = model;

      // Per-request credential passthrough: extract x-api-key from incoming request.
      // In plugin mode, OpenClaw forwards the user's Anthropic credentials.
      // Falls back to config.anthropicApiKey for standalone mode.
      const apiKey = c.req.header("x-api-key") ?? config.anthropicApiKey;
      if (!apiKey) {
        return c.json(
          errorResponse(
            "authentication_error",
            "Missing x-api-key header. Ensure you are logged into Claude Code.",
          ),
          401,
        );
      }

      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      // -- #006: Routing transparency headers --
      const responseHeaders: Record<string, string> = {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "application/json",
      };

      if (tier) {
        responseHeaders["X-Router-Tier"] = tier;
        responseHeaders["X-Router-Model"] = model;
      }
      if (confidence !== undefined) {
        responseHeaders["X-Router-Confidence"] = String(confidence);
      }

      if (body.stream) {
        responseHeaders["Cache-Control"] = "no-cache, no-transform";
        responseHeaders["Connection"] = "keep-alive";
        responseHeaders["X-Accel-Buffering"] = "no";
      }

      // Pipe response through (zero-copy for both streaming and non-streaming)
      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch (err) {
      // -- #007: No internal config in error response --
      console.error("Routing failed:", err);
      return c.json(
        errorResponse("internal_error", "Internal routing error"),
        500,
      );
    }
  });

  return app;
}

export { DEFAULT_ROUTING_CONFIG, route } from "./router/index.js";
