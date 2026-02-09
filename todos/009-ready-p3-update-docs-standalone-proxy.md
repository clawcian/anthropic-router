---
status: complete
priority: p3
issue_id: "009"
tags: [code-review, documentation]
dependencies: []
---

# README and DESIGN.md Describe Outdated OpenClaw Plugin Architecture

## Problem Statement

Both documents describe this as an "OpenClaw plugin" with `openclaw.plugin.json`, `registerHook`, etc. But `openclaw.plugin.json` has been deleted and the implementation is a standalone Hono HTTP proxy.

## Findings

- **Agent-Native Reviewer**: An agent or developer reading docs will be misled about the architecture.

**Location:** `README.md`, `docs/plans/2026-02-09-feat-anthropic-router-implementation-plan.md`

## Acceptance Criteria

- [ ] README accurately describes standalone proxy architecture
- [ ] No references to `openclaw.plugin.json` or plugin API
- [ ] Installation instructions updated for standalone server

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-09 | Created from review | |
| 2026-02-09 | Approved in triage | Status: pending → ready. Docs are misleading about architecture. |
