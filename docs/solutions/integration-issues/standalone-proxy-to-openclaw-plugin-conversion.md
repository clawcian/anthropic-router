---
title: "Standalone Proxy to OpenClaw Plugin Conversion"
date: 2026-02-10
category: integration-issues
tags:
  - plugin-conversion
  - anthropic-router
  - openclaw
  - smart-routing
  - proxy-integration
  - auth-refactor
  - lifecycle-management
component: Anthropic Router
severity: medium
status: completed
related_issues:
  - docs/plans/2026-02-10-feat-openclaw-plugin-conversion-plan.md
  - docs/brainstorms/2026-02-10-openclaw-plugin-conversion-brainstorm.md
  - docs/solutions/security-issues/api-proxy-security-and-architecture-hardening.md
  - docs/plans/2026-02-09-feat-anthropic-router-implementation-plan.md
---

# Standalone Proxy to OpenClaw Plugin Conversion

## Problem

The Anthropic Router was a standalone HTTP proxy that required manual setup to use with OpenClaw:

1. Start proxy manually (`node dist/index.js`)
2. Edit OpenClaw auth profile to point at `localhost:8403`
3. Hope the proxy was running when needed

The proxy had its own authentication (Bearer token via `PROXY_SECRET`), its own lifecycle, and no way for OpenClaw to discover or manage it. This made the 74% cost savings from smart routing practically unusable.

## Root Cause

The proxy was built as a standalone service with no integration into OpenClaw's plugin system. It used a shared `PROXY_SECRET` for all clients and a single `ANTHROPIC_API_KEY` for all upstream calls — patterns incompatible with OpenClaw's per-session credential model.

## Solution

Convert the proxy into an OpenClaw plugin following the ClawRouter pattern. The plugin registers as a model provider, manages the proxy lifecycle, and forwards per-request credentials from OpenClaw sessions.

### Architecture

```
OpenClaw                              Anthropic Router Plugin
  |                                     |
  | /model anthropic-router/auto        |
  |                                     |
  | POST http://127.0.0.1:8403          |
  |   + x-api-key from session -------> | 1. Extract x-api-key
  |                                     | 2. Score prompt (<1ms)
  |                                     | 3. Rewrite model -> haiku/sonnet/opus
  |                                     | 4. Forward to api.anthropic.com
  |   <--- SSE zero-copy passthrough -- | 5. Stream response back
  |   + X-Router-Tier/Model/Confidence  | 6. Add transparency headers
```

### Files Created

| File | Purpose |
|------|---------|
| `openclaw.plugin.json` | Plugin manifest with configSchema (port, forceModel) |
| `src/types.ts` | Duck-typed OpenClaw plugin API types |
| `src/models.ts` | Single "auto" model definition (anthropic-messages API) |
| `src/provider.ts` | Provider registration (id="anthropic-router", auth=[]) |
| `src/plugin.ts` | Register handler with lifecycle management |

### Files Modified

| File | Change |
|------|--------|
| `src/server.ts` | Removed Bearer auth, added per-request x-api-key passthrough |
| `src/index.ts` | Re-exports plugin default + programmatic APIs |
| `package.json` | Added `openclaw.extensions`, `peerDependencies`, files |
| `tsup.config.ts` | Added `src/plugin.ts` entry point |
| `src/server.test.ts` | Removed 5 auth tests, added 2 credential passthrough tests |

### Key Change: Per-Request Credential Passthrough

Before (standalone mode):
```typescript
// Single shared API key for all requests
const upstream = await fetch("https://api.anthropic.com/v1/messages", {
  headers: {
    "x-api-key": config.anthropicApiKey,  // env var
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify(body),
});
```

After (plugin mode):
```typescript
// Extract per-request credentials from incoming headers
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
  headers: {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify(body),
});
```

### Key Change: Plugin Lifecycle

```typescript
register(api: OpenClawPluginApi) {
  // 1. Skip heavy init during shell completion
  if (isCompletionMode()) {
    api.registerProvider(anthropicRouterProvider);
    return;
  }

  // 2. Register provider (sync, immediate)
  api.registerProvider(anthropicRouterProvider);

  // 3. Inject config into openclaw.json (best-effort)
  injectModelsConfig(port, api.logger);

  // 4. Inject auth profile placeholders
  injectAuthProfile(api.logger);

  // 5. Set runtime config
  api.config.models.providers["anthropic-router"] = { ... };

  // 6. Register service with stop() for cleanup
  api.registerService({
    id: "anthropic-router-proxy",
    start: () => {},
    stop: async () => { activeServer?.close(); },
  });

  // 7. Start proxy in background (fire-and-forget)
  startProxyServer(port, api).catch(err => api.logger.error(...));
}
```

### Key Change: EADDRINUSE Detection

```typescript
async function checkExistingProxy(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return res.ok && (await res.json()).status === "ok";
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}
```

Probes `/health` before binding. If proxy is already running, reuses it.

## Prevention Strategies

### 1. Auth Refactoring: Standalone to Plugin

When converting a proxy from standalone to plugin mode:

- **Dual-mode auth**: Support both per-request headers AND env var fallback
- **Clear error messages**: Tell users what's missing ("Ensure you are logged into Claude Code")
- **Remove shared secrets first**: Bearer tokens and shared API keys don't work in multi-session plugin contexts
- **Test both paths**: Test with header present, with fallback key, and with neither

### 2. EADDRINUSE Detection Pattern

Always check if a service is already running before binding:

- Probe the health endpoint with a short timeout (2s)
- If running, reuse — don't crash
- If not running, proceed with startup
- Poll for readiness after starting (max 5 attempts, 100ms apart)

### 3. Completion Mode Detection

OpenClaw loads plugins during `openclaw completion --shell zsh`. Any stdout output or expensive I/O breaks shell completion:

```typescript
function isCompletionMode(): boolean {
  return process.argv.some((arg, i) => arg === "completion" && i >= 1 && i <= 3);
}
```

In completion mode: register provider only, skip everything else.

### 4. Duck-Typing External APIs

When integrating with a host system (OpenClaw), define types locally:

- Copy the expected shapes as local types in `src/types.ts`
- Don't import from internal host paths — they change between versions
- Use TypeScript structural typing to validate compatibility
- Document which host version the types were derived from

### 5. Plugin Lifecycle Ordering

Critical ordering in `register()`:

1. `registerProvider()` — sync, must happen first
2. Config injection — best-effort, fire-and-forget
3. Runtime config — immediate availability
4. `registerService()` — BEFORE starting the server (ensures cleanup handler exists)
5. Server startup — async, fire-and-forget with error logging

### 6. Config Persistence

Best-effort injection into `~/.openclaw/openclaw.json`:

- Read, modify, write — not append
- Silently fail on any error (don't block plugin registration)
- Use `apiKey: "session-passthrough"` placeholder for providers that handle auth internally
- Do NOT set as default model on install — let users opt in

## Verification

- 40 tests passing (20 router + 20 server)
- ESLint clean
- TypeScript clean (`tsc --noEmit`)
- Build clean (`tsup`)

## User Experience After

```bash
openclaw plugins install ./anthropic-router
/model anthropic-router/auto
# Done. 74% cost savings, transparent.
```
