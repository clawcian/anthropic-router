---
title: "feat: Complete Anthropic Router — Proxy Server Implementation"
type: feat
date: 2026-02-09
deepened: 2026-02-09
---

# Complete Anthropic Router — Proxy Server Implementation

## Enhancement Summary

**Deepened on:** 2026-02-09
**Architecture pivot:** OpenClaw plugin hooks -> HTTP proxy server (OpenRouter-style)
**Research agents used:** architecture-strategist, security-sentinel, pattern-recognition-specialist, performance-oracle, kieran-typescript-reviewer, code-simplicity-reviewer, agent-native-reviewer, best-practices-researcher, framework-docs-researcher, + SDK API verification

### Critical Findings

1. **Architecture must change.** The `model:select` hook does not exist in OpenClaw — only 4 hooks are shipped (`before_agent_start`, `agent_end`, `message_received`, `tool_result_persist`). The project must become a proxy server that intercepts API requests, classifies them, and forwards to Anthropic with the correct model.
2. **Use `@anthropic-ai/sdk` (the direct Anthropic TypeScript SDK), not the Agent SDK.** The Agent SDK (`@anthropic-ai/claude-agent-sdk`) spawns a Claude Code child process and manages agentic sessions — it is not suitable as a thin proxy. The direct SDK provides `client.messages.create()` and `client.messages.stream()` which are the correct APIs for forwarding requests.
3. **The router scoring system (`src/router/`) is solid and reusable.** The 14-dimension classifier, config, and types need only bug fixes — no rewrite needed. Benchmarked at 4.6us for short prompts, 312us for 10K-char prompts.
4. **Transparent Anthropic proxy is the simplest viable approach.** Accept Anthropic Messages API format, rewrite the `model` field, pipe the response stream through. No SSE parsing needed for the initial version.

### Key Improvements over Original Plan

- Replaced nonexistent `model:select` hook with real HTTP proxy architecture
- Replaced fabricated `claudeCodeSession.complete()` with verified `@anthropic-ai/sdk` APIs
- Added concrete SSE streaming proxy patterns verified from real open-source implementations
- Incorporated all review agent findings (security, performance, architecture, simplicity)
- Simplified from 4 phases to 2 phases based on simplicity review feedback

---

## Overview

The Anthropic Router has a working 14-dimension scoring system, logger, and type definitions. The project is currently structured as an OpenClaw plugin, but the plugin hook it relies on (`model:select`) does not exist. This plan restructures the project as an **HTTP proxy server** (like OpenRouter) that:

1. Accepts Anthropic Messages API requests on a local port
2. Scores prompt complexity using the existing 14-dimension classifier (<1ms)
3. Rewrites the `model` field to the cheapest capable model (haiku/sonnet/opus)
4. Forwards the request to `api.anthropic.com` and pipes the response back
5. Logs every routing decision to JSONL for future LoRA training

## Problem Statement

The project cannot work as designed today because:

1. **Wrong architecture** -- The `model:select` hook doesn't exist in OpenClaw. The code is structured as a plugin but needs to be a proxy server.
2. **Config merge bug** -- `Object.assign(config.scoring, pluginConfig.scoring)` at `src/index.ts:51` replaces nested objects entirely, destroying default dimension weights.
3. **Type duplication** -- `RoutingDecision` is defined differently in `src/types.ts` (with `costEstimate`/`savings` fields never populated) and `src/router/types.ts`.
4. **No tests** -- 14 dimensions and configurable weights with zero test coverage.
5. **Build toolchain incomplete** -- `node_modules` not installed, ESLint referenced but not in devDependencies.

## Proposed Solution

Two phases: (1) fix bugs, consolidate types, and build the proxy server; (2) add tests, reply routing, and polish. Phase 1 produces a working proxy. Phase 2 adds quality and the "only up" reply feature.

## Technical Approach

### Phase 1: Working Proxy Server

#### 1a. Fix `buildConfig()` deep merge bug

**File:** `src/index.ts:43-61`

The current code at line 51 does `Object.assign(config.scoring, pluginConfig.scoring)` which replaces the entire `scoring` object including its nested `dimensionWeights` and `tierBoundaries`. If a user overrides one weight, all 13 others become `undefined`.

**Fix:** Merge only specified nested fields:

