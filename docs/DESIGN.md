# Anthropic Model Router — Design Doc

> Route every request to the cheapest Anthropic model that can handle it.

## Goal

Build an OpenClaw plugin that analyzes each prompt and routes to Haiku, Sonnet, or Opus based on complexity. No external API calls for routing — everything runs locally in <1ms.

**Why?**
- Opus is 15x more expensive than Haiku
- Most requests don't need Opus
- Automatic routing = cost savings without thinking about it

## Prior Art: ClawRouter

We're borrowing the routing logic from [BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter), which uses a 14-dimension weighted scoring system.

**What we're taking:** The `src/router/` directory — rules-based classification
**What we're ignoring:** The x402/USDC payment layer, proxy server, multi-provider support

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Our Proxy (port 8403)                    │
├─────────────────────────────────────────────────────────────┤
│  1. Receive request from OpenClaw                            │
│  2. Detect if reply → look up replied message tier           │
│  3. Run weighted scoring on current message                  │
│  4. Apply routing rules (see below)                          │
│  5. LOG: { prompt, signals, score, tier, is_reply }          │
│  6. Claude Code SDK → uses logged-in session                 │
│  7. Stream response back                                     │
└─────────────────────────────────────────────────────────────┘
```

**Key decision:** We use the Claude Code SDK with the logged-in session. No separate API keys needed — piggybacks on existing auth.

## Routing Rules (Simple!)

```typescript
if (isReply) {
    tier = max(repliedMessageTier, score(currentMessage))
} else {
    tier = score(currentMessage)  // fresh every time
}
```

**Two rules. Done.**

- **Reply** = explicit continuation signal → "only up" from replied context
- **Not a reply** = fresh eval → let the scoring decide

No time tracking, no session state to manage. Replies are the user's explicit "this is connected" signal. Everything else gets scored fresh.

### Why This Works

| Scenario | Is Reply? | Behavior |
|----------|-----------|----------|
| Complex question | No | Score it → probably Opus |
| Simple question | No | Score it → probably Haiku |
| "What did you mean by step 3?" (replying to complex msg) | Yes | Max(Opus, score) → stays Opus |
| "Thanks!" (replying to anything) | Yes | Max(previous, score) → stays at previous tier |
| Totally new topic | No | Fresh score → appropriate tier |

## Tier Mapping

| Tier | Model | Cost/M tokens |
|------|-------|---------------|
| SIMPLE | haiku | $1.00 |
| MEDIUM | sonnet | $3.00 |
| COMPLEX | opus | $15.00 |

## 14-Dimension Weighted Scoring

Each dimension scores [-1, 1]. Weighted sum → tier selection.

| Dimension | Weight | Detects | Score Direction |
|-----------|--------|---------|-----------------|
| reasoningMarkers | 0.18 | "prove", "theorem", "step by step" | +complex |
| codePresence | 0.15 | "function", "async", "```" | +complex |
| simpleIndicators | 0.12 | "what is", "define", "translate" | -simple |
| multiStepPatterns | 0.12 | "first...then", "step 1" | +complex |
| technicalTerms | 0.10 | "algorithm", "kubernetes" | +complex |
| tokenCount | 0.08 | short (<50) vs long (>500) | varies |
| creativeMarkers | 0.05 | "story", "poem", "brainstorm" | +medium |
| questionComplexity | 0.05 | Multiple question marks | +complex |
| constraintCount | 0.04 | "at most", "O(n)", "maximum" | +complex |
| imperativeVerbs | 0.03 | "build", "create", "implement" | +complex |
| outputFormat | 0.03 | "json", "yaml", "schema" | +medium |
| domainSpecificity | 0.02 | "quantum", "fpga", "genomics" | +complex |
| referenceComplexity | 0.02 | "the docs", "the api" | +complex |
| negationComplexity | 0.01 | "don't", "avoid", "without" | +complex |

**Tier boundaries (weighted score):**
- score < 0.0 → SIMPLE (haiku)
- 0.0 ≤ score < 0.15 → MEDIUM (sonnet)
- score ≥ 0.15 → COMPLEX (opus)

