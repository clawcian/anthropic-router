---
title: "Building an Anthropic API Proxy from Scratch: Plan → Implementation → Hardening"
date: 2026-02-09
category: security-issues
tags:
  - security
  - authentication
  - validation
  - type-safety
  - architecture
  - performance
  - proxy
  - anthropic
  - hono
  - typescript
severity: critical
component: anthropic-router
symptoms:
  - OpenClaw plugin architecture based on nonexistent model:select hook
  - No authentication protecting proxy endpoints
  - Unvalidated request body passthrough to upstream API
  - Type safety holes with any types in request handling
  - Shared mutable state at module level causing test isolation failures
  - Synchronous I/O on hot path degrading performance
  - Missing routing decision transparency in responses
  - Error responses leaking internal configuration
  - Message IDs lacking length validation
  - Outdated documentation describing plugin architecture
  - Inconsistent token estimation across modules
root_cause: >
  Project was scaffolded as an OpenClaw plugin targeting a hook (model:select) that
  doesn't exist. Required complete architectural pivot to standalone HTTP proxy, then
  three phases of implementation with progressive hardening.
resolution: >
  3-phase build: (1) Architecture pivot + working proxy, (2) Tests + reply routing +
  stats, (3) Security hardening + 11 code review findings resolved. 43 tests passing.
prevention: >
  Verify target APIs exist before designing architecture. Use multi-agent code review
  (/workflows:review) to catch security, architecture, and quality issues early.
  Enforce strict TypeScript and ESLint rules from day one.
related_issues: []
time_to_resolve: "~6 hours across 3 phases"
---

# Building an Anthropic API Proxy from Scratch

## The Problem

We had a scoring system — a 14-dimension weighted classifier that analyzes prompt complexity in <1ms — but it was trapped inside an OpenClaw plugin scaffold targeting a `model:select` hook that doesn't exist. Only 4 OpenClaw hooks ship: `before_agent_start`, `agent_end`, `message_received`, `tool_result_persist`. None intercept model selection.

The goal: route every Anthropic API request to the cheapest capable model (haiku $1/M, sonnet $3/M, opus $15/M) and save ~74% on a typical workload.

## The Journey: Plan → Build → Harden

### Phase 0: Research & Planning

**Tool used:** `/workflows:plan` + `/deepen-plan` with 10 research agents

The plan phase discovered the critical architectural mismatch and pivoted from plugin to proxy. Key findings:

1. **`model:select` hook doesn't exist** — architecture must change to HTTP proxy
2. **`@anthropic-ai/claude-agent-sdk` is wrong** — it spawns Claude Code processes, not API calls
3. **The scoring system is solid** — 14 dimensions, benchmarked at 4.6μs–312μs, needs only bug fixes
4. **Simplest approach: transparent proxy** — accept Anthropic format, rewrite `model` field, pipe response through

The plan was structured as 2 phases (later extended to 3 after code review).

**Artifact:** `docs/plans/2026-02-09-feat-anthropic-router-implementation-plan.md`

### Phase 1: Working Proxy Server

Pivoted from OpenClaw plugin to standalone Hono HTTP proxy.

**What was built:**
- `src/server.ts` — Hono app with `/health`, `/test`, `/v1/messages` endpoints
- `src/index.ts` — Entry point with env var config, `@hono/node-server`
- Zero-copy SSE streaming via `new Response(upstream.body, { headers })`

**What was fixed:**
- `buildConfig()` deep merge bug — `Object.assign` replaced nested objects; fixed with field-level merging
- Type duplication — `src/types.ts` deleted, consolidated to `src/router/types.ts`
- Logger prompt hash — truncated SHA-256 expanded to full 64-char hex
- Logger path traversal — `expandPath()` validates resolved path
- Logger signal parsing — greedy regex `\(.*\)$` fixed to `\([^)]*\)` with global flag

