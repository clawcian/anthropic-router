# Anthropic Router

Route every request to the cheapest Anthropic model that can handle it.

Analyzes prompt complexity locally (<1ms) and picks haiku, sonnet, or opus. Most prompts don't need opus. Typical savings: ~74%.

## Install

```bash
git clone https://github.com/lucianHymer/anthropic-router
cd anthropic-router
bash scripts/install.sh
```

Then in OpenClaw:

```
/model anthropic-router/auto
```

Done. All requests now route through the cheapest capable model.

## Commands

```
/router stats              Show routing tier/model distribution
/router test "your prompt" Dry-run a routing decision
```

## How It Works

A local proxy on `127.0.0.1:8403` intercepts requests, scores prompt complexity across 14 weighted dimensions, rewrites the `model` field, and forwards to `api.anthropic.com`. Responses stream back zero-copy.

| Score Range | Tier | Model | When |
|-------------|------|-------|------|
| < 0.0 | SIMPLE | haiku | "what is 2+2", translations, definitions |
| 0.0 - 0.15 | MEDIUM | sonnet | code generation, technical questions |
| >= 0.15 | COMPLEX | opus | proofs, multi-step reasoning, architecture |

Ambiguous prompts (confidence < 0.7) default to sonnet.

Your Anthropic credentials are forwarded per-request from your OpenClaw session. No API keys stored in the plugin.

## Configuration

Optional environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_ROUTER_PORT` | `8403` | Proxy port |
| `LOG_ENABLED` | `true` | Enable JSONL decision logging |
| `LOG_PATH` | `~/.openclaw/routing-log.jsonl` | Log file path |

Or set `port` / `forceModel` in the plugin config via `openclaw.plugin.json`.

## Acknowledgments

Routing logic adapted from [ClawRouter](https://github.com/BlockRunAI/ClawRouter) by BlockRunAI (MIT licensed).

## License

MIT
