---
status: complete
priority: p3
issue_id: "010"
tags: [code-review, quality]
dependencies: []
---

# Token Estimation Inconsistency Between Router and Logger

## Problem Statement

Token estimation (`Math.ceil(text.length / 4)`) appears in 3 places with different semantics:

1. `src/router/index.ts:34` -- estimates from `systemPrompt + prompt` (full text)
2. `src/logger.ts:59` -- estimates from `prompt` only (no system prompt)
3. `src/router/rules.test.ts:67` -- estimates from `prompt` only

The logged token count differs from the routing token count.

## Findings

- **Pattern Specialist (LOW)**: Semantic inconsistency, not just code duplication.

## Acceptance Criteria

- [ ] Logger receives pre-computed token count from routing decision
- [ ] Single source of truth for token estimation

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-09 | Created from review | |
| 2026-02-09 | Approved in triage | Status: pending → ready. Pass pre-computed tokens from router to logger. |