```typescript
function buildConfig(pluginConfig?: PluginConfig): RoutingConfig {
  const config = structuredClone(DEFAULT_ROUTING_CONFIG);
  if (!pluginConfig) return config;

  if (pluginConfig.tiers) {
    Object.assign(config.tiers, pluginConfig.tiers);
  }

  if (pluginConfig.scoring) {
    if (pluginConfig.scoring.dimensionWeights) {
      Object.assign(config.scoring.dimensionWeights, pluginConfig.scoring.dimensionWeights);
    }
    if (pluginConfig.scoring.tierBoundaries) {
      Object.assign(config.scoring.tierBoundaries, pluginConfig.scoring.tierBoundaries);
    }
    if (pluginConfig.scoring.confidenceThreshold !== undefined) {
      config.scoring.confidenceThreshold = pluginConfig.scoring.confidenceThreshold;
    }
  }

  if (pluginConfig.overrides) {
    Object.assign(config.overrides, pluginConfig.overrides);
  }

  return config;
}
```

**Note from architecture review:** The original plan incorrectly referenced `config.scoring.ambiguousDefaultTier` — this field is actually at `config.overrides.ambiguousDefaultTier`. The fix above handles `overrides` as a separate merge target.

#### 1b. Consolidate type definitions

**Problem:** `src/types.ts` duplicates router types from `src/router/types.ts`, with divergent fields (`costEstimate`, `savings` in `src/types.ts` that are never populated; `PluginConfig` defined in 3 places).

**Fix:**
- `src/router/types.ts` remains the canonical location for: `Tier`, `ScoringResult`, `RoutingDecision`, `ScoringConfig`, `TierConfig`, `RoutingConfig`
- `src/types.ts` is **deleted** — the OpenClaw plugin API types (`OpenClawPluginApi`, `OpenClawPluginDefinition`, etc.) are no longer needed since we're building a proxy server, not a plugin
- `PluginConfig` moves to the new proxy server entry point as `ProxyConfig`
- All imports updated accordingly

#### 1c. Fix `expandPath()` when HOME is undefined

**File:** `src/logger.ts:66-71`

Current code produces `/routing-log.jsonl` at filesystem root if `HOME` is unset.

```typescript
export function expandPath(filePath: string): string {
  if (!filePath.startsWith("~")) return filePath;
  const home = process.env.HOME;
  if (!home) return filePath; // Return unexpanded; mkdirSync will fail safely
  return filePath.replace("~", home);
}
```

**Security note from review:** Also validate that `logPath` doesn't escape intended directories (no `..` traversal). Add to `expandPath`:

```typescript
import { resolve } from "node:path";

export function expandPath(filePath: string): string {
  if (!filePath.startsWith("~")) return resolve(filePath);
  const home = process.env.HOME;
  if (!home) return filePath;
  const expanded = filePath.replace("~", home);
  // Ensure resolved path is under home
  const resolved = resolve(expanded);
  if (!resolved.startsWith(home)) return filePath;
  return resolved;
}
```

#### 1d. Fix prompt hash truncation (security)

**File:** `src/logger.ts:39-42`

Current code truncates SHA-256 to 12 hex chars (48 bits), which is too short — birthday attack collision at ~16M entries.

**Fix:** Use full SHA-256 hex digest (64 chars):

```typescript
const promptHash = createHash("sha256").update(prompt).digest("hex");
```

#### 1e. Build the proxy server

**New file:** `src/server.ts`

This is the core architectural change. Replace the OpenClaw plugin entry point with an HTTP proxy server.

**Dependencies to add:**
- `hono` — lightweight HTTP framework (works on Node, Bun, Cloudflare Workers)
- `@anthropic-ai/sdk` — official Anthropic TypeScript SDK (for type definitions and optionally as the forwarding client)

