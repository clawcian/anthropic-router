/**
 * Router Types
 * 
 * Adapted from ClawRouter (MIT licensed, BlockRunAI)
 */

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX";

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

export type TierConfig = {
  SIMPLE: string;
  MEDIUM: string;
  COMPLEX: string;
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
