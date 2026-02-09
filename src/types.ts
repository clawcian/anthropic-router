/**
 * OpenClaw Plugin Types (locally defined)
 *
 * OpenClaw's plugin SDK uses duck typing — these match the shapes
 * expected by the plugin system.
 *
 * Adapted from ClawRouter (MIT licensed, BlockRunAI)
 */

// ─── Plugin API Types ───

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type OpenClawPluginService = {
  id: string;
  start: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
};

export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerProvider: (provider: unknown) => void;
  registerTool: (tool: unknown, opts?: unknown) => void;
  registerHook: (events: string | string[], handler: unknown, opts?: unknown) => void;
  registerHttpRoute: (params: { path: string; handler: unknown }) => void;
  registerService: (service: OpenClawPluginService) => void;
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  resolvePath: (input: string) => string;
  on: (hookName: string, handler: unknown, opts?: unknown) => void;
};

export type OpenClawPluginDefinition = {
  id: string;
  name: string;
  description: string;
  version: string;
  register: (api: OpenClawPluginApi) => void | Promise<void>;
};

export type PluginCommandContext = {
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
  config: Record<string, unknown>;
};

export type PluginCommandResult = {
  text?: string;
  isError?: boolean;
};

export type OpenClawPluginCommandDefinition = {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
};

// ─── Router Types ───

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX";

export type TierConfig = {
  SIMPLE: string;
  MEDIUM: string;
  COMPLEX: string;
};

export type ScoringConfig = {
  tokenCountThresholds: { simple: number; complex: number };
  codeKeywords: string[];
  reasoningKeywords: string[];
  simpleKeywords: string[];
  technicalKeywords: string[];
  creativeKeywords: string[];
  imperativeVerbs: string[];
  constraintIndicators: string[];
  outputFormatKeywords: string[];
  referenceKeywords: string[];
  negationKeywords: string[];
  domainSpecificKeywords: string[];
  dimensionWeights: Record<string, number>;
  tierBoundaries: {
    simpleMedium: number;
    mediumComplex: number;
  };
  confidenceSteepness: number;
  confidenceThreshold: number;
};

export type RoutingConfig = {
  version: string;
  scoring: ScoringConfig;
  tiers: TierConfig;
  overrides: {
    maxTokensForceComplex: number;
    ambiguousDefaultTier: Tier;
  };
};

export type ScoringResult = {
  score: number;
  tier: Tier | null;
  confidence: number;
  signals: string[];
};

export type RoutingDecision = {
  model: string;
  tier: Tier;
  confidence: number;
  method: "rules";
  reasoning: string;
  costEstimate: number;
  savings: number;
};

export type PluginConfig = {
  tiers?: Partial<TierConfig>;
  scoring?: Partial<ScoringConfig>;
  forceModel?: string;
  logEnabled?: boolean;
  logPath?: string;
};