**Special rule:** 2+ reasoning keywords in user prompt → force COMPLEX at high confidence

## Training Data for Future LoRA

Log every routing decision to JSONL:

```jsonl
{"ts":1707500000,"prompt":"What is 2+2?","signals":["simple (what is)","short (8 tokens)"],"score":-0.12,"tier":"SIMPLE","model":"haiku","is_reply":false}
{"ts":1707500001,"prompt":"Now prove it formally","signals":["reasoning (prove)"],"score":0.22,"tier":"COMPLEX","model":"opus","is_reply":true,"replied_tier":"SIMPLE"}
```

**Location:** `~/.openclaw/routing-log.jsonl`

**Future:** Train a tiny LoRA model on this data to replace keyword rules with learned patterns.

## Cost Savings Estimate

Based on typical traffic distribution:

| Tier | % of Traffic | Model | Cost/M |
|------|--------------|-------|--------|
| SIMPLE | ~45% | haiku | $1.00 |
| MEDIUM | ~40% | sonnet | $3.00 |
| COMPLEX | ~15% | opus | $15.00 |
| **Blended** | | | **$3.90/M** |

Compared to $15/M always-Opus = **74% savings**

## Implementation

### Tier to Model

```typescript
const tierToModel = {
  SIMPLE: 'haiku',
  MEDIUM: 'sonnet', 
  COMPLEX: 'opus',
};
```

### Proxy Server (pseudocode)

```typescript
import { route, DEFAULT_ROUTING_CONFIG } from './router';

// Track tiers for reply lookups
const messageTiers = new Map<string, Tier>();

async function handleRequest(req) {
  const { messages, reply_to } = req.body;
  const lastUserMessage = messages.filter(m => m.role === 'user').pop();
  
  // Score current message
  const decision = route(lastUserMessage.content, messages[0]?.content);
  let tier = decision.tier;
  
  // If reply, apply "only up" rule
  if (reply_to && messageTiers.has(reply_to)) {
    const repliedTier = messageTiers.get(reply_to);
    tier = maxTier(repliedTier, tier);
  }
  
  // Log for training data
  logDecision({ ...decision, tier, is_reply: !!reply_to });
  
  // Make the actual call via Claude Code SDK (uses logged-in session)
  const response = await claudeCodeSession.complete({
    model: tierToModel[tier],
    messages: messages,
    stream: true,
  });
  
  // Store tier for future reply lookups
  messageTiers.set(response.id, tier);
  
  return response;
}
```

## Configuration

Override via `openclaw.yaml`:

```yaml
plugins:
  - id: anthropic-router
    config:
      tiers:
        SIMPLE: "haiku"
        MEDIUM: "sonnet"
        COMPLEX: "opus"
      
      scoring:
        dimensionWeights:
          reasoningMarkers: 0.20
          codePresence: 0.12
      
      forceModel: null  # Override for testing
      logEnabled: true
      logPath: "~/.openclaw/routing-log.jsonl"
```

## Files Structure

```
anthropic-router/
├── openclaw.plugin.json
├── package.json
├── src/
│   ├── index.ts            # Plugin entry, proxy server
│   ├── router/
│   │   ├── index.ts        # Main route() function
│   │   ├── rules.ts        # 14-dimension scoring
│   │   ├── config.ts       # Default config, keywords
│   │   └── types.ts        # TypeScript types
│   └── logger.ts           # JSONL logging
├── tsconfig.json
└── README.md
```

## Open Questions

1. **Reply detection in OpenClaw** — How does OpenClaw pass reply context? Need to verify the request format.

2. **Message ID tracking** — For reply lookups, we need stable message IDs. Check if OpenClaw provides these.

3. **Claude Code SDK interface** — Need to verify exact SDK usage for making completions via logged-in session.

## Acknowledgments

Routing logic adapted from [ClawRouter](https://github.com/BlockRunAI/ClawRouter) by BlockRunAI (MIT licensed).

---

*Updated 2026-02-09. Ready for implementation.*
