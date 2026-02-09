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
import { route, DEFAULT_ROUTING_CONFIG, maxTier } from "./router/index.js";
import type { RoutingConfig, Tier } from "./router/types.js";
import { logDecision } from "./logger.js";
import { readFile } from "node:fs/promises";

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

/** Max length for client-provided message IDs (prevents memory abuse). */
const MAX_MESSAGE_ID_LENGTH = 256;

/** Max allowed max_tokens value to prevent cost abuse. */
const MAX_ALLOWED_TOKENS = 16384;

// Map short tier model names to full Anthropic API model IDs
const TIER_TO_MODEL: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-6",
};

export type ProxyConfig = {
  port: number;
  anthropicApiKey: string;
  proxySecret: string;
  routingConfig: RoutingConfig;
  logEnabled: boolean;
  logPath: string;
  forceModel?: string;
  maxAllowedTokens?: number;
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
  maxTokens: number,
): AnthropicMessagesRequest {
  const body: AnthropicMessagesRequest = {
    messages: raw.messages,
  };
  if (raw.model !== undefined) body.model = raw.model;
  if (raw.system !== undefined) body.system = raw.system;
  if (raw.stream !== undefined) body.stream = raw.stream;
  if (raw.max_tokens !== undefined) {
    body.max_tokens = Math.min(raw.max_tokens, maxTokens);
  }
  if (raw.temperature !== undefined) body.temperature = raw.temperature;
  if (raw.top_p !== undefined) body.top_p = raw.top_p;
  if (raw.top_k !== undefined) body.top_k = raw.top_k;
  if (raw.stop_sequences !== undefined) body.stop_sequences = raw.stop_sequences;
  return body;
}

/** Truncate a message ID to prevent memory abuse. */
function safeMessageId(id: string): string {
  return id.slice(0, MAX_MESSAGE_ID_LENGTH);
}

/** Consistent error envelope used across all endpoints. */
function errorResponse(type: string, message: string) {
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
  const maxTokensCap = config.maxAllowedTokens ?? MAX_ALLOWED_TOKENS;

  // -- #004: messageTiers scoped per app instance --
  const messageTiers = new Map<string, Tier>();
  const MAX_TRACKED = 1000;

  function trackTier(id: string, tier: Tier): void {
    if (messageTiers.size >= MAX_TRACKED) {
      const first = messageTiers.keys().next().value;
      if (first !== undefined) messageTiers.delete(first);
    }
    messageTiers.set(id, tier);
  }

  // -- #001: Bearer token auth middleware --
  app.use("*", async (c, next) => {
    // /health is exempt for load balancer probes
    if (c.req.path === "/health") return next();

    const authHeader = c.req.header("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        errorResponse("authentication_error", "Missing or invalid Authorization header"),
        401,
      );
    }
    const token = authHeader.slice(7);
    if (token !== config.proxySecret) {
      return c.json(
        errorResponse("authentication_error", "Invalid bearer token"),
        401,
      );
    }
    return next();
  });

  // -- Health check (exempt from auth) --
  app.get("/health", (c) => c.json({ status: "ok" }));

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

  // -- #005: Stats endpoint — async file read --
  app.get("/stats", async (c) => {
    if (!config.logEnabled) {
      return c.json(
        errorResponse("invalid_request", "Logging is disabled"),
        400,
      );
    }

    try {
      const raw = await readFile(config.logPath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);

      const tierCounts: Record<string, number> = {};
      const modelCounts: Record<string, number> = {};
      let totalTokens = 0;
      let totalConfidence = 0;
      let count = 0;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          tierCounts[entry.tier] = (tierCounts[entry.tier] ?? 0) + 1;
          modelCounts[entry.model] = (modelCounts[entry.model] ?? 0) + 1;
          totalTokens += entry.tokens ?? 0;
          totalConfidence += entry.confidence ?? 0;
          count++;
        } catch {
          // Skip corrupt lines
        }
      }

      return c.json({
        totalRequests: count,
        tierDistribution: tierCounts,
        modelDistribution: modelCounts,
        averageTokens: count > 0 ? Math.round(totalTokens / count) : 0,
        averageConfidence:
          count > 0 ? Math.round((totalConfidence / count) * 100) / 100 : 0,
      });
    } catch {
      return c.json({
        totalRequests: 0,
        tierDistribution: {},
        modelDistribution: {},
        averageTokens: 0,
        averageConfidence: 0,
      });
    }
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
      const body = buildAllowlistedBody(rawBody, maxTokensCap);

      // Extract prompt text for scoring
      const lastUserMessage = body.messages
        .filter((m) => m.role === "user")
        .pop();
      const promptText = extractText(lastUserMessage?.content);
      const systemText =
        typeof body.system === "string" ? body.system : "";

      // Score and select model
      let model: string;
      let tier: Tier | undefined;
      let confidence: number | undefined;
      let isReply = false;
      let repliedTier: Tier | undefined;

      if (config.forceModel) {
        model = config.forceModel;
      } else {
        const decision = route(promptText, systemText, {
          config: config.routingConfig,
        });
        tier = decision.tier;
        confidence = decision.confidence;

        // Reply-aware routing: "only up" rule (#008: truncate IDs)
        const replyToRaw =
          c.req.header("x-reply-to") ?? (rawBody as Record<string, unknown>).reply_to;
        if (replyToRaw && typeof replyToRaw === "string") {
          const replyTo = safeMessageId(replyToRaw);
          const previousTier = messageTiers.get(replyTo);
          if (previousTier) {
            isReply = true;
            repliedTier = previousTier;
            tier = maxTier(previousTier, tier);
          }
        }

        model = resolveModelId(config.routingConfig.tiers[tier]);

        if (config.logEnabled) {
          logDecision(decision, promptText, config.logPath, {
            isReply,
            repliedTier,
          });
        }
      }

      // Rewrite model and forward to Anthropic
      body.model = model;

      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      // Track message tier for reply routing (#008: truncate IDs)
      const messageIdRaw =
        c.req.header("x-message-id") ?? (rawBody as Record<string, unknown>).message_id;
      if (messageIdRaw && typeof messageIdRaw === "string" && tier) {
        trackTier(safeMessageId(messageIdRaw), tier);
      }

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
