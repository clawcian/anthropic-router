---
status: wont_fix
priority: p3
issue_id: "011"
tags: [code-review, simplicity]
dependencies: []
---

# `buildConfig()` Deep Merge is YAGNI

## Problem Statement

`buildConfig()` has 42 lines of deep merge logic with 7 branches, plus 73 lines of tests. It is called exactly once at startup with zero arguments: `buildConfig()`. Nobody passes partial overrides. This is 115 lines for infrastructure that has no consumer.

## Findings

- **Code Simplicity Reviewer**: Clear YAGNI violation. The function was built for hypothetical future consumers of a 0.2.0 library.

**Location:** `src/server.ts:38-80`, `src/server.test.ts:6-78`

## Proposed Solutions

### Option A: Keep as-is (Recommended)
The merge logic is well-tested, correct, and provides a clean API for library consumers. At v0.2.0 this is acceptable forward-thinking.

### Option B: Reduce to one-liner
```typescript
export function buildConfig(): RoutingConfig { return structuredClone(DEFAULT_ROUTING_CONFIG); }
```
Saves ~115 lines but removes a useful public API.

## Recommended Action

Option A -- keep as-is. The merge logic works, is tested, and will be needed when config overrides are used (e.g., env-based scoring weight adjustments). Not worth the churn of removing and re-adding later.

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-09 | Created from review | Decided to keep -- merge logic is correct and tested |
| 2026-02-09 | Approved in triage | Status: pending → ready. Decision: keep as-is, no code changes needed. |
