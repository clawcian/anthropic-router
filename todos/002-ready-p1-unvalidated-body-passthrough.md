---
status: complete
priority: p1
issue_id: "002"
tags: [code-review, security]
dependencies: []
---

# Unvalidated Request Body Passthrough to Upstream API

## Problem Statement

The proxy validates only that `body.messages` exists and is an array. The *entire* parsed JSON body is forwarded to `api.anthropic.com` with the server's API key. A client can inject arbitrary Anthropic API parameters: `max_tokens` manipulation for cost abuse, `metadata.user_id` spoofing, or unknown future fields.

## Findings

- **Security Sentinel (HIGH)**: `max_tokens` can be set to 128000 for expensive completions. `metadata.user_id` injection enables abuse framing.
- **TypeScript Reviewer (HIGH)**: `body: any` type means zero compile-time safety on forwarded fields.

**Location:** `src/server.ts:253-263` -- `body: JSON.stringify(body)` forwards everything.

## Proposed Solutions

### Option A: Allowlist known fields (Recommended)
- Construct forwarded body from known Anthropic API fields only
- Cap `max_tokens` to a configurable maximum
- **Pros:** Prevents all parameter injection, explicit about what is forwarded
- **Cons:** Must update allowlist when Anthropic adds new API fields
- **Effort:** Small
- **Risk:** Low

### Option B: Blocklist dangerous fields
- Strip known-dangerous fields (`metadata`, etc.)
- **Pros:** Forwards new fields automatically
- **Cons:** Cannot defend against unknown future fields
- **Effort:** Small
- **Risk:** Medium (incomplete protection)

## Recommended Action

Option A.

## Technical Details

- **Affected files:** `src/server.ts`
- Define `AnthropicMessagesRequest` type with known fields
- Build new body object from allowlisted fields only
- Add `maxAllowedTokens` to `ProxyConfig`

## Acceptance Criteria

- [ ] Only known Anthropic API fields are forwarded
- [ ] `max_tokens` is capped to configurable limit
- [ ] Unknown fields are silently dropped
- [ ] Type defined for request body (removes `any`)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-09 | Created from review | Combines with #003 (typed request) |
| 2026-02-09 | Approved in triage | Status: pending → ready. Implement with #003 together. |
