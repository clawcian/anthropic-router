/**
 * JSONL Logger for Routing Decisions
 *
 * Logs every routing decision for analysis.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { RoutingDecision } from "./router/types.js";

export type LogEntry = {
  ts: number;
  promptHash: string;
  tier: string;
  model: string;
  tokens: number;
  confidence: number;
  signals: string[];
  reasoning: string;
};

/**
 * Log a routing decision to JSONL file.
 */
export function logDecision(
  decision: RoutingDecision,
  prompt: string,
  logPath: string,
): void {
  try {
    // Ensure directory exists
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Hash prompt for privacy
    const promptHash = createHash("sha256")
      .update(prompt)
      .digest("hex")
      .slice(0, 12);

    const estimatedTokens = Math.ceil(prompt.length / 4);

    const entry: LogEntry = {
      ts: Date.now(),
      promptHash,
      tier: decision.tier,
      model: decision.model,
      tokens: estimatedTokens,
      confidence: Math.round(decision.confidence * 100) / 100,
      signals: decision.reasoning.split(" | ").slice(1), // Skip score prefix
      reasoning: decision.reasoning,
    };

    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // Silently fail — logging shouldn't break routing
  }
}

/**
 * Expand ~ to home directory.
 */
export function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return path.replace("~", process.env.HOME || "");
  }
  return path;
}