```typescript
import { Hono } from "hono";
import { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
import type { RoutingConfig, Tier } from "./router/types.js";
import { logDecision, expandPath } from "./logger.js";

const TIER_TO_MODEL: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-6",
};

type ProxyConfig = {
  port: number;
  anthropicApiKey: string;
  routingConfig: RoutingConfig;
  logEnabled: boolean;
  logPath: string;
  forceModel?: string;
};

function createApp(config: ProxyConfig) {
  const app = new Hono();

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Anthropic Messages API proxy
  app.post("/v1/messages", async (c) => {
    try {
      const body = await c.req.json();

      // Extract prompt text for scoring
      const lastUserMessage = body.messages
        ?.filter((m: { role: string }) => m.role === "user")
        .pop();
      const promptText = extractText(lastUserMessage?.content);
      const systemText = typeof body.system === "string" ? body.system : "";

      // Score and select model
      let model: string;
      if (config.forceModel) {
        model = config.forceModel;
      } else {
        const decision = route(promptText, systemText, {
          config: config.routingConfig,
        });
        const tierModel = config.routingConfig.tiers[decision.tier];
        model = TIER_TO_MODEL[tierModel] ?? tierModel;

        if (config.logEnabled) {
          logDecision(decision, promptText, config.logPath);
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

      // Pipe response through (works for both streaming and non-streaming)
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type":
            upstream.headers.get("Content-Type") ?? "application/json",
          ...(body.stream
            ? {
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              }
            : {}),
        },
      });
    } catch (err) {
      // Fallback: forward with default tier model
      const fallbackTier = config.routingConfig.overrides.ambiguousDefaultTier;
      const fallbackModel =
        TIER_TO_MODEL[config.routingConfig.tiers[fallbackTier]];
      console.error("Routing failed, falling back to", fallbackModel, err);
      // Could re-attempt forward with fallback model, or return error
      return c.json({ error: "Routing failed" }, 500);
    }
  });

  return app;
}
```

**Key design decisions (from research):**
- **Transparent proxy pattern:** Accept Anthropic format, rewrite only `model`, pipe response bytes through unchanged. No SSE parsing needed.
- **`Response(upstream.body, ...)`** creates zero-copy stream passthrough — the Anthropic SSE stream pipes directly to the client.
- **Hono** is chosen for its simplicity (no middleware boilerplate), native `ReadableStream` support, and compatibility with Node.js, Bun, and edge runtimes.
- **Error handling:** Catch routing failures and either forward with a fallback model or return 500. Never crash the proxy.

#### 1f. Create entry point

**New file:** `src/index.ts` (replaces current plugin entry point)

```typescript
import { serve } from "@hono/node-server";
import { createApp } from "./server.js";
import { DEFAULT_ROUTING_CONFIG } from "./router/index.js";
import { expandPath } from "./logger.js";

const config = {
  port: parseInt(process.env.PORT ?? "8403", 10),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  routingConfig: DEFAULT_ROUTING_CONFIG,
  logEnabled: process.env.LOG_ENABLED !== "false",
  logPath: expandPath(process.env.LOG_PATH ?? "~/.openclaw/routing-log.jsonl"),
  forceModel: process.env.FORCE_MODEL || undefined,
};

if (!config.anthropicApiKey) {
  console.error("ANTHROPIC_API_KEY environment variable is required");
  process.exit(1);
}

const app = createApp(config);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Anthropic Router listening on http://localhost:${info.port}`);
  console.log(`Tiers: SIMPLE=${config.routingConfig.tiers.SIMPLE}, MEDIUM=${config.routingConfig.tiers.MEDIUM}, COMPLEX=${config.routingConfig.tiers.COMPLEX}`);
});

