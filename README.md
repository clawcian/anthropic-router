# Anthropic Router

> Route every request to the cheapest Anthropic model that can handle it.

A standalone HTTP proxy that sits between your app and the Anthropic API. It analyzes each prompt's complexity and rewrites the `model` field to the cheapest capable model before forwarding. No external API calls for routing — everything runs locally in <1ms.

## Why?

| Model | Cost/M tokens | Relative |
|-------|---------------|----------|
| haiku | $1.00 | 1x |
| sonnet | $3.00 | 3x |
| opus | $15.00 | 15x |

Most requests don't need Opus. This proxy analyzes each prompt and picks the cheapest model that can handle it, saving ~74% on a typical workload.

## Installation

```bash
git clone https://github.com/lucianHymer/anthropic-router
cd anthropic-router
npm install && npm run build
```

## Usage

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export PROXY_SECRET="your-shared-secret"
npm start
```

The server listens on `http://localhost:8403` by default. Point your Anthropic SDK at this URL instead of `api.anthropic.com`:

```bash
# Example: curl
curl http://localhost:8403/v1/messages \
  -H "Authorization: Bearer $PROXY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "What is 2+2?"}], "max_tokens": 100}'
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Your Anthropic API key |
| `PROXY_SECRET` | Yes | — | Bearer token for authenticating proxy clients |
| `PORT` | No | `8403` | Server port |
| `LOG_ENABLED` | No | `true` | Enable JSONL decision logging |
| `LOG_PATH` | No | `~/.openclaw/routing-log.jsonl` | Path to JSONL log file |
| `FORCE_MODEL` | No | — | Force a specific model for all requests (testing) |

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | No | Health check for load balancers |
| `POST` | `/v1/messages` | Yes | Anthropic Messages API proxy |
| `POST` | `/test` | Yes | Score a prompt without forwarding |
| `GET` | `/stats` | Yes | Aggregated routing statistics |

## How It Works

The router uses a **14-dimension weighted scoring system** to classify prompt complexity:

| Dimension | Weight | What It Detects |
|-----------|--------|-----------------|
| reasoningMarkers | 0.18 | "prove", "theorem", "step by step" |
| codePresence | 0.15 | "function", "async", "```" |
| simpleIndicators | 0.12 | "what is", "define", "translate" |
| multiStepPatterns | 0.12 | "first...then", "step 1" |
| technicalTerms | 0.10 | "algorithm", "kubernetes" |
| tokenCount | 0.08 | short (<50) vs long (>500) |
| + 8 more... | | |

Weighted sum → sigmoid confidence calibration → tier selection:

- **SIMPLE** (score < 0.0) → haiku
- **MEDIUM** (0.0 ≤ score < 0.15) → sonnet
- **COMPLEX** (score ≥ 0.15) → opus

Ambiguous prompts (confidence < 0.7) default to Sonnet.

### Reply-Aware Routing

Replies within a conversation are routed to at least the same tier as the original message ("only up" rule). Use `X-Message-Id` and `X-Reply-To` headers to enable this.

### Routing Transparency

Every proxied response includes headers showing the routing decision:

```
X-Router-Tier: COMPLEX
X-Router-Model: claude-opus-4-6
X-Router-Confidence: 0.92
```

## Cost Savings

Based on typical traffic distribution:

| Tier | % of Traffic | Model | Cost/M |
|------|--------------|-------|--------|
| SIMPLE | ~45% | haiku | $1.00 |
| MEDIUM | ~40% | sonnet | $3.00 |
| COMPLEX | ~15% | opus | $15.00 |
| **Blended** | | | **$3.90/M** |

Compared to $15/M always-Opus = **74% savings**

## Acknowledgments

Routing logic adapted from [ClawRouter](https://github.com/BlockRunAI/ClawRouter) by BlockRunAI (MIT licensed). ClawRouter provides smart routing across 30+ models with x402 micropayments — if you need multi-provider routing, check them out.

## License

MIT — see [LICENSE](LICENSE)
