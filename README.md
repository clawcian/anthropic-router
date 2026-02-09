# Anthropic Router

> Route every request to the cheapest Anthropic model that can handle it.

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that automatically routes requests to Haiku, Sonnet, or Opus based on prompt complexity. No external API calls for routing — everything runs locally in <1ms.

## Why?

| Model | Cost/M tokens | Relative |
|-------|---------------|----------|
| haiku | $1.00 | 1x |
| sonnet | $3.00 | 3x |
| opus | $15.00 | 15x |

Most requests don't need Opus. This plugin analyzes each prompt and picks the cheapest model that can handle it, saving ~74% on a typical workload.

## Installation

```bash
# Install the plugin
openclaw plugins install anthropic-router

# Or from source
git clone https://github.com/lucianHymer/anthropic-router
cd anthropic-router
npm install && npm run build
openclaw plugins install .
```

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

## Configuration

Override defaults via `openclaw.yaml`:

```yaml
plugins:
  - id: anthropic-router
    config:
      # Override tier → model mapping
      tiers:
        SIMPLE: "haiku"
        MEDIUM: "sonnet"
        COMPLEX: "opus"
      
      # Adjust scoring weights
      scoring:
        dimensionWeights:
          reasoningMarkers: 0.20
          codePresence: 0.12
      
      # Force specific model (for testing)
      forceModel: null
      
      # Logging
      logPath: "~/.openclaw/routing-log.jsonl"
      logEnabled: true
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

This plugin's routing logic is adapted from [ClawRouter](https://github.com/BlockRunAI/ClawRouter) by BlockRunAI, which is MIT licensed. ClawRouter provides smart routing across 30+ models with x402 micropayments — if you need multi-provider routing, check them out.

Key differences:
- **ClawRouter**: Multi-provider (OpenAI, Anthropic, Google, DeepSeek, etc.) + x402 USDC payments
- **Anthropic Router**: Anthropic-only, uses your existing OpenClaw auth, no payment layer

## OpenClaw Plugin Development

This plugin uses OpenClaw's plugin API. Key resources:

- [OpenClaw Plugin Docs](https://docs.openclaw.ai/plugins)
- [Plugin CLI](https://docs.openclaw.ai/cli/plugins)
- [ClawRouter source](https://github.com/BlockRunAI/ClawRouter) (reference implementation)

### Plugin Structure

```
anthropic-router/
├── openclaw.plugin.json    # Plugin manifest
├── package.json
├── src/
│   ├── index.ts            # Plugin entry, registers hooks
│   ├── router/
│   │   ├── index.ts        # Main route() function
│   │   ├── rules.ts        # 14-dimension scoring
│   │   ├── config.ts       # Default config, keywords
│   │   └── types.ts        # TypeScript types
│   └── logger.ts           # JSONL logging
├── tsconfig.json
└── README.md
```

### Key Types

The plugin uses OpenClaw's duck-typed plugin API:

```typescript
type OpenClawPluginDefinition = {
  id: string;
  name: string;
  description: string;
  version: string;
  register: (api: OpenClawPluginApi) => void | Promise<void>;
};

type OpenClawPluginApi = {
  logger: PluginLogger;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  registerProvider: (provider: ProviderPlugin) => void;
  registerHook: (events: string | string[], handler: unknown) => void;
  registerService: (service: OpenClawPluginService) => void;
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  // ...
};
```

See `src/types.ts` for complete type definitions.

## License

MIT — see [LICENSE](LICENSE)

## Contributing

PRs welcome! Areas of interest:

- [ ] Better tier boundary tuning
- [ ] Extended thinking support for REASONING tier
- [ ] Analytics dashboard
- [ ] More keyword coverage (languages, domains)
