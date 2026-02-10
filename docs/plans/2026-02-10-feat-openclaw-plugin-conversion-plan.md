---
title: "feat: Convert Anthropic Router to OpenClaw Plugin"
type: feat
date: 2026-02-10
brainstorm: docs/brainstorms/2026-02-10-openclaw-plugin-conversion-brainstorm.md
---

# Convert Anthropic Router to OpenClaw Plugin

## Overview

Convert the existing standalone HTTP proxy into a proper OpenClaw plugin, modeled after ClawRouter. The plugin registers as a selectable model provider so users can switch to smart Anthropic routing with `/model anthropic-router/auto`.

The routing engine (14-dimension weighted classifier, <1ms, 43 tests) and proxy plumbing are solid and reusable. The work is adding the OpenClaw plugin wrapper, refactoring auth, and handling lifecycle.

## Problem Statement / Motivation

The current Anthropic Router is a standalone proxy that requires manual base URL reconfiguration to use. ClawRouter proves that OpenClaw plugins can register as model providers — users just run `/model blockrun/auto` and it works. We should provide the same seamless experience for Anthropic-specific smart routing.

**User experience today:**
1. Start proxy manually
2. Edit OpenClaw auth profile to point at `localhost:8403`
3. Hope the proxy is running when you need it

**User experience after:**
```bash
openclaw plugins install ./anthropic-router
/model anthropic-router/auto
# Done. 74% cost savings, transparent.
```

## Proposed Solution

Add an OpenClaw plugin scaffold around the existing proxy. The plugin:

1. **Registers** a provider (`anthropic-router`) with one model (`auto`)
2. **Starts** the local proxy on `:8403` during `register()`
3. **Injects** config into `~/.openclaw/openclaw.json` for persistence
4. **Forwards** the user's Anthropic credentials per-request (extracted from `x-api-key` header)
5. **Scores** each prompt locally and rewrites `model` to the cheapest capable tier
6. **Streams** the response back zero-copy

## Technical Approach

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  OpenClaw                                               │
│                                                         │
│  /model anthropic-router/auto                           │
│       │                                                 │
│       ▼                                                 │
│  ProviderRegistry ──► anthropic-router provider         │
│       │                   api: "anthropic-messages"     │
│       │                   baseUrl: 127.0.0.1:8403       │
│       ▼                                                 │
│  HTTP Request ──────► x-api-key from session auth       │
└───────┬─────────────────────────────────────────────────┘
        │ POST http://127.0.0.1:8403/v1/messages
        ▼
