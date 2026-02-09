---
status: complete
priority: p2
issue_id: "004"
tags: [code-review, architecture]
dependencies: []
---

# Module-Level `messageTiers` Map Shared Across App Instances

## Problem Statement

`messageTiers` is a module-level singleton `Map<string, Tier>`. All calls to `createApp()` share the same map, violating the independence contract of the factory function. Tests must manually call `_getMessageTiers().clear()` in `beforeEach`. The `_getMessageTiers()` test helper is exported from production code, appearing in published type declarations.

## Findings

- **Architecture Strategist (MEDIUM)**: Test isolation failure, multiple-instance confusion, invisible coupling.
- **TypeScript Reviewer (MEDIUM)**: `_getMessageTiers()` exports mutable internal state.
- **Pattern Specialist (LOW-MEDIUM)**: Shared mutable state at module level is an anti-pattern for factory functions.

**Location:** `src/server.ts:109-123`

## Proposed Solutions

### Option A: Move into `createApp` closure (Recommended)
- Move `messageTiers`, `MAX_TRACKED`, `trackTier` inside `createApp`
- Remove `_getMessageTiers()` export entirely
- Tests create their own app instances (already do)
- **Pros:** Each app instance is independent, removes test helper
- **Cons:** Tests lose direct map access (can test via API instead)
- **Effort:** Small
- **Risk:** Low

## Recommended Action

Option A.

## Acceptance Criteria

- [ ] `messageTiers` is scoped to each `createApp()` call
- [ ] `_getMessageTiers()` removed from exports
- [ ] No shared state between app instances
- [ ] Tests pass without `.clear()` workaround

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-09 | Created from review | |
| 2026-02-09 | Approved in triage | Status: pending → ready. Clean architecture fix. |