// Re-export for programmatic use
export { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
export { createApp } from "./server.js";
export type { RoutingDecision, Tier, RoutingConfig } from "./router/types.js";
```

#### 1g. Update package.json

```json
{
  "name": "anthropic-router",
  "version": "0.2.0",
  "description": "Proxy server that routes requests to the cheapest Anthropic model based on complexity",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "hono": "^4.0.0",
    "@hono/node-server": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "eslint": "^9.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0"
  }
}
```

**Note:** `@anthropic-ai/sdk` is intentionally NOT a runtime dependency. The proxy uses `fetch()` directly to forward requests, which avoids adding the SDK's weight. The SDK types are only useful if we want to validate request/response shapes, which can be added later.

#### 1h. Delete obsolete files

- `src/types.ts` — OpenClaw plugin API types no longer needed
- `openclaw.plugin.json` — plugin manifest no longer needed

#### 1i. Add `extractText()` utility

**File:** `src/server.ts` (helper function)

Anthropic message content can be a string or an array of content blocks:

```typescript
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join(" ");
  }
  return "";
}
```

### Phase 2: Tests, Reply Routing, and Polish

#### 2a. Install dependencies and verify build

```bash
npm install
npm run build
npm run typecheck
```

Fix any compilation errors.

#### 2b. Write tests

**File:** `src/router/__tests__/rules.test.ts`

Priority test cases for the scoring system:

| Test Case | Input | Expected Tier | Why |
|-----------|-------|---------------|-----|
| Empty prompt | `""` | SIMPLE | No signals, negative token score |
| Simple question | `"What is 2+2?"` | SIMPLE | Matches "what is" simple indicator |
| Complex reasoning | `"Prove the Riemann hypothesis step by step"` | COMPLEX | 2+ reasoning keywords force COMPLEX |
| Code request | `"Write an async function that handles errors"` | MEDIUM or COMPLEX | Code + imperative verb |
| Creative task | `"Write a short poem about cats"` | MEDIUM | Creative marker |
| Very long prompt (>100K tokens) | 500K chars | COMPLEX | Large context override |
| Ambiguous prompt | `"hello"` | MEDIUM | Low confidence, defaults to ambiguous tier |
| CJK simple | `"什么是量子计算？"` | Varies | Tests CJK keyword matching |
| 2 reasoning keywords | `"analyze and prove"` | COMPLEX | Special force-COMPLEX rule |

**File:** `src/router/__tests__/config-merge.test.ts`

| Test Case | User Config | Expected |
|-----------|-------------|----------|
| No user config | `undefined` | All defaults preserved |
| One weight override | `{ scoring: { dimensionWeights: { reasoningMarkers: 0.25 } } }` | reasoningMarkers=0.25, all others unchanged |
| Tier override | `{ tiers: { SIMPLE: "sonnet" } }` | SIMPLE=sonnet, MEDIUM/COMPLEX unchanged |

**File:** `src/__tests__/server.test.ts`

| Test Case | Expected |
|-----------|----------|
| POST /v1/messages routes correctly | Model field rewritten based on scoring |
| GET /health returns ok | `{ status: "ok" }` |
| Missing API key returns error | Appropriate error response |
| Streaming request passes through | SSE headers set correctly |

**File:** `src/__tests__/logger.test.ts`

| Test Case | Expected |
|-----------|----------|
| Log entry written to file | File contains valid JSONL |
| Prompt is hashed, not stored | `promptHash` is full SHA-256 hex, no raw prompt |
| Directory auto-created | Logger creates parent dirs |

#### 2c. Implement reply-aware routing

The "only up" rule is the design doc's core differentiating feature. It ensures follow-up messages to complex threads maintain quality.

**Add tier comparison utility to `src/router/types.ts`:**

```typescript
const TIER_ORDER: Record<Tier, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2 };

export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}
```

**Add bounded tier map to `src/server.ts`:**

Use a simple bounded `Map` (FIFO eviction, not LRU — simpler and sufficient):

```typescript
const messageTiers = new Map<string, Tier>();
const MAX_TRACKED = 1000;

function trackTier(id: string, tier: Tier): void {
  if (messageTiers.size >= MAX_TRACKED) {
    const first = messageTiers.keys().next().value;
    if (first !== undefined) messageTiers.delete(first);
  }
  messageTiers.set(id, tier);
}
```

**Note from simplicity review:** The `BoundedTierMap` class from the original plan is overengineered for a simple Map wrapper. Inline functions are clearer.

**Update proxy handler:**

The proxy needs a way to receive reply context. Two options:
1. **Custom header:** `X-Reply-To: <message_id>` — client signals reply context
2. **Request body field:** If OpenClaw adds `reply_to` to the request body, the proxy reads it

The implementation checks for both and gracefully degrades if neither is present:

```typescript
// In POST /v1/messages handler:
const replyTo = c.req.header("x-reply-to") ?? body.reply_to;
let tier = decision.tier;

if (replyTo) {
  const repliedTier = messageTiers.get(replyTo);
  if (repliedTier) {
    tier = maxTier(repliedTier, tier);
  }
}