┌───────────────────────────────────────────────────────┐
│  Anthropic Router Plugin (localhost proxy)             │
│                                                       │
│  1. Extract x-api-key from incoming request headers   │
│  2. Score prompt (14-dim classifier, <1ms)             │
│  3. Rewrite model → haiku/sonnet/opus                 │
│  4. Forward to api.anthropic.com with extracted key    │
│  5. Stream response back (zero-copy SSE passthrough)  │
│  6. Add X-Router-Tier/Model/Confidence headers        │
└───────────────────────────────────────────────────────┘
```

### Critical Design Decision: Per-Request Credential Passthrough

The standalone proxy used a single `ANTHROPIC_API_KEY` env var for all upstream calls. The plugin switches to **per-request credential extraction**: the proxy reads `x-api-key` from each incoming request's headers and forwards it upstream.

This solves:
- No API key management in the plugin
- Multiple OpenClaw sessions with different credentials work correctly
- No stored secrets, no auth profiles to inject

If the incoming request has no `x-api-key`, the proxy returns a clear error: `"Missing x-api-key header. Ensure you are logged into Claude Code."`.

### Implementation Phases

#### Phase 1: Plugin Scaffold + Auth Refactor

**Goal:** Plugin loads in OpenClaw, registers provider, proxy starts. Requests flow through with per-request auth.

**Files to create:**

- `openclaw.plugin.json`

```json
{
  "id": "anthropic-router",
  "name": "Anthropic Router",
  "description": "Smart routing — automatically selects cheapest capable Anthropic model per request",
  "configSchema": {
    "type": "object",
    "properties": {
      "port": {
        "type": "number",
        "description": "Proxy port (default: 8403)"
      },
      "forceModel": {
        "type": "string",
        "description": "Override routing and force a specific model (for testing)"
      }
    }
  }
}
```

- `src/plugin.ts` — New plugin entry point

```typescript
// Exports default OpenClawPluginDefinition
// register() does:
//   1. api.registerProvider(anthropicRouterProvider)
//   2. Inject models config into api.config (runtime)
//   3. Inject models config into openclaw.json (persistence)
//   4. api.registerService({ id, start, stop }) for proxy lifecycle
//   5. Start proxy in background (fire-and-forget)
```

- `src/provider.ts` — Provider definition

```typescript
// ProviderPlugin with:
//   id: "anthropic-router"
//   label: "Anthropic Router"
//   aliases: ["ar"]
//   auth: [] (no auth — credentials forwarded per-request)
//   get models() → buildProviderModels(activeProxy.baseUrl)
```

- `src/models.ts` — Single model definition

```typescript
// One ModelDefinitionConfig:
//   id: "auto"
//   name: "Anthropic Smart Router"
//   api: "anthropic-messages"
//   reasoning: false
//   input: ["text", "image"]
//   cost: { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 }
//   contextWindow: 200_000
//   maxTokens: 8_192
```

Model cost declared as haiku pricing (cheapest tier) since that's what most requests will use. `maxTokens: 8_192` is the safe minimum across all tiers — requests will never exceed any model's limit.

- `src/types.ts` — OpenClaw plugin API types (duck-typed, following ClawRouter pattern)

**Files to modify:**

- `src/index.ts` — Replace standalone server entry with plugin re-export. Keep programmatic exports (`route`, `classifyByRules`, etc.) for library use.

- `src/server.ts`:
  - Remove Bearer token auth middleware (lines 199-219)
  - Remove `proxySecret` from `ProxyConfig` type
  - Change upstream auth: extract `x-api-key` from incoming request headers instead of using `config.anthropicApiKey`
  - Make `anthropicApiKey` optional in `ProxyConfig` (fallback for standalone mode)
  - Bind to `127.0.0.1` only (not `0.0.0.0`)
  - Add EADDRINUSE detection: check `/health` on port before starting; if proxy already running, reuse it
  - Remove `MAX_ALLOWED_TOKENS` cap (user's own credits now)

- `package.json`:
  - Add `"openclaw": { "extensions": ["./dist/plugin.js"] }`
  - Add `"files": ["dist", "openclaw.plugin.json"]`
  - Add `"peerDependencies": { "openclaw": ">=2025.1.0" }` (optional)

- `tsup.config.ts`: Add `src/plugin.ts` to entry points

- `src/server.test.ts`:
  - Remove 5 auth tests
  - Remove `proxySecret` from test config
  - Remove `Authorization` headers from all test requests
  - Add test: request without `x-api-key` returns 401 with clear error message

**Success criteria:**
- [x] `openclaw plugins install ./anthropic-router` succeeds
- [x] `/model anthropic-router/auto` shows the model
- [x] Requests flow through proxy with per-request `x-api-key` passthrough
- [x] Proxy binds to `127.0.0.1` only
- [x] EADDRINUSE handled (detect existing proxy, reuse)
- [x] `registerService({ stop })` cleanly shuts down proxy
- [x] All existing router tests still pass (20 tests)
- [x] Updated server tests pass (remove auth tests, add credential passthrough tests)

#### Phase 2: Lifecycle Hardening + Commands

**Goal:** Robust proxy lifecycle, plugin commands, completion mode safety.

- **Completion mode detection**: Check `process.argv` for `--get-prompt-completions` before any side effects in `register()` (prevents breaking `openclaw completion --shell zsh`)

- **Proxy readiness**: After starting proxy in background, poll `/health` (max 5 attempts, 100ms apart) before reporting readiness via `api.logger.info()`

- **Plugin command: `/router stats`**: Register a command via `api.registerCommand()` that reads the JSONL log and returns tier/model distribution stats (same logic as current `GET /stats`)

- **Plugin command: `/router test <prompt>`**: Register a command for dry-run scoring (same logic as current `POST /test`)

- **Health endpoint enrichment**: Return `{ status: "ok", plugin: "anthropic-router", port: 8403, version: "..." }` so proxy reuse detection can identify which plugin owns the port

- **Error handling**: When Anthropic returns an error (401, 429, 500), log the error with tier/model context and return the upstream error to OpenClaw without modification

**Success criteria:**
- [x] `openclaw completion --shell zsh` works without side effects
- [x] Proxy readiness probe prevents ECONNREFUSED on first request
- [x] `/router stats` command works
- [x] `/router test "explain quantum computing"` returns routing decision
- [x] Anthropic API errors forwarded cleanly with routing context in logs

#### Phase 3: Config Persistence + Install Script

**Goal:** Plugin survives OpenClaw restart, clean install/uninstall experience.

- **Config injection into `openclaw.json`**: Write provider config to `~/.openclaw/openclaw.json` during `register()` (best-effort, silent failure). Include `baseUrl`, `api`, `models` array.

- **Auth profile**: Inject `anthropic-router:default` auth profile with placeholder `apiKey: "session-passthrough"`. OpenClaw may require this to exist for the provider to function.

- **Install script** (`scripts/install.sh`):
  1. Build the plugin (`npm run build`)
  2. Install via `openclaw plugins install .`
  3. Verify provider registered
  4. Print usage instructions

- **Uninstall cleanup**: Document manual cleanup steps (remove config entries from `openclaw.json`). OpenClaw's `plugins uninstall` should handle file removal.

- **Do NOT set `anthropic-router/auto` as default model** — let users opt in explicitly with `/model anthropic-router/auto`. Setting it as default on install would surprise users by routing through cheaper models without consent.

**Success criteria:**
- [x] Plugin persists across `openclaw gateway restart`
- [x] `scripts/install.sh` provides one-command setup
- [x] Config entries in `openclaw.json` are correct
- [x] Auth profile injected (if needed)
- [x] No default model override on install

## Alternative Approaches Considered

### 1. Keep standalone proxy, add thin OpenClaw config layer
Just document how to manually set `baseUrl` in the user's auth profile. No plugin code.

**Rejected because:** Poor UX. Users have to manually start the proxy, manually edit config, and manage the lifecycle themselves. The whole point is seamless integration.

### 2. Use `openai-completions` API format instead of `anthropic-messages`
ClawRouter uses OpenAI-compatible format. We could translate between formats.

**Rejected because:** We only target Anthropic models. Adding a translation layer adds complexity and latency for no benefit. The `anthropic-messages` ModelApi type exists in OpenClaw's type system.

### 3. Switch from Hono to raw `node:http`
ClawRouter uses raw `node:http`. Would reduce dependencies.

**Rejected because:** The existing Hono codebase is working and tested. Rewriting the proxy just to match ClawRouter's framework choice is unnecessary churn. Hono's `serve()` returns a server handle compatible with `registerService({ stop })`.

## Acceptance Criteria

### Functional Requirements

- [x] `openclaw plugins install ./anthropic-router` installs the plugin
- [x] `/model anthropic-router/auto` selects the router
- [x] Requests are scored and routed to cheapest capable model (haiku/sonnet/opus)
- [x] Responses stream back correctly (SSE zero-copy passthrough)
- [x] User's Anthropic credentials forwarded per-request (no stored keys)
- [x] `/router stats` shows routing statistics
- [x] `/router test <prompt>` shows dry-run routing decision
- [x] Plugin survives `openclaw gateway restart`

### Non-Functional Requirements

- [x] Proxy binds to `127.0.0.1` only (no external access)
- [x] Routing adds <1ms latency (existing benchmark: 312us for 10K chars)
- [x] EADDRINUSE handled gracefully (detect + reuse existing proxy)
- [x] Clean shutdown via `registerService({ stop })`
- [x] No `process.exit()` calls (plugin context, not standalone)
- [x] Completion mode detected (no side effects during shell completion)

### Quality Gates

- [x] All existing router tests pass (20 tests)
- [x] Server tests updated and passing (~20 tests, auth tests removed, credential passthrough tests added)
- [x] ESLint clean (`no-explicit-any: error`)
- [x] No `any` types
- [ ] Manual integration test: install plugin, select model, send request, verify routing

## Dependencies & Prerequisites

- **OpenClaw plugin API**: Specifically `api.registerProvider()`, `api.registerService()`, `api.registerCommand()`. These are proven to work (ClawRouter uses them).
- **`anthropic-messages` API format with local proxy**: Untested in any existing plugin. If this code path has OpenClaw-side bugs, fallback plan is to use `openai-completions` with a translation layer.
- **User logged into Claude Code**: Required for Anthropic credentials to be available in the session.

## Risk Analysis & Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| `anthropic-messages` API format not working with local proxy | Blocks entire plugin | Medium | Test early in Phase 1. Fallback: use `openai-completions` + translation layer |
| OpenClaw doesn't pass `x-api-key` header to local proxies | Blocks credential passthrough | Medium | Test in Phase 1. Fallback: read from `~/.openclaw/agents/*/agent/auth-profiles.json` |
| `maxTokens: 8192` too restrictive for sonnet/opus tier | Poor UX for complex requests | Low | Document limitation. Users needing longer output use specific models directly |
| Multiple sessions with different API keys share proxy | Correctness bug in reply-aware routing | Low | Per-request credential passthrough fixes billing. `messageTiers` map shared across sessions is acceptable (routing-only, no security impact) |
| Port 8403 conflict with other services | Proxy fails to start | Low | Configurable via `openclaw.plugin.json` configSchema. EADDRINUSE detection + health check |

## Open Questions (Resolve During Phase 1)

1. **Does OpenClaw include `x-api-key` in requests to `anthropic-messages` local providers?** Test with a minimal probe plugin. If not, read from auth store or fall back to env var.

2. **Does OpenClaw set `anthropic-version` header automatically?** If not, the proxy must add it before forwarding upstream.

3. **Does OpenClaw strip custom response headers (X-Router-Tier etc.)?** If so, consider logging routing decisions via `api.logger` instead.

## References & Research

### Internal References
- Brainstorm: `docs/brainstorms/2026-02-10-openclaw-plugin-conversion-brainstorm.md`
- Security hardening: `docs/solutions/security-issues/api-proxy-security-and-architecture-hardening.md`
- Original design: `docs/DESIGN.md`
- Current server: `src/server.ts`
- Routing engine: `src/router/`

### External References
- ClawRouter plugin scaffold: `/home/clawcian/.openclaw/workspace/ClawRouter/src/index.ts`
- ClawRouter provider: `/home/clawcian/.openclaw/workspace/ClawRouter/src/provider.ts`
- ClawRouter models: `/home/clawcian/.openclaw/workspace/ClawRouter/src/models.ts`
- ClawRouter types: `/home/clawcian/.openclaw/workspace/ClawRouter/src/types.ts`
- ClawRouter proxy (EADDRINUSE pattern): `/home/clawcian/.openclaw/workspace/ClawRouter/src/proxy.ts`
