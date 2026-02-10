import { describe, it, expect, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { buildConfig, createApp } from "./server.js";
import { DEFAULT_ROUTING_CONFIG } from "./router/index.js";
import type { ProxyConfig } from "./server.js";

/**
 * Create a mock Anthropic client for testing.
 * For 2xx: .asResponse() resolves to a raw Response (matching SDK zero-copy pattern).
 * For 4xx/5xx: .asResponse() rejects with APIError (matching real SDK behavior).
 */
function createMockClient(responseBody: unknown, status = 200, contentType = "application/json") {
  const mockCreate = vi.fn().mockReturnValue({
    asResponse: () => {
      if (status >= 400) {
        // SDK throws APIError for non-2xx — reconstruct the same shape
        const err = new Anthropic.APIError(
          status,
          { error: responseBody },
          undefined,
          new Headers({ "Content-Type": contentType }),
        );
        return Promise.reject(err);
      }
      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status,
          headers: { "Content-Type": contentType },
        }),
      );
    },
  });
  return {
    client: { messages: { create: mockCreate } } as unknown as Anthropic,
    mockCreate,
  };
}

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
    routingConfig: buildConfig(),
    logEnabled: false,
    logPath: "/tmp/test-routing.jsonl",
  };

  // Use a shared mock client for endpoints that don't hit the SDK
  const { client: dummyClient } = createMockClient({});

  describe("GET /health", () => {
    it("returns 200 with ok status and plugin info", async () => {
      const app = createApp(testConfig, dummyClient);
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.plugin).toBe("anthropic-router");
      expect(body.port).toBe(8403);
    });
  });

  describe("POST /test", () => {
    it("scores a prompt and returns routing decision", async () => {
      const app = createApp(testConfig, dummyClient);
      const res = await app.request("/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      const app = createApp(testConfig, dummyClient);
      const res = await app.request("/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      });
      const body = await res.json();
      expect(body.resolvedModel).toMatch(/^claude-/);
    });

    it("accepts optional system prompt", async () => {
      const app = createApp(testConfig, dummyClient);
      const res = await app.request("/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      const { client } = createMockClient({});
      const app = createApp(testConfig, client);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("invalid_request");
    });

    it("rejects missing messages array", async () => {
      const { client } = createMockClient({});
      const app = createApp(testConfig, client);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5-20250929" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.type).toBe("invalid_request");
    });

    it("rejects messages that is not an array", async () => {
      const { client } = createMockClient({});
      const app = createApp(testConfig, client);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: "not an array" }),
      });
      expect(res.status).toBe(400);
    });

    it("forwards request to Anthropic SDK with rewritten model", async () => {
      const mockResponse = { id: "msg_123", content: [{ type: "text", text: "hi" }] };
      const { client, mockCreate } = createMockClient(mockResponse);
      const app = createApp(testConfig, client);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 1024,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("msg_123");

      // Verify SDK was called with a rewritten model (not the original)
      expect(mockCreate).toHaveBeenCalledOnce();
      const sdkParams = mockCreate.mock.calls[0][0];
      expect(sdkParams.model).toMatch(/^claude-/);
      expect(sdkParams.messages).toEqual([{ role: "user", content: "hello" }]);
    });

    it("adds routing transparency headers", async () => {
      const { client } = createMockClient({ id: "msg_123" });
      const app = createApp(testConfig, client);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 1024,
        }),
      });
      expect(res.headers.get("X-Router-Tier")).toBeTruthy();
      expect(res.headers.get("X-Router-Model")).toMatch(/^claude-/);
      expect(res.headers.get("X-Router-Confidence")).toBeTruthy();
    });

    it("adds SSE headers for streaming requests", async () => {
      const { client } = createMockClient(
        { type: "message_start" },
        200,
        "text/event-stream",
      );
      const app = createApp(testConfig, client);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 1024,
          stream: true,
        }),
      });
      expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
      expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    });

    it("passes through upstream error status codes from SDK APIError", async () => {
      const { client } = createMockClient(
        { type: "rate_limit", message: "too many requests" },
        429,
      );
      const app = createApp(testConfig, client);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 1024,
        }),
      });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.type).toBe("rate_limit");
    });

    it("passes through 401 auth errors from SDK", async () => {
      const { client } = createMockClient(
        { type: "authentication_error", message: "invalid api key" },
        401,
      );
      const app = createApp(testConfig, client);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 1024,
        }),
      });
      expect(res.status).toBe(401);
    });

    it("uses forceModel when configured", async () => {
      const { client, mockCreate } = createMockClient({ id: "msg_forced" });
      const app = createApp({ ...testConfig, forceModel: "claude-opus-4-6" }, client);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 1024,
        }),
      });
      expect(res.status).toBe(200);
      const sdkParams = mockCreate.mock.calls[0][0];
      expect(sdkParams.model).toBe("claude-opus-4-6");
    });

    it("allowlists known fields only", async () => {
      const { client, mockCreate } = createMockClient({ id: "msg_123" });
      const app = createApp(testConfig, client);
      await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 1024,
          evil_field: "should be dropped",
        }),
      });
      const sdkParams = mockCreate.mock.calls[0][0];
      expect(sdkParams).not.toHaveProperty("evil_field");
    });
  });

  describe("GET /stats", () => {
    it("returns empty stats on fresh app instance", async () => {
      const app = createApp(testConfig, dummyClient);
      const res = await app.request("/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalRequests).toBe(0);
      expect(body.tierDistribution).toEqual({});
      expect(body.modelDistribution).toEqual({});
      expect(body.averageTokens).toBe(0);
      expect(body.averageConfidence).toBe(0);
    });
  });

  describe("error responses", () => {
    it("uses consistent error envelope structure", async () => {
      const { client } = createMockClient({});
      const app = createApp(testConfig, client);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const body = await res.json();
      expect(body.error).toHaveProperty("type");
      expect(body.error).toHaveProperty("message");
      expect(typeof body.error.type).toBe("string");
      expect(typeof body.error.message).toBe("string");
    });

    it("does not leak internal config in error responses", async () => {
      const { client } = createMockClient({});
      const app = createApp(testConfig, client);
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const body = await res.json();
      expect(body).not.toHaveProperty("fallbackModel");
      expect(JSON.stringify(body)).not.toContain("claude-");
    });
  });
});
