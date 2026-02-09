---
status: complete
priority: p2
issue_id: "005"
tags: [code-review, performance]
dependencies: []
---

# Synchronous I/O on Hot Path (Logger + Stats)

## Problem Statement

Two synchronous I/O operations block the Node.js event loop:

1. **`appendFileSync`** in logger (`src/logger.ts:68`) -- executes on every `/v1/messages` request. Each call blocks 20-100us, serializing under concurrent load.
2. **`readFileSync`** in `/stats` (`src/server.ts:152`) -- reads entire JSONL log file synchronously. At 100K entries (~25MB), blocks ~80ms. `.split("\n")` doubles memory by creating an array copy.
3. **`existsSync`** in logger (`src/logger.ts:36`) -- stat() syscall on every request, redundant after first call.

## Findings

- **Performance Oracle (CRITICAL)**: `appendFileSync` is a serialization point under concurrent load. At 1000 req/s, loses 20-100ms/s of event loop time.
- **Architecture Strategist (HIGHER RISK at scale)**: No log rotation means unbounded file growth affecting both write and read paths.

**Locations:** `src/logger.ts:36,68`, `src/server.ts:152`

## Proposed Solutions

### Option A: Async fire-and-forget + cached dir check (Recommended)
- Replace `appendFileSync` with `appendFile(...).catch(() => {})`
- Cache `existsSync` result in module-level Set
- Replace `readFileSync` in `/stats` with async `readFile`
- **Pros:** Removes all blocking I/O, minimal code change
- **Cons:** Log writes are no longer guaranteed before response
- **Effort:** Small
- **Risk:** Low (logger already silently catches errors)

### Option B: Persistent write stream + in-memory stats
- Open `fs.createWriteStream` once at startup
- Maintain running stats counters updated on each log write
- **Pros:** Maximum performance, O(1) stats reads
- **Cons:** More complex, stats reset on server restart
- **Effort:** Medium
- **Risk:** Low

## Recommended Action

Option A for immediate fix. Option B as future optimization.

## Acceptance Criteria

- [ ] No `appendFileSync` or `readFileSync` in codebase
- [ ] No `existsSync` called per-request
- [ ] `/stats` endpoint is async
- [ ] Tests pass

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-09 | Created from review | Logger already partially fixed (async appendFile + ensuredDirs cache) in prior session |
| 2026-02-09 | Approved in triage | Status: pending → ready. Remaining work: async /stats endpoint. |
