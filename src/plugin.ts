/**
 * Anthropic Router — OpenClaw Plugin Entry Point
 *
 * Registers the Anthropic Router as a model provider in OpenClaw.
 * Starts a local proxy on :8403 that scores prompt complexity and
 * routes to the cheapest capable Anthropic model (haiku/sonnet/opus).
 *
 * Usage:
 *   openclaw plugins install ./anthropic-router
 *   /model anthropic-router/auto
 */

import type {
  OpenClawPluginDefinition,
  OpenClawPluginApi,
  ModelProviderConfig,
  PluginCommandContext,
  PluginCommandResult,
} from "./types.js";
import { anthropicRouterProvider, setActiveProxyUrl } from "./provider.js";
import { OPENCLAW_MODELS } from "./models.js";
import { createApp, buildConfig, type ProxyConfig } from "./server.js";
import { expandPath } from "./logger.js";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_PORT = 8403;
const SESSION_PASSTHROUGH_KEY = "session-passthrough";

/** Shape of ~/.openclaw/openclaw.json (relevant fields only). */
type OpenClawConfig = {
  models?: {
    providers?: Record<string, ModelProviderConfig>;
  };
  [key: string]: unknown;
};

/** Shape of agent auth-profiles.json. */
type AuthProfileStore = {
  version: number;
  profiles: Record<string, unknown>;
};

/**
 * Detect if we're running in shell completion mode.
 * When `openclaw completion --shell zsh` runs, it loads plugins but only needs
 * the completion script output — any side effects pollute stdout.
 */
function isCompletionMode(): boolean {
  return process.argv.some((arg, i) => arg === "completion" && i >= 1 && i <= 3);
}

/**
 * Get proxy port from plugin config or environment.
 */
function getPort(pluginConfig?: Record<string, unknown>): number {
  const configPort = pluginConfig?.port;
  if (typeof configPort === "number" && configPort > 0 && configPort < 65536) {
    return configPort;
  }
  const envPort = process.env.ANTHROPIC_ROUTER_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
}

/**
 * Check if a proxy is already running on the given port by probing /health.
 */
async function checkExistingProxy(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = (await res.json()) as { status?: string };
      return data.status === "ok";
    }
    return false;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

/**
 * Inject models config into OpenClaw config file for persistence.
 * Best-effort — silently fails if config is inaccessible.
 */