// After forwarding, store the tier for future lookups
// The response message ID comes from Anthropic's response
// For non-streaming: parse response JSON to get id
// For streaming: parse the message_start event to get id
```

**Open question:** Extracting the response message ID from a streaming response requires parsing the `message_start` SSE event, which breaks the zero-copy passthrough. Two options:
1. Use a `TransformStream` to observe (not modify) the stream and extract the ID
2. Have the client send a `X-Message-Id` header with a client-generated ID

Option 2 is simpler and avoids stream parsing. The proxy trusts the client to provide stable IDs.

#### 2d. Update logger for reply metadata

Add optional `isReply` and `repliedTier` fields to `LogEntry`:

```typescript
export type LogEntry = {
  ts: number;
  promptHash: string;
  tier: string;
  model: string;
  tokens: number;
  confidence: number;
  signals: string[];
  reasoning: string;
  isReply?: boolean;
  repliedTier?: string;
};
```

#### 2e. Add `/stats` endpoint

Replace the `/route-stats` command with an HTTP endpoint:

```typescript
app.get("/stats", (c) => {
  // Read and parse JSONL log, return stats as JSON
  // Add per-line try-catch for corrupt lines
  // Handle empty log gracefully
});
```

#### 2f. Add `/test` endpoint for manual testing

Replace the `/route` command with an HTTP endpoint:

```typescript
app.post("/test", async (c) => {
  const { prompt, system } = await c.req.json();
  const decision = route(prompt, system, { config: routingConfig });
  return c.json(decision);
});
```

#### 2g. ESLint setup

Use ESLint 9 flat config with TypeScript:

```bash
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
```

Create `eslint.config.js` with flat config format targeting TypeScript + ESM.

## Acceptance Criteria

### Functional Requirements

- [ ] Proxy accepts Anthropic Messages API format at `POST /v1/messages`
- [ ] Prompt is scored and model field is rewritten before forwarding
- [ ] Streaming responses (SSE) are piped through correctly
- [ ] Non-streaming responses are forwarded correctly
- [ ] `ANTHROPIC_API_KEY` is required at startup
- [ ] `buildConfig()` correctly deep-merges partial overrides without losing defaults
- [ ] Type definitions exist in one canonical location (no duplication)
- [ ] Routing failures fall back to the default tier model
- [ ] Log entries include full SHA-256 prompt hash (not truncated)
- [ ] `GET /health` returns status

### Non-Functional Requirements

- [ ] Project builds successfully (`npm run build`)
- [ ] TypeScript strict mode passes (`npm run typecheck`)
- [ ] All tests pass (`npm run test`)
- [ ] Routing decision completes in <1ms for prompts under 10K chars (benchmarked: 312us at 10K chars)
- [ ] SSE proxy uses zero-copy stream passthrough (no buffering)

### Quality Gates

- [ ] Test coverage for scoring dimensions
- [ ] Test coverage for config merge edge cases
- [ ] Test coverage for proxy routing (request -> model selection -> forwarding)
- [ ] No TypeScript errors with strict mode

## Verified API Surface

### Anthropic Messages API (upstream target)

**Endpoint:** `POST https://api.anthropic.com/v1/messages`

**Headers:**
- `Content-Type: application/json`
- `x-api-key: <ANTHROPIC_API_KEY>`
- `anthropic-version: 2023-06-01`

**Request body:**
```json
{
  "model": "claude-haiku-4-5-20251001",
  "system": "You are helpful.",
  "messages": [{"role": "user", "content": "Hello"}],
  "max_tokens": 1024,
  "stream": true
}
```

**Current model IDs (verified):**
| Tier | Model Name | API ID |
|------|-----------|--------|
| SIMPLE | Haiku 4.5 | `claude-haiku-4-5-20251001` |
| MEDIUM | Sonnet 4.5 | `claude-sonnet-4-5-20250929` |
| COMPLEX | Opus 4.6 | `claude-opus-4-6` |

**SSE event types:** `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping`, `error`

### What is NOT used (and why)

| API/SDK | Why Not |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Spawns Claude Code child processes; designed for agentic workflows, not thin proxying. Model selection limited to aliases. |
| `@anthropic-ai/sdk` | Adds runtime weight for no benefit — the proxy only needs `fetch()` to forward requests. Could add later for request validation. |
| OpenClaw `model:select` hook | Does not exist. Only 4 hooks are shipped: `before_agent_start`, `agent_end`, `message_received`, `tool_result_persist`. |
| `claude-code-js` `claude.chat()` | This is the Claude Code SDK for agentic tasks, not for API proxying. |