**What was deleted:**
- `openclaw.plugin.json` — plugin manifest
- `src/types.ts` — duplicated OpenClaw plugin API types

### Phase 2: Tests, Reply Routing, Polish

**Test coverage:**
- 20 router tests: tier classification (SIMPLE/MEDIUM/COMPLEX), scoring, signals, system prompt handling, multi-step patterns, question complexity
- 18 server tests: health, test endpoint, proxy validation, stats, reply routing

**Features added:**
- Reply-aware routing: `maxTier()` "only up" rule with bounded FIFO map (1000 entries)
- `/stats` endpoint: reads JSONL log, returns tier/model distribution and averages
- ESLint 9 flat config with `@typescript-eslint`
- Logger: `isReply`/`repliedTier` optional fields

### Phase 3: Code Review & Hardening

**Tool used:** `/workflows:review` — 7 specialized review agents in parallel

The review produced 11 findings across security (P1), architecture (P2), and quality (P3). All resolved in a single batch:

#### P1 Security (Critical)

**#001: No authentication on any endpoint**

Every route was open to any network client. The proxy attaches the operator's `ANTHROPIC_API_KEY` to every upstream request — effectively an open relay.

```typescript
// Fix: Bearer token middleware with /health exempt
app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const authHeader = c.req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(errorResponse("authentication_error", "Missing or invalid Authorization header"), 401);
  }
  const token = authHeader.slice(7);
  if (token !== config.proxySecret) {
    return c.json(errorResponse("authentication_error", "Invalid bearer token"), 401);
  }
  return next();
});
```

**#002: Unvalidated body passthrough**

The entire parsed JSON body was forwarded to Anthropic. A client could inject `max_tokens: 128000` for cost abuse or spoof `metadata.user_id`.

```typescript
// Fix: Explicit field allowlist
function buildAllowlistedBody(raw: AnthropicMessagesRequest, maxTokens: number): AnthropicMessagesRequest {
  const body: AnthropicMessagesRequest = { messages: raw.messages };
  if (raw.model !== undefined) body.model = raw.model;
  if (raw.system !== undefined) body.system = raw.system;
  if (raw.stream !== undefined) body.stream = raw.stream;
  if (raw.max_tokens !== undefined) body.max_tokens = Math.min(raw.max_tokens, maxTokens);
  // ... only known fields
  return body;
}
```

**#003: `any` type for request body**

`body: any` at line 196 was the single biggest type safety hole — all property accesses were unchecked at compile time.

```typescript
// Fix: Typed request body
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

// ESLint promoted: "warn" → "error"
"@typescript-eslint/no-explicit-any": "error"
```

#### P2 Architecture

**#004: Module-level messageTiers** — Moved into `createApp` closure. Each app instance gets independent state. `_getMessageTiers()` test helper removed.

**#005: Sync I/O on hot path** — `/stats` endpoint changed from `readFileSync` to async `readFile`. Logger was already fixed in Phase 1 (async `appendFile` + `ensuredDirs` cache).

**#006: Routing transparency** — Added `X-Router-Tier`, `X-Router-Model`, `X-Router-Confidence` headers to every proxied response.

**#007: Error info leak** — Removed `fallbackModel` from 500 responses. Adopted consistent `{ error: { type, message } }` envelope across all error paths.

**#008: Message ID length** — Client-controlled strings truncated to 256 characters before storage in the bounded map.

#### P3 Quality

**#009: Outdated README** — Rewritten from OpenClaw plugin docs to standalone proxy: installation, env vars, endpoints, routing explanation.

**#010: Token estimation inconsistency** — Added `estimatedTokens` field to `RoutingDecision` type. Logger now uses `decision.estimatedTokens` instead of re-computing.

**#011: buildConfig YAGNI** — Kept as-is (wont_fix). The merge logic is correct, tested, and will be needed for config overrides.

## Final Architecture