function injectModelsConfig(
  port: number,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) {
    logger.info("OpenClaw config not found, skipping models injection");
    return;
  }

  try {
    const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};

    const expectedBaseUrl = `http://127.0.0.1:${port}`;
    const providerConfig: ModelProviderConfig = {
      baseUrl: expectedBaseUrl,
      api: "anthropic-messages",
      apiKey: SESSION_PASSTHROUGH_KEY,
      models: OPENCLAW_MODELS,
    };

    const existing = config.models.providers["anthropic-router"];
    if (existing && existing.baseUrl === expectedBaseUrl) {
      return; // Already up to date
    }

    config.models.providers["anthropic-router"] = providerConfig;

    // Atomic write: write to temp file then rename (prevents corruption on crash)
    const tmpPath = join(tmpdir(), `openclaw-config-${process.pid}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    renameSync(tmpPath, configPath);
    logger.info("Injected anthropic-router models config into openclaw.json");
  } catch (err) {
    logger.warn(`Config injection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Inject auth profile placeholder into agent auth stores.
 * OpenClaw may require auth entries to exist for the provider.
 */
function injectAuthProfile(logger: { info: (msg: string) => void; warn: (msg: string) => void }): void {
  const agentsDir = join(homedir(), ".openclaw", "agents");
  if (!existsSync(agentsDir)) {
    try {
      mkdirSync(agentsDir, { recursive: true });
    } catch {
      return;
    }
  }

  try {
    let agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    if (!agents.includes("main")) {
      agents = ["main", ...agents];
    }

    for (const agentId of agents) {
      const authDir = join(agentsDir, agentId, "agent");
      const authPath = join(authDir, "auth-profiles.json");

      if (!existsSync(authDir)) {
        try {
          mkdirSync(authDir, { recursive: true });
        } catch {
          continue;
        }
      }

      let store: AuthProfileStore;
      if (existsSync(authPath)) {
        try {
          const existing: AuthProfileStore = JSON.parse(readFileSync(authPath, "utf-8"));
          if (existing.version && existing.profiles) {
            store = existing;
          } else {
            continue; // Unrecognized format, skip this agent
          }
        } catch {
          continue; // Invalid JSON, skip rather than overwrite
        }
      } else {
        store = { version: 1, profiles: {} };
      }

      const profileKey = "anthropic-router:default";
      if (store.profiles[profileKey]) {
        continue;
      }

      store.profiles[profileKey] = {
        type: "api_key",
        provider: "anthropic-router",
        key: SESSION_PASSTHROUGH_KEY,
      };

      try {
        // Atomic write: temp file then rename
        const tmpPath = join(tmpdir(), `openclaw-auth-${process.pid}-${agentId}.tmp`);
        writeFileSync(tmpPath, JSON.stringify(store, null, 2));
        renameSync(tmpPath, authPath);
        logger.info(`Injected auth profile for agent: ${agentId}`);
      } catch (err) {
        logger.warn(`Auth profile write failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logger.warn(`Auth profile injection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Store active server handle for cleanup
let activeServer: { close: () => void } | null = null;

/**
 * /router stats — fetch routing statistics from the proxy's /stats endpoint.
 */
function makeStatsHandler(
  port: number,
): (ctx: PluginCommandContext) => Promise<PluginCommandResult> {
  return async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/stats`);
      const data = (await res.json()) as {
        totalRequests: number;
        tierDistribution: Record<string, number>;
        modelDistribution: Record<string, number>;
        averageTokens: number;
        averageConfidence: number;
        error?: { message: string };
      };

      if (!res.ok) {
        return { text: data.error?.message ?? "Failed to fetch stats", isError: true };
      }

      if (data.totalRequests === 0) {
        return { text: "No routing data yet. Send some requests first." };
      }

      const tierLines = Object.entries(data.tierDistribution)
        .map(([tier, count]) => `  ${tier}: ${count}`)
        .join("\n");
      const modelLines = Object.entries(data.modelDistribution)
        .map(([model, count]) => `  ${model}: ${count}`)
        .join("\n");

      return {
        text: [
          `Routing Statistics (${data.totalRequests} requests)`,
          "",
          "Tier distribution:",
          tierLines,
          "",
          "Model distribution:",
          modelLines,
          "",
          `Average tokens: ${data.averageTokens}`,
          `Average confidence: ${data.averageConfidence}`,
        ].join("\n"),
      };
    } catch {
      return { text: "Proxy not reachable. Is the router running?", isError: true };
    }
  };
}

/**
 * /router test <prompt> — dry-run score a prompt via the proxy's /test endpoint.
 */
function makeTestHandler(
  port: number,
): (ctx: PluginCommandContext) => Promise<PluginCommandResult> {
  return async (ctx) => {
    const prompt = ctx.args?.trim() ?? ctx.commandBody?.trim() ?? "";
    if (!prompt) {
      return { text: "Usage: /router test <prompt>", isError: true };
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = (await res.json()) as {
        tier: string;
        model: string;
        resolvedModel: string;
        confidence: number;
        estimatedTokens: number;
        signals: string[];
      };

      return {
        text: [
          `Tier: ${data.tier}`,
          `Model: ${data.resolvedModel} (${data.model})`,
          `Confidence: ${data.confidence}`,
          `Tokens: ${data.estimatedTokens}`,
          data.signals.length > 0
            ? `Signals: ${data.signals.join(", ")}`
            : "Signals: (none)",
        ].join("\n"),
      };
    } catch {
      return { text: "Proxy not reachable. Is the router running?", isError: true };
    }
  };
}

/**
 * Start the proxy server in the background.
 */
async function startProxyServer(
  port: number,
  api: OpenClawPluginApi,
): Promise<void> {
  // Check if proxy already running on this port
  const alreadyRunning = await checkExistingProxy(port);
  if (alreadyRunning) {
    api.logger.info(`Proxy already running on port ${port}, reusing`);
    setActiveProxyUrl(`http://127.0.0.1:${port}`);
    return;
  }

  const forceModel = api.pluginConfig?.forceModel as string | undefined;

  const config: ProxyConfig = {
    port,
    routingConfig: buildConfig(),
    logEnabled: process.env.LOG_ENABLED !== "false",
    logPath: expandPath(process.env.LOG_PATH ?? "~/.openclaw/routing-log.jsonl"),
    forceModel,
  };

  const app = createApp(config);

  // Dynamic import to avoid pulling node:http into bundle unnecessarily
  const { serve } = await import("@hono/node-server");
  const server = serve(
    { fetch: app.fetch, port, hostname: "127.0.0.1" },
    (info) => {
      api.logger.info(
        `Anthropic Router proxy listening on http://127.0.0.1:${info.port}`,
      );
      setActiveProxyUrl(`http://127.0.0.1:${info.port}`);
    },
  );

  activeServer = server;

  // Poll /health to confirm readiness (max 5 attempts, 100ms apart)
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const ready = await checkExistingProxy(port);
    if (ready) {
      api.logger.info("Proxy ready");
      return;
    }
  }
  api.logger.warn("Proxy started but health check did not confirm readiness");
}

const plugin: OpenClawPluginDefinition = {
  id: "anthropic-router",
  name: "Anthropic Router",
  description:
    "Smart routing — automatically selects cheapest capable Anthropic model per request",

  register(api: OpenClawPluginApi) {
    // Skip heavy initialization in completion mode
    if (isCompletionMode()) {
      api.registerProvider(anthropicRouterProvider);
      return;
    }

    const port = getPort(api.pluginConfig);

    // Register provider (sync — available immediately)
    api.registerProvider(anthropicRouterProvider);

    // Inject config into openclaw.json for persistence
    injectModelsConfig(port, api.logger);

    // Inject auth profile placeholders
    injectAuthProfile(api.logger);

    // Set runtime config for immediate availability
    if (!api.config.models) {
      api.config.models = { providers: {} };
    }
    if (!api.config.models.providers) {
      api.config.models.providers = {};
    }
    api.config.models.providers["anthropic-router"] = {
      baseUrl: `http://127.0.0.1:${port}`,
      api: "anthropic-messages",
      apiKey: SESSION_PASSTHROUGH_KEY,
      models: OPENCLAW_MODELS,
    };

    api.logger.info("Anthropic Router provider registered");

    // Register service with stop() for cleanup
    api.registerService({
      id: "anthropic-router-proxy",
      start: () => {
        // No-op: proxy started in register() below
      },
      stop: async () => {
        if (activeServer) {
          try {
            activeServer.close();
            api.logger.info("Anthropic Router proxy closed");
          } catch (err) {
            api.logger.warn(
              `Failed to close proxy: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          activeServer = null;
        }
      },
    });

    // Register plugin commands
    api.registerCommand({
      name: "router stats",
      description: "Show routing tier/model distribution statistics",
      acceptsArgs: false,
      handler: makeStatsHandler(port),
    });

    api.registerCommand({
      name: "router test",
      description: "Dry-run score a prompt and show the routing decision",
      acceptsArgs: true,
      handler: makeTestHandler(port),
    });

    api.logger.info("Registered /router stats and /router test commands");

    // Start proxy in background (fire-and-forget)
    startProxyServer(port, api).catch((err) => {
      api.logger.error(
        `Failed to start proxy: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  },
};

export default plugin;
