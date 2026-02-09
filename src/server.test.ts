import { describe, it, expect } from "vitest";
import { buildConfig, createApp } from "./server.js";
import { DEFAULT_ROUTING_CONFIG } from "./router/index.js";
import type { ProxyConfig } from "./server.js";

describe("buildConfig", () => {
  it("returns a deep clone of defaults when no overrides", () => {
    const config = buildConfig();
    expect(config).toEqual(DEFAULT_ROUTING_CONFIG);
    expect(config).not.toBe(DEFAULT_ROUTING_CONFIG);
    expect(config.scoring).not.toBe(DEFAULT_ROUTING_CONFIG.scoring);
    expect(config.scoring.dimensionWeights).not.toBe(
      DEFAULT_ROUTING_CONFIG.scoring.dimensionWeights,
    );
  });

  it("merges tier overrides without destroying other tiers", () => {
    const config = buildConfig({
      tiers: { SIMPLE: "custom-haiku" },
    });
    expect(config.tiers.SIMPLE).toBe("custom-haiku");
    expect(config.tiers.MEDIUM).toBe("sonnet");
    expect(config.tiers.COMPLEX).toBe("opus");
  });

  it("merges dimension weight overrides without destroying other weights", () => {
    const config = buildConfig({
      scoring: {
        dimensionWeights: { tokenCount: 0.5 } as Partial<typeof DEFAULT_ROUTING_CONFIG.scoring.dimensionWeights>,
      },
    });
    expect(config.scoring.dimensionWeights.tokenCount).toBe(0.5);
    expect(config.scoring.dimensionWeights.codePresence).toBe(
      DEFAULT_ROUTING_CONFIG.scoring.dimensionWeights.codePresence,
    );
  });

  it("merges tier boundary overrides without destroying other boundaries", () => {
    const config = buildConfig({
      scoring: {
        tierBoundaries: { simpleMedium: 0.1 } as Partial<typeof DEFAULT_ROUTING_CONFIG.scoring.tierBoundaries>,
      },
    });
    expect(config.scoring.tierBoundaries.simpleMedium).toBe(0.1);
    expect(config.scoring.tierBoundaries.mediumComplex).toBe(
      DEFAULT_ROUTING_CONFIG.scoring.tierBoundaries.mediumComplex,
    );
  });

  it("merges override config", () => {
    const config = buildConfig({
      overrides: { ambiguousDefaultTier: "COMPLEX" },
    });
    expect(config.overrides.ambiguousDefaultTier).toBe("COMPLEX");
    expect(config.overrides.maxTokensForceComplex).toBe(
      DEFAULT_ROUTING_CONFIG.overrides.maxTokensForceComplex,
    );
  });

  it("merges scalar scoring fields", () => {
    const config = buildConfig({
      scoring: {
        confidenceThreshold: 0.9,
        confidenceSteepness: 20,
      },
    });
    expect(config.scoring.confidenceThreshold).toBe(0.9);
    expect(config.scoring.confidenceSteepness).toBe(20);
    expect(config.scoring.codeKeywords).toEqual(
      DEFAULT_ROUTING_CONFIG.scoring.codeKeywords,
    );
  });

  it("does not mutate DEFAULT_ROUTING_CONFIG", () => {
    const original = structuredClone(DEFAULT_ROUTING_CONFIG);
    buildConfig({ tiers: { SIMPLE: "mutated" } });
    expect(DEFAULT_ROUTING_CONFIG).toEqual(original);
  });
});

describe("createApp", () => {
  const testConfig: ProxyConfig = {
    port: 8403,
    anthropicApiKey: "test-key",
    proxySecret: "test-secret",
    routingConfig: buildConfig(),
    logEnabled: false,
    logPath: "/tmp/test-routing.jsonl",
  };

  const authHeaders = {
    Authorization: "Bearer test-secret",
    "Content-Type": "application/json",
  };

  describe("authentication", () => {
    it("allows /health without auth", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });

    it("rejects unauthenticated requests to /test", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.type).toBe("authentication_error");
    });

    it("rejects unauthenticated requests to /v1/messages", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated requests to /stats", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/stats");
      expect(res.status).toBe(401);
    });

    it("rejects wrong bearer token", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/test", {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "hello" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /health", () => {
    it("returns 200 with ok status", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });
  });

  describe("POST /test", () => {
    it("scores a prompt and returns routing decision", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/test", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ prompt: "what is 2+2?" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("tier");
      expect(body).toHaveProperty("model");
      expect(body).toHaveProperty("confidence");
      expect(body).toHaveProperty("resolvedModel");
      expect(body).toHaveProperty("estimatedTokens");
      expect(["SIMPLE", "MEDIUM", "COMPLEX"]).toContain(body.tier);
    });

    it("resolves tier model names to full API IDs", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/test", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ prompt: "hello" }),
      });
      const body = await res.json();
      expect(body.resolvedModel).toMatch(/^claude-/);
    });

    it("accepts optional system prompt", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/test", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          prompt: "do the thing",
          system: "you are a distributed systems architect",
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveProperty("tier");
    });
  });

  describe("POST /v1/messages", () => {
    it("rejects invalid JSON", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: authHeaders,
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("invalid_request");
    });

    it("rejects missing messages array", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "claude-sonnet-4-5-20250929" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request");
    });

    it("rejects messages that is not an array", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ messages: "not an array" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /stats", () => {
    it("returns 400 when logging is disabled", async () => {
      const app = createApp(testConfig); // logEnabled: false
      const res = await app.request("/stats", {
        headers: { Authorization: "Bearer test-secret" },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request");
    });

    it("returns empty stats when log file does not exist", async () => {
      const app = createApp({
        ...testConfig,
        logEnabled: true,
        logPath: "/tmp/nonexistent-test-log-" + Date.now() + ".jsonl",
      });
      const res = await app.request("/stats", {
        headers: { Authorization: "Bearer test-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalRequests).toBe(0);
      expect(body.tierDistribution).toEqual({});
      expect(body.modelDistribution).toEqual({});
    });
  });

  describe("error responses", () => {
    it("uses consistent error envelope structure", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: authHeaders,
        body: "not json",
      });
      const body = await res.json();
      expect(body.error).toHaveProperty("type");
      expect(body.error).toHaveProperty("message");
      expect(typeof body.error.type).toBe("string");
      expect(typeof body.error.message).toBe("string");
    });

    it("does not leak internal config in error responses", async () => {
      const app = createApp(testConfig);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: authHeaders,
        body: "not json",
      });
      const body = await res.json();
      expect(body).not.toHaveProperty("fallbackModel");
      expect(JSON.stringify(body)).not.toContain("claude-");
    });
  });
});
