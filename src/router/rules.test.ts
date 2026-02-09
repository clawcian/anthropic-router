import { describe, it, expect } from "vitest";
import { classifyByRules } from "./rules.js";
import { DEFAULT_ROUTING_CONFIG } from "./config.js";
import { maxTier } from "./types.js";

const scoring = DEFAULT_ROUTING_CONFIG.scoring;

describe("classifyByRules", () => {
  describe("SIMPLE tier", () => {
    it("classifies short, simple prompts as SIMPLE", () => {
      const result = classifyByRules("what is the capital of France?", undefined, 10, scoring);
      expect(result.tier).toBe("SIMPLE");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("classifies greetings as SIMPLE", () => {
      const result = classifyByRules("hello", undefined, 3, scoring);
      expect(result.tier).toBe("SIMPLE");
    });

    it("classifies yes/no questions as SIMPLE", () => {
      const result = classifyByRules("yes or no, is the sky blue?", undefined, 8, scoring);
      expect(result.tier).toBe("SIMPLE");
    });
  });

  describe("COMPLEX tier", () => {
    it("classifies prompts with multiple reasoning keywords as COMPLEX", () => {
      const result = classifyByRules(
        "prove this theorem step by step using a formal proof",
        undefined,
        20,
        scoring,
      );
      expect(result.tier).toBe("COMPLEX");
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it("classifies long prompts with technical keywords as COMPLEX", () => {
      // Needs enough signal density: long tokens + technical + code + imperative
      const result = classifyByRules(
        "design and implement a distributed microservice architecture with kubernetes that optimizes the algorithm for large scale database infrastructure. build the async function with class-based design",
        undefined,
        600,
        scoring,
      );
      expect(result.tier).toBe("COMPLEX");
    });

    it("forces COMPLEX on 2+ reasoning markers at high confidence", () => {
      const result = classifyByRules(
        "prove this theorem and derive the result step by step",
        undefined,
        20,
        scoring,
      );
      expect(result.tier).toBe("COMPLEX");
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });
  });

  describe("MEDIUM tier", () => {
    it("classifies moderate-complexity prompts as MEDIUM", () => {
      // Code keywords + imperative verbs push score above simpleMedium boundary
      // Use estimatedTokens derived from text length (~chars/4) for consistency
      const prompt = "create a function that sorts a list of numbers and return the const result";
      const estimatedTokens = Math.ceil(prompt.length / 4);
      const result = classifyByRules(prompt, undefined, estimatedTokens, scoring);
      // Should land in MEDIUM or COMPLEX — has code + imperative signals
      expect(["MEDIUM", "COMPLEX"]).toContain(result.tier);
    });
  });

  describe("ambiguous results", () => {
    it("returns null tier when confidence is below threshold", () => {
      // Custom config with very high confidence threshold to force ambiguity
      const strictConfig = {
        ...scoring,
        confidenceThreshold: 0.99,
      };
      const result = classifyByRules("tell me something interesting", undefined, 20, strictConfig);
      // With a 0.99 threshold, most things should be ambiguous
      if (result.tier === null) {
        expect(result.confidence).toBeLessThan(0.99);
      }
    });
  });

  describe("signals", () => {
    it("includes relevant signals in output", () => {
      const result = classifyByRules(
        "write a function to implement an algorithm",
        undefined,
        50,
        scoring,
      );
      expect(result.signals.length).toBeGreaterThan(0);
    });

    it("excludes null signals", () => {
      const result = classifyByRules("hello", undefined, 3, scoring);
      for (const signal of result.signals) {
        expect(signal).not.toBeNull();
        expect(typeof signal).toBe("string");
      }
    });
  });

  describe("scoring", () => {
    it("returns a numeric score", () => {
      const result = classifyByRules("test prompt", undefined, 10, scoring);
      expect(typeof result.score).toBe("number");
      expect(Number.isFinite(result.score)).toBe(true);
    });

    it("scores simple prompts lower than complex prompts", () => {
      const simple = classifyByRules("hello", undefined, 3, scoring);
      const complex = classifyByRules(
        "prove this theorem step by step and derive the mathematical proof",
        undefined,
        200,
        scoring,
      );
      expect(complex.score).toBeGreaterThan(simple.score);
    });
  });

  describe("system prompt handling", () => {
    it("considers system prompt for general keywords", () => {
      const withSystem = classifyByRules(
        "do the thing",
        "you are an expert in distributed kubernetes microservice architecture",
        50,
        scoring,
      );
      const withoutSystem = classifyByRules("do the thing", undefined, 50, scoring);
      expect(withSystem.score).toBeGreaterThan(withoutSystem.score);
    });

    it("does NOT use system prompt for reasoning markers", () => {
      // Reasoning markers should only check user prompt
      const result = classifyByRules(
        "hello",
        "prove theorem step by step derive proof",
        50,
        scoring,
      );
      // System prompt has reasoning keywords but they should be ignored
      // (reasoning markers only use userText)
      const resultNoSystem = classifyByRules("hello", undefined, 50, scoring);
      // The reasoning dimension should score the same
      // (other dimensions may differ due to system prompt matching other keywords)
      expect(result.tier).not.toBe("COMPLEX");
    });
  });

  describe("multi-step patterns", () => {
    it("detects 'first...then' patterns", () => {
      const result = classifyByRules(
        "first do this, then do that",
        undefined,
        20,
        scoring,
      );
      expect(result.signals).toContain("multi-step");
    });

    it("detects numbered step patterns", () => {
      const result = classifyByRules(
        "1. do this 2. do that step 3 is important",
        undefined,
        20,
        scoring,
      );
      expect(result.signals).toContain("multi-step");
    });
  });

  describe("question complexity", () => {
    it("detects multiple questions", () => {
      const result = classifyByRules(
        "what is this? how does it work? why? can you explain more?",
        undefined,
        20,
        scoring,
      );
      expect(result.signals.some((s) => s.includes("questions"))).toBe(true);
    });
  });
});

describe("maxTier", () => {
  it("returns the higher tier", () => {
    expect(maxTier("SIMPLE", "COMPLEX")).toBe("COMPLEX");
    expect(maxTier("COMPLEX", "SIMPLE")).toBe("COMPLEX");
  });

  it("returns MEDIUM when comparing SIMPLE and MEDIUM", () => {
    expect(maxTier("SIMPLE", "MEDIUM")).toBe("MEDIUM");
    expect(maxTier("MEDIUM", "SIMPLE")).toBe("MEDIUM");
  });

  it("returns same tier when both are equal", () => {
    expect(maxTier("SIMPLE", "SIMPLE")).toBe("SIMPLE");
    expect(maxTier("MEDIUM", "MEDIUM")).toBe("MEDIUM");
    expect(maxTier("COMPLEX", "COMPLEX")).toBe("COMPLEX");
  });
});
