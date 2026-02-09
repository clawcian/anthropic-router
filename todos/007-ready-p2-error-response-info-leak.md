---
status: complete
priority: p2
issue_id: "007"
tags: [code-review, security]
dependencies: []
---

# Error Response Leaks Internal Configuration

## Problem Statement

The 500 error response includes `fallbackModel` (a full Anthropic model identifier), revealing internal routing configuration. Error responses also lack consistent structure -- no machine-parseable type codes for automated error handling.

## Findings

- **Security Sentinel (MEDIUM)**: Exposes internal model configuration in error responses.
- **Agent-Native Reviewer (WARN)**: Inconsistent error shapes force string-matching on natural language messages.

**Location:** `src/server.ts:288-302` -- `{ error: "Internal routing error", fallbackModel }`

## Proposed Solutions

### Option A: Generic error + consistent envelope (Recommended)
- Remove `fallbackModel` from 500 response
- Adopt `{ error: { type: string, message: string } }` envelope
- **Pros:** No info leak, machine-parseable errors
- **Cons:** Breaking change for clients parsing current error format
- **Effort:** Small
- **Risk:** Low

## Recommended Action

Option A.

## Acceptance Criteria

- [ ] No `fallbackModel` in any error response
- [ ] Consistent error structure across all endpoints
- [ ] Tests verify error format

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-09 | Created from review | |
| 2026-02-09 | Approved in triage | Status: pending → ready. Quick security win. |