## Dependencies & Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Anthropic model IDs change | Low | Medium | Use aliases (`claude-haiku-4-5`) which auto-resolve to latest; make model map configurable |
| SSE stream corruption in proxy | Low | High | Zero-copy passthrough avoids parsing; integration test with streaming |
| `appendFileSync` in logger blocks event loop | High | Low | Acceptable for now; move to async buffered writes in future |
| Keyword substring false positives | Medium | Low | Known limitation; word-boundary matching deferred |
| Reply routing message ID mismatch | Medium | Low | Graceful degradation — untracked IDs treated as fresh messages |

## Performance (Benchmarked)

From the performance review agent's actual benchmarks on the existing scoring code:

| Input | Chars | Time | Result |
|-------|-------|------|--------|
| Short simple ("What is 2+2?") | 12 | 4.6us | SIMPLE |
| Medium code (async function) | 57 | 5.4us | MEDIUM |
| Complex reasoning (step by step) | 64 | 5.3us | COMPLEX |
| Long prompt 2K | 2,344 | 66.6us | COMPLEX |
| Long prompt 10K | 11,624 | 312.3us | COMPLEX |
| Long prompt 50K | 58,024 | 1,554.9us | COMPLEX |

The 50K case exceeds the 1ms target. For prompts of this size, the `maxTokensForceComplex` override (100K tokens) will short-circuit scoring entirely, so in practice the hot path stays under 1ms.

**Future optimization:** The 148 keywords are scanned via `String.includes()` per dimension (10/14 dimensions use keyword matching). An Aho-Corasick automaton would reduce 50K prompt scanning from ~43M string ops to ~51K transitions. This is out of scope but worth noting for scale.

## Security Considerations (from review)

1. **Prompt hash truncation** — Fixed in 1d (use full SHA-256)
2. **Log file permissions** — Set `mode: 0o600` on `mkdirSync` and consider `chmod` on the log file
3. **Path traversal in logPath** — Fixed in 1c (validate resolved path stays under HOME)
4. **API key handling** — Read from environment variable only, never log it, never include in responses
5. **Request validation** — Validate incoming request has `messages` array before accessing it; return 400 for malformed requests

## Future Considerations

Out of scope for this plan:

1. **OpenAI-compatible ingress** — Add `POST /v1/chat/completions` endpoint that translates OpenAI format to Anthropic format, enabling drop-in compatibility with tools that speak OpenAI API
2. **Async logging** — Replace `appendFileSync` with buffered async writes
3. **Word-boundary keyword matching** — Use `\b` regex instead of `includes()`
4. **Log rotation** — Auto-rotate JSONL by size or date
5. **Multi-language expansion** — Korean, Spanish, French, German, Arabic, Hindi keywords
6. **LoRA training pipeline** — Train a classifier on logged data to replace keyword rules
7. **Cost tracking** — Add `costEstimate` and `savings` fields to responses
8. **Rate limiting** — Per-client rate limits on the proxy
9. **Aho-Corasick keyword matching** — For prompts >10K chars

## References

### Internal References

- Design doc: `docs/DESIGN.md`
- Scoring rules: `src/router/rules.ts`
- Default config: `src/router/config.ts`
- Router types: `src/router/types.ts`
- Router entry: `src/router/index.ts`
- Logger: `src/logger.ts`

### External References (Verified)

- [Anthropic Messages API — Streaming](https://platform.claude.com/docs/en/api/messages-streaming)
- [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) — MIT licensed, reference for types
- [Anthropic Model Overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Hono — Lightweight Web Framework](https://hono.dev/)
- [kiyo-e/claude-code-proxy](https://github.com/kiyo-e/claude-code-proxy) — Real-world Hono proxy for Claude (reference implementation)
- [OpenRouter API Reference](https://openrouter.ai/docs/api/reference/overview) — Architectural reference
- [ClawRouter](https://github.com/BlockRunAI/ClawRouter) — Upstream routing logic (MIT licensed)
- [Vitest Documentation](https://vitest.dev/) — Test framework
