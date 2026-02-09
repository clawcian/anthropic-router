/**
 * Anthropic Router - OpenClaw Plugin
 *
 * Routes each request to the cheapest Anthropic model that can handle it.
 * Uses 14-dimension weighted scoring for classification.
 *
 * Routing logic adapted from ClawRouter (MIT licensed, BlockRunAI)
 * https://github.com/BlockRunAI/ClawRouter
 */

import type {
  OpenClawPluginDefinition,
  OpenClawPluginApi,
  PluginCommandContext,
} from "./types.js";
import { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
import type { RoutingConfig, TierConfig, ScoringConfig } from "./router/types.js";
import { logDecision, expandPath } from "./logger.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read version from package.json
const packageJsonPath = join(import.meta.dirname, "..", "package.json");
let VERSION = "0.1.0";
try {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  VERSION = pkg.version;
} catch {
  // Use default version
}

type PluginConfig = {
  tiers?: Partial<TierConfig>;
  scoring?: Partial<ScoringConfig>;
  forceModel?: string;
  logEnabled?: boolean;
  logPath?: string;
};

/**
 * Merge user config with defaults.
 */
function buildConfig(pluginConfig?: PluginConfig): RoutingConfig {
  const config = structuredClone(DEFAULT_ROUTING_CONFIG);

  if (pluginConfig?.tiers) {
    Object.assign(config.tiers, pluginConfig.tiers);
  }

  if (pluginConfig?.scoring) {
    Object.assign(config.scoring, pluginConfig.scoring);
    if (pluginConfig.scoring.dimensionWeights) {
      Object.assign(config.scoring.dimensionWeights, pluginConfig.scoring.dimensionWeights);
    }
    if (pluginConfig.scoring.tierBoundaries) {
      Object.assign(config.scoring.tierBoundaries, pluginConfig.scoring.tierBoundaries);
    }
  }

  return config;
}

const plugin: OpenClawPluginDefinition = {
  id: "anthropic-router",
  name: "Anthropic Router",
  description: "Route to cheapest Anthropic model based on complexity",
  version: VERSION,

  register(api: OpenClawPluginApi) {
    const pluginConfig = api.pluginConfig as PluginConfig | undefined;
    const routingConfig = buildConfig(pluginConfig);

    const logEnabled = pluginConfig?.logEnabled ?? true;
    const logPath = expandPath(pluginConfig?.logPath ?? "~/.openclaw/routing-log.jsonl");

    api.logger.info("Anthropic Router active");
    api.logger.info(`Tiers: SIMPLE=${routingConfig.tiers.SIMPLE}, MEDIUM=${routingConfig.tiers.MEDIUM}, COMPLEX=${routingConfig.tiers.COMPLEX}`);

    // Register model routing hook
    // TODO: OpenClaw may need to expose a model selector hook
    // For now, we register a hook that can be called manually
    api.registerHook("model:select", (context: { prompt: string; systemPrompt?: string }) => {
      // Force model override
      if (pluginConfig?.forceModel) {
        return { model: pluginConfig.forceModel };
      }

      const decision = route(context.prompt, context.systemPrompt, { config: routingConfig });

      // Log decision
      if (logEnabled) {
        logDecision(decision, context.prompt, logPath);
      }

      api.logger.info(`[${decision.tier}] ${decision.model} (${(decision.confidence * 100).toFixed(0)}%) | ${decision.reasoning}`);

      return { model: decision.model };
    });

    // Register /route command for testing
    api.registerCommand({
      name: "route",
      description: "Test the router with a prompt",
      acceptsArgs: true,
      requireAuth: false,
      handler: (ctx: PluginCommandContext) => {
        const prompt = ctx.args?.trim();
        if (!prompt) {
          return {
            text: "Usage: /route <prompt>\n\nExample: /route What is 2+2?",
            isError: true,
          };
        }

        // Force model override
        if (pluginConfig?.forceModel) {
          return {
            text: `**Force Model Active:** ${pluginConfig.forceModel}\n\nDisable \`forceModel\` in config to test routing.`,
          };
        }

        const decision = route(prompt, undefined, { config: routingConfig });

        // Log decision
        if (logEnabled) {
          logDecision(decision, prompt, logPath);
        }

        return {
          text: [
            "🎯 **Routing Decision**",
            "",
            `**Tier:** ${decision.tier}`,
            `**Model:** \`${decision.model}\``,
            `**Confidence:** ${(decision.confidence * 100).toFixed(0)}%`,
            "",
            `**Reasoning:** ${decision.reasoning}`,
          ].join("\n"),
        };
      },
    });

    // Register /route-stats command
    api.registerCommand({
      name: "route-stats",
      description: "Show routing statistics",
      acceptsArgs: false,
      requireAuth: false,
      handler: () => {
        try {
          const data = readFileSync(logPath, "utf-8");
          const lines = data.trim().split("\n").filter(Boolean);
          
          if (lines.length === 0) {
            return { text: "No routing data yet." };
          }

          const entries = lines.map((line) => JSON.parse(line));
          const tierCounts: Record<string, number> = { SIMPLE: 0, MEDIUM: 0, COMPLEX: 0 };
          
          for (const entry of entries) {
            tierCounts[entry.tier] = (tierCounts[entry.tier] || 0) + 1;
          }

          const total = entries.length;
          const pctSimple = ((tierCounts.SIMPLE / total) * 100).toFixed(1);
          const pctMedium = ((tierCounts.MEDIUM / total) * 100).toFixed(1);
          const pctComplex = ((tierCounts.COMPLEX / total) * 100).toFixed(1);

          // Estimate cost savings
          // Haiku: $1/M, Sonnet: $3/M, Opus: $15/M
          const avgTokens = entries.reduce((sum, e) => sum + e.tokens, 0) / total;
          const blendedCost = (
            (tierCounts.SIMPLE * 1 + tierCounts.MEDIUM * 3 + tierCounts.COMPLEX * 15) / total
          );
          const savings = ((1 - blendedCost / 15) * 100).toFixed(0);

          return {
            text: [
              "📊 **Routing Statistics**",
              "",
              `**Total Requests:** ${total}`,
              `**Avg Tokens:** ${avgTokens.toFixed(0)}`,
              "",
              "**Tier Distribution:**",
              `• SIMPLE (Haiku): ${tierCounts.SIMPLE} (${pctSimple}%)`,
              `• MEDIUM (Sonnet): ${tierCounts.MEDIUM} (${pctMedium}%)`,
              `• COMPLEX (Opus): ${tierCounts.COMPLEX} (${pctComplex}%)`,
              "",
              `**Blended Cost:** $${blendedCost.toFixed(2)}/M tokens`,
              `**vs Always-Opus:** ~${savings}% savings`,
            ].join("\n"),
          };
        } catch {
          return { text: "No routing data yet or log file not found." };
        }
      },
    });
  },
};

export default plugin;

// Re-export for programmatic use
export { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
export type { RoutingDecision, Tier, RoutingConfig } from "./router/types.js";
