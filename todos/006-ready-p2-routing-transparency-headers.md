---
status: complete
priority: p2
issue_id: "006"
tags: [code-review, agent-native]
dependencies: []
---

# No Routing Transparency on `/v1/messages` Responses

## Problem Statement

When an agent sends a request to `/v1/messages`, the routing decision (tier, model, confidence) is logged but never returned to the caller. The agent cannot verify which model handled its request or understand the router's reasoning.

## Findings

- **Agent-Native Reviewer (CRITICAL)**: Most significant agent-native gap. Agents are "flying blind."
- **Architecture Strategist**: Zero-copy streaming passthrough is correct, but response headers should carry routing metadata.

**Location:** `src/server.ts:274-287` -- response passthrough with no routing headers.

## Proposed Solutions

### Option A: Add response headers (Recommended)
Add to proxied response:
```
X-Router-Tier: COMPLEX
X-Router-Model: claude-opus-4-6
X-Router-Confidence: 0.92
```
- **Pros:** Invisible to apps that don't look for them, no API breaking change
- **Cons:** None significant
- **Effort:** Small
- **Risk:** Low

## Recommended Action

Option A.

## Acceptance Criteria

- [ ] `X-Router-Tier`, `X-Router-Model`, `X-Router-Confidence` headers on `/v1/messages` responses
- [ ] Headers present for both streaming and non-streaming responses
- [ ] Tests verify headers exist

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-09 | Created from review | `signals` field already added to RoutingDecision type in prior session |
| 2026-02-09 | Approved in triage | Status: pending → ready. Key agent-native improvement. |
