import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupSoleActiveProvider() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "routerdone-sole-active-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const { createProviderNode, createProviderConnection } = await import("@/lib/localDb.js");
  const { markAccountUnavailable, getProviderCredentials } = await import("@/sse/services/auth.js");

  const node = await createProviderNode({
    type: "openai-compatible",
    name: "test-provider",
    prefix: "tp",
    apiType: "chat",
    baseUrl: "https://example.test/v1",
  });

  return {
    node,
    createProviderConnection,
    markAccountUnavailable,
    getProviderCredentials,
    cleanup() {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can keep sqlite handles briefly after tests finish.
      }
    },
  };
}

async function setupMultiActiveProvider() {
  const ctx = await setupSoleActiveProvider();
  // Add a second active connection so the failing one is no longer sole.
  const second = await ctx.createProviderConnection({
    provider: ctx.node.id,
    authType: "apikey",
    name: "2",
    apiKey: "sk-second",
    isActive: true,
  });
  return { ...ctx, second };
}

describe("markAccountUnavailable — self-heal on sole active connection", () => {
  let ctx;

  beforeEach(async () => {
    ctx = await setupSoleActiveProvider();
  });

  afterEach(() => {
    ctx?.cleanup();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("does NOT set modelLock when self-heal error + sole active connection", async () => {
    const conn = await ctx.createProviderConnection({
      provider: ctx.node.id,
      authType: "apikey",
      name: "1",
      apiKey: "sk-test",
      isActive: true,
    });

    const result = await ctx.markAccountUnavailable(
      conn.id,
      502,
      "Empty upstream stream (terminal before productive)",
      ctx.node.id,
      "test-model",
      null,
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.selfHeal).toBe(true);
    expect(result.soleActive).toBe(true);
    expect(result.cooldownMs).toBe(0);

    // The connection must still be selectable (no active model lock).
    const creds = await ctx.getProviderCredentials(ctx.node.id, null, "test-model");
    expect(creds).not.toBeNull();
    expect(creds?.allRateLimited).not.toBe(true);
  });

  it("DOES set modelLock when self-heal error but a second active account exists", async () => {
    ctx.cleanup();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    ctx = await setupMultiActiveProvider();

    const first = await ctx.createProviderConnection({
      provider: ctx.node.id,
      authType: "apikey",
      name: "1",
      apiKey: "sk-first",
      isActive: true,
    });

    const result = await ctx.markAccountUnavailable(
      first.id,
      502,
      "Empty upstream stream (terminal before productive)",
      ctx.node.id,
      "test-model",
      null,
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.selfHeal).toBe(true);
    expect(result.soleActive).toBe(false);

    // First connection should be locked for the model now (3s self-heal window).
    const credsFirst = await ctx.getProviderCredentials(ctx.node.id, new Set([ctx.second.id]), "test-model");
    // The second account must still be selectable (fallback path works).
    expect(credsFirst).not.toBeNull();
    if (credsFirst && !credsFirst.allRateLimited) {
      expect(credsFirst.connectionId).toBe(ctx.second.id);
    }
  });

  it("still locks for non-self-heal errors even on sole active connection", async () => {
    const conn = await ctx.createProviderConnection({
      provider: ctx.node.id,
      authType: "apikey",
      name: "1",
      apiKey: "sk-test",
      isActive: true,
    });

    // 401 is NOT a self-heal error → normal lock path applies even when sole.
    const result = await ctx.markAccountUnavailable(
      conn.id,
      401,
      "Invalid API key",
      ctx.node.id,
      "test-model",
      null,
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.selfHeal).toBe(false);
    // 401 cooldown is COOLDOWN.long (2 min) per errorConfig rules.
    expect(result.cooldownMs).toBeGreaterThan(0);
  });
});
