---
status: complete
priority: p2
issue_id: "008"
tags: [code-review, security]
dependencies: []
---

# Client-Controlled Message IDs Not Length-Validated

## Problem Statement

`x-message-id` and `x-reply-to` are client-controlled strings stored in the `messageTiers` map with no length validation. While the map is bounded to 1000 entries, each key could be arbitrarily large. A client could send multi-megabyte strings as message IDs. Additionally, clients can forge reply chains to escalate tier assignment.

## Findings

- **Security Sentinel (LOW)**: With 1000 entries holding multi-MB keys, memory could reach several GB.
- **Security Sentinel (MEDIUM)**: Tier escalation via forged reply chains defeats cost optimization.

**Location:** `src/server.ts:231-242,267-271`

## Proposed Solutions

### Option A: Truncate IDs to 256 chars (Recommended)
```typescript
const safeId = messageId.slice(0, 256);
```
- **Pros:** Simple, prevents memory abuse
- **Cons:** Does not address tier escalation via forged replies
- **Effort:** Trivial
- **Risk:** Low

## Acceptance Criteria

- [ ] Message IDs truncated to 256 characters before storage
- [ ] Reply-to IDs truncated before lookup

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-09 | Created from review | |
| 2026-02-09 | Approved in triage | Status: pending → ready. Trivial fix, prevents memory abuse. |
