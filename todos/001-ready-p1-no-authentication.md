---
status: complete
priority: p1
issue_id: "001"
tags: [code-review, security]
dependencies: []
---

# No Authentication on Any Endpoint

## Problem Statement

The server listens on port 8403 with zero authentication middleware. Every route (`/health`, `/test`, `/v1/messages`, `/stats`) is open to any network client. The proxy attaches the operator's `ANTHROPIC_API_KEY` to every upstream request, making it an open relay for API cost abuse.

## Findings

- **Security Sentinel (HIGH)**: Any network-accessible client can make unlimited API calls billed to the operator. The operator's key is effectively shared with every client.
- **Architecture Strategist**: Confirms this amplifies every other security finding.

**Location:** `src/server.ts` -- all routes, no auth middleware.

## Proposed Solutions

### Option A: Shared secret via Bearer token (Recommended)
- Add Hono middleware checking `Authorization: Bearer <token>` against `PROXY_SECRET` env var
- Exempt `/health` for load balancer probes
- **Pros:** Simple, standard HTTP auth pattern
- **Cons:** Single shared secret, no per-client granularity
- **Effort:** Small
- **Risk:** Low

### Option B: Per-client API keys with a key store
- Maintain a set of valid API keys, rate-limit per key
- **Pros:** Multi-tenant ready, per-client rate limits
- **Cons:** Over-engineered for current scope
- **Effort:** Medium
- **Risk:** Low

## Recommended Action

Option A.

## Technical Details

- **Affected files:** `src/server.ts`, `src/index.ts`
- Add `PROXY_SECRET` env var to `ProxyConfig`
- Middleware: `app.use("*", async (c, next) => { ... })`

## Acceptance Criteria

- [ ] Unauthenticated requests to `/v1/messages`, `/test`, `/stats` return 401
- [ ] `/health` remains unauthenticated
- [ ] `PROXY_SECRET` env var documented
- [ ] Tests updated for auth header

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-09 | Created from review | Blocks all other security fixes |
| 2026-02-09 | Approved in triage | Status: pending → ready. Foundational security fix. |