```
Client → [Auth Middleware] → [Body Allowlist] → [Router Scoring <1ms]
       → [Model Rewrite] → api.anthropic.com → [Zero-copy SSE Passthrough]
       → [X-Router-* Headers] → Client
```

**Endpoints:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | No | Load balancer health check |
| POST | /v1/messages | Yes | Anthropic Messages API proxy |
| POST | /test | Yes | Score a prompt without forwarding |
| GET | /stats | Yes | Aggregated routing statistics |

**Environment Variables:**

| Variable | Required | Description |
|----------|----------|-------------|
| ANTHROPIC_API_KEY | Yes | Anthropic API key |
| PROXY_SECRET | Yes | Bearer token for proxy clients |
| PORT | No | Server port (default: 8403) |
| LOG_ENABLED | No | JSONL logging (default: true) |
| LOG_PATH | No | Log file path |
| FORCE_MODEL | No | Force specific model (testing) |

## Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/server.ts` | ~310 | Hono app factory with all endpoints |
| `src/index.ts` | ~50 | Entry point, env config |
| `src/router/index.ts` | ~78 | `route()` function, token estimation |
| `src/router/rules.ts` | ~250 | 14-dimension weighted classifier |
| `src/router/types.ts` | ~85 | All TypeScript types |
| `src/router/config.ts` | ~200 | Default config, keyword lists |
| `src/logger.ts` | ~90 | Async JSONL logger |
| `src/server.test.ts` | ~230 | 23 server tests |
| `src/router/rules.test.ts` | ~210 | 20 router tests |

## Prevention Strategies

### For Future Proxy Projects

1. **Auth from day one** — Never deploy a proxy without authentication, even internally. The operator's API key is as sensitive as the end-user's.
2. **Allowlist, don't blocklist** — Explicit field forwarding prevents unknown future fields from reaching upstream.
3. **Strict TypeScript** — `no-explicit-any: error` catches type holes at compile time. Define types for all external input.
4. **Scope mutable state** — Factory functions should create per-instance state, not share module-level singletons.
5. **Async everything** — No sync I/O on request hot paths. Use `fs/promises` and fire-and-forget patterns.
6. **Generic error responses** — Never leak config, model names, or internal details in error messages.
7. **Bound client-controlled data** — Truncate strings, cap numbers, evict old entries.

### Automated Checks

- `@typescript-eslint/no-explicit-any: error` — catches type safety regressions
- `vitest run` — 43 tests covering auth, validation, routing, error format
- Pre-commit: `tsc --noEmit && eslint src/` — type check + lint

## Workflow That Built This

```
/workflows:plan          → Implementation plan with research agents
/deepen-plan             → 10 specialized agents deepened each section
[manual implementation]  → Phase 1 (proxy) + Phase 2 (tests, features)
/workflows:review        → 7 review agents found 11 issues
/triage                  → Approved all 11 findings
/resolve_todo_parallel   → Resolved all findings in one batch
/workflows:compound      → This document
```

The entire project — from scaffold to production-hardened proxy with 43 tests — was built in a single day using agent-assisted workflows.

## Performance

| Input Size | Routing Time | Tier |
|------------|-------------|------|
| 12 chars | 4.6μs | SIMPLE |
| 57 chars | 5.4μs | MEDIUM |
| 2K chars | 66.6μs | COMPLEX |
| 10K chars | 312μs | COMPLEX |
| 50K chars | 1.55ms | COMPLEX |

All routing decisions complete in <1ms for typical prompts. The 50K case is short-circuited by the `maxTokensForceComplex` override.

## Cost Savings

| Tier | % Traffic | Model | Cost/M |
|------|-----------|-------|--------|
| SIMPLE | ~45% | haiku | $1.00 |
| MEDIUM | ~40% | sonnet | $3.00 |
| COMPLEX | ~15% | opus | $15.00 |
| **Blended** | | | **$3.90/M** |

vs. $15/M always-Opus = **74% savings**
