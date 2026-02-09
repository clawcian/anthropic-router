---
status: complete
priority: p1
issue_id: "003"
tags: [code-review, typescript, quality]
dependencies: ["002"]
---

# `any` Type for Request Body in Proxy Handler

## Problem Statement

`body: any` at `src/server.ts:196` is the single biggest type safety hole. All property accesses (`body.messages`, `body.model`, `body.system`, `body.stream`, `body.reply_to`, `body.message_id`) are unchecked at compile time. A typo like `body.sytem` compiles without error.

## Findings

- **TypeScript Reviewer (HIGH)**: Would block a PR on this alone. The `any` propagates silently through the entire handler.
- **Pattern Specialist (LOW)**: Notes this is the only `eslint-disable` for `no-explicit-any` in the codebase.

**Location:** `src/server.ts:196` -- `let body: any;`

## Proposed Solutions

### Option A: Define `AnthropicMessagesRequest` type (Recommended)
```typescript
type AnthropicMessagesRequest = {
  model?: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  reply_to?: string;
  message_id?: string;
};
```
- **Pros:** Type-safe, self-documenting, eliminates eslint-disable
- **Cons:** Must maintain type as Anthropic API evolves
- **Effort:** Small
- **Risk:** Low

## Recommended Action

Option A. Naturally combines with #002 (body allowlisting).

## Technical Details

- **Affected files:** `src/server.ts`
- Remove `eslint-disable-next-line` comment
- Promote `no-explicit-any` to `"error"` in `eslint.config.js`

## Acceptance Criteria

- [ ] No `any` types in production code
- [ ] `AnthropicMessagesRequest` type defined
- [ ] ESLint `no-explicit-any` set to `"error"`
- [ ] All body property accesses type-checked

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-09 | Created from review | Combine with body allowlisting (#002) |
| 2026-02-09 | Approved in triage | Status: pending → ready. Implement alongside #002. |
