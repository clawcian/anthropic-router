# Brainstorm: Convert Anthropic Router to OpenClaw Plugin

**Date:** 2026-02-10
**Status:** Draft

## What We're Building

Convert the existing Anthropic Router from a standalone HTTP proxy into a **proper OpenClaw plugin** — modeled after ClawRouter — so it registers as a selectable model provider inside OpenClaw.

**The user experience should be:**
```bash
openclaw plugins install @anthropic-router
# Then in any OpenClaw conversation:
/model anthropic-router/auto
```

That's it. The plugin handles everything: starts the local proxy, registers the provider, and transparently routes every Anthropic request to the cheapest capable model (haiku/sonnet/opus) based on prompt complexity.

## Why This Approach

**Current state:** We have a solid routing engine (14-dimension weighted scorer, <1ms, 43 tests passing) and a working HTTP proxy. But it's completely disconnected from OpenClaw — users would have to manually reconfigure their auth profile base URL to use it.

**Target state:** A ClawRouter-style plugin that integrates natively with OpenClaw's provider system. Users install once and switch to it with `/model`.

**Reference implementation:** ClawRouter (`/home/clawcian/.openclaw/workspace/ClawRouter`) proves this pattern works. It registers via `api.registerProvider()`, exposes models as `blockrun/*`, runs a local proxy on `:8402, and injects config automatically.

## Key Decisions

### 1. Single model: `anthropic-router/auto`
- Only expose one model — the smart-routing model
- No per-tier models (haiku/sonnet/opus) — the whole point is automatic selection
- Keeps the mental model dead simple: "use auto, save money"

### 2. No authentication layer
- No PROXY_SECRET, no API key management, no wallet
- The plugin uses the user's existing OpenClaw/Claude Code login session
- OpenClaw already has Anthropic credentials — the proxy just forwards them
- **Prerequisite:** User must be logged into Claude Code before using the plugin
- Document this in the README, nothing more

### 3. Full OpenClaw plugin scaffold
- `openclaw.plugin.json` — plugin manifest with ID, name, description
- `src/index.ts` — plugin entry point, exports `OpenClawPluginDefinition`
- `src/provider.ts` — provider registration (`api.registerProvider()`)
- `src/models.ts` — single model definition for `anthropic-router/auto`
- Install script that injects config into OpenClaw
- Keep existing `src/router/` and `src/server.ts` as the proxy engine

### 4. Proxy runs on localhost:8403
- Keep existing port (8403, next to ClawRouter's 8402)
- Plugin starts proxy automatically on `register()`
- OpenClaw talks to `http://127.0.0.1:8403/v1/messages`

### 5. API format: Anthropic Messages API (not OpenAI)
- ClawRouter uses OpenAI-compatible format because it supports 30+ providers
- We only target Anthropic models, so stick with native Anthropic Messages API
- OpenClaw supports both formats — just declare `"api": "anthropic-messages"` in provider config

## What We're Reusing

Everything in the current codebase is reusable:

| Component | Location | Status |
|-----------|----------|--------|
| Routing engine | `src/router/` | Keep as-is (14-dim scorer, tested) |
| Proxy server | `src/server.ts` | Refactor: remove PROXY_SECRET auth, keep proxy logic |
| Logger | `src/logger.ts` | Keep as-is (JSONL decision logging) |
| Config system | `src/router/config.ts` | Keep as-is |
| Types | `src/router/types.ts` | Keep as-is |
| Tests | `*.test.ts` | Update for new auth model |

## What We're Adding

| Component | Purpose |
|-----------|---------|
| `openclaw.plugin.json` | Plugin manifest |
| `src/index.ts` | Plugin entry point (register, start proxy) |
| `src/provider.ts` | Provider definition for OpenClaw |
| `src/models.ts` | Model definition: `anthropic-router/auto` |
| `scripts/install.sh` | Config injection into OpenClaw |

## What We're Removing/Changing

- **PROXY_SECRET auth middleware** — no longer needed; OpenClaw handles auth
- **Bearer token validation** — replaced by OpenClaw's session auth passthrough
- The proxy receives Anthropic credentials from OpenClaw's existing session

## Open Questions

1. **How does OpenClaw pass Anthropic credentials to local plugins?** Does it include the `x-api-key` header in requests to the plugin's proxy, or does the plugin need to read it from OpenClaw's auth store?

2. **Plugin lifecycle:** Does OpenClaw auto-start the proxy when the plugin loads, or do we need a gateway/daemon pattern?

3. **Stats endpoint:** Keep `/stats` as a plugin command (e.g., `/router stats`) or drop it?

4. **Reply-aware routing:** Keep the `X-Reply-To` / `X-Message-Id` header tracking? OpenClaw may or may not pass these through.

5. **Packaging:** Publish to npm as `@anthropic-router` or keep it local-only for now?
