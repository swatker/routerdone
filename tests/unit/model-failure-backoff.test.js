import { describe, it, expect } from "vitest";
import {
  MODEL_FAILURE_PREFIX,
  MODEL_FAILURE_ALL,
  getModelFailureKey,
  getModelFailureCount,
  getModelBackoffCooldownMs,
  buildModelFailureBackoffUpdate,
  buildClearModelFailureUpdate,
  isRateLimitError,
  getModelFailureAtKey,
  MODEL_LOCK_PREFIX,
  checkFallbackError,
  isClientPayloadError,
  isProviderSelfHealError,
  shouldDisableConnectionForError,
  shouldLockConnectionForError,
  isModelLockActive,
  getEarliestModelLockUntil,
} from "../../open-sse/services/accountFallback.js";
import {
  MODEL_FAILURE_BACKOFF_BASE_MS,
  MODEL_FAILURE_BACKOFF_MAX_MS,
  MODEL_FAILURE_IDLE_RESET_MS,
  PROVIDER_SELF_HEAL_COOLDOWN_MS,
} from "../../open-sse/config/errorConfig.js";

describe("per-model consecutive-failure backoff", () => {
  it("uses a prefix distinct from modelLock_ so counters survive lock expiry", () => {
    expect(MODEL_FAILURE_PREFIX).toBe("modelFailure_");
    expect("modelFailure_gpt-4".startsWith(MODEL_LOCK_PREFIX)).toBe(false);
  });

  it("builds per-model and __all keys", () => {
    expect(getModelFailureKey("gpt-4")).toBe("modelFailure_gpt-4");
    expect(getModelFailureKey(null)).toBe(MODEL_FAILURE_ALL);
    expect(MODEL_FAILURE_ALL).toBe("modelFailure___all");
  });

  it("reads stored count, defaults to 0 for missing/invalid", () => {
    expect(getModelFailureCount({}, "gpt-4")).toBe(0);
    expect(getModelFailureCount(null, "gpt-4")).toBe(0);
    expect(getModelFailureCount({ "modelFailure_gpt-4": 3 }, "gpt-4")).toBe(3);
    expect(getModelFailureCount({ "modelFailure_gpt-4": -1 }, "gpt-4")).toBe(0);
    expect(getModelFailureCount({ "modelFailure_gpt-4": "oops" }, "gpt-4")).toBe(0);
  });

  it("doubles cooldown on each consecutive failure, capped at max", () => {
    expect(getModelBackoffCooldownMs(1)).toBe(MODEL_FAILURE_BACKOFF_BASE_MS);
    expect(getModelBackoffCooldownMs(2)).toBe(MODEL_FAILURE_BACKOFF_BASE_MS * 2);
    expect(getModelBackoffCooldownMs(3)).toBe(MODEL_FAILURE_BACKOFF_BASE_MS * 4);
    expect(getModelBackoffCooldownMs(4)).toBe(MODEL_FAILURE_BACKOFF_BASE_MS * 8);
    const huge = getModelBackoffCooldownMs(100);
    expect(huge).toBe(MODEL_FAILURE_BACKOFF_MAX_MS);
    expect(huge).toBeLessThanOrEqual(MODEL_FAILURE_BACKOFF_MAX_MS);
  });

  it("bumps the counter and returns the matching cooldown + update", () => {
    const r1 = buildModelFailureBackoffUpdate({}, "gpt-4");
    expect(r1.count).toBe(1);
    expect(r1.cooldownMs).toBe(MODEL_FAILURE_BACKOFF_BASE_MS);
    expect(r1.update["modelFailure_gpt-4"]).toBe(1);
    expect(r1.update[getModelFailureAtKey("gpt-4")]).toBeGreaterThan(0);

    const r2 = buildModelFailureBackoffUpdate({ "modelFailure_gpt-4": 1 }, "gpt-4");
    expect(r2.count).toBe(2);
    expect(r2.cooldownMs).toBe(MODEL_FAILURE_BACKOFF_BASE_MS * 2);
    expect(r2.update["modelFailure_gpt-4"]).toBe(2);
    expect(r2.update[getModelFailureAtKey("gpt-4")]).toBeGreaterThan(0);
  });

  it("clears only the succeeded model counter, preserving others", () => {
    const conn = { "modelFailure_gpt-4": 5, "modelFailure_claude": 3 };
    const upd = buildClearModelFailureUpdate(conn, "gpt-4");
    expect(upd).toEqual({ "modelFailure_gpt-4": 0 });
    expect(upd["modelFailure_claude"]).toBeUndefined();
  });

  it("clears __all counter on a model-less success", () => {
    const conn = { "modelFailure___all": 4, "modelFailure_gpt-4": 2 };
    const upd = buildClearModelFailureUpdate(conn, null);
    expect(upd).toEqual({ "modelFailure___all": 0 });
  });

  it("returns empty update when nothing to clear", () => {
    expect(buildClearModelFailureUpdate({}, "gpt-4")).toEqual({});
    expect(buildClearModelFailureUpdate(null, "gpt-4")).toEqual({});
  });
});

describe("model DB lock scope", () => {
  it("can ignore per-model locks while preserving account-level locks", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isModelLockActive({ "modelLock_gpt-4": future }, "gpt-4")).toBe(true);
    expect(isModelLockActive({ "modelLock_gpt-4": future }, "gpt-4", { ignoreModelLocks: true })).toBe(false);
    expect(isModelLockActive({ "modelLock___all": future }, "gpt-4", { ignoreModelLocks: true })).toBe(true);
  });

  it("ignores per-model lock expiries when computing combo retry timing", () => {
    const modelExpiry = new Date(Date.now() + 30_000).toISOString();
    const allExpiry = new Date(Date.now() + 60_000).toISOString();
    const conn = { "modelLock_gpt-4": modelExpiry, "modelLock___all": allExpiry };
    expect(getEarliestModelLockUntil(conn)).toBe(modelExpiry);
    expect(getEarliestModelLockUntil(conn, { ignoreModelLocks: true })).toBe(allExpiry);
  });
});

describe("429 rate-limit neutrality", () => {
  it("429 keeps a fixed base cooldown without bumping the counter", () => {
    const conn = { "modelFailure_gpt-4": 3, "modelFailureAt_gpt-4": Date.now() };
    const r = buildModelFailureBackoffUpdate(conn, "gpt-4", { isRateLimit: true });
    expect(r.count).toBe(3);
    expect(r.cooldownMs).toBe(MODEL_FAILURE_BACKOFF_BASE_MS);
    expect(r.update).toEqual({});
  });

  it("consecutive 429s stay at 30s, never double", () => {
    let r = buildModelFailureBackoffUpdate({ "modelFailure_gpt-4": 1 }, "gpt-4", { isRateLimit: true });
    expect(r.cooldownMs).toBe(MODEL_FAILURE_BACKOFF_BASE_MS);
    r = buildModelFailureBackoffUpdate({ "modelFailure_gpt-4": 5 }, "gpt-4", { isRateLimit: true });
    expect(r.cooldownMs).toBe(MODEL_FAILURE_BACKOFF_BASE_MS);
    expect(r.count).toBe(5);
  });

  it("429 is neutral: does not reset an existing counter", () => {
    const r = buildModelFailureBackoffUpdate({ "modelFailure_gpt-4": 5 }, "gpt-4", { isRateLimit: true });
    expect(r.count).toBe(5);
  });

  it("a non-rate-limit failure after a 429 continues escalating from the existing count", () => {
    const conn = { "modelFailure_gpt-4": 3, "modelFailureAt_gpt-4": Date.now() };
    const r = buildModelFailureBackoffUpdate(conn, "gpt-4", { isRateLimit: false });
    expect(r.count).toBe(4);
    expect(r.cooldownMs).toBe(MODEL_FAILURE_BACKOFF_BASE_MS * 8);
  });
});

describe("provider self-heal errors", () => {
  it("does not fallback or lock for invalid client image_url payloads", () => {
    const errorText = "Invalid 'input[71].content[2].image_url'. Expected a valid URL, but got a value with an invalid format.";
    expect(isClientPayloadError(400, errorText)).toBe(true);
    expect(checkFallbackError(400, errorText)).toMatchObject({
      shouldFallback: false,
      cooldownMs: 0,
      clientError: true,
    });
  });

  it("classifies empty upstream stream as a short self-heal provider error", () => {
    const r = checkFallbackError(502, "Empty upstream stream (terminal before productive)");
    expect(r).toMatchObject({
      shouldFallback: true,
      cooldownMs: PROVIDER_SELF_HEAL_COOLDOWN_MS,
      selfHeal: true,
    });
    expect(isProviderSelfHealError(502, "Empty upstream stream (terminal before productive)")).toBe(true);
  });

  it("classifies context too large as a short self-heal provider error", () => {
    const errorText = "context_too_large: estimated 199070 input tokens exceed the 170000 hard cap";
    const r = checkFallbackError(400, errorText);
    expect(r).toMatchObject({
      shouldFallback: true,
      cooldownMs: PROVIDER_SELF_HEAL_COOLDOWN_MS,
      selfHeal: true,
    });
    expect(isProviderSelfHealError(400, errorText)).toBe(true);
  });

  it("classifies upstream context-window errors as short self-heal provider errors", () => {
    const errorText = "Upstream stream error: Your input exceeds the context window of this model. Please adjust your input and try again.";
    const r = checkFallbackError(400, errorText);
    expect(r).toMatchObject({
      shouldFallback: true,
      cooldownMs: PROVIDER_SELF_HEAL_COOLDOWN_MS,
      selfHeal: true,
    });
    expect(isProviderSelfHealError(400, errorText)).toBe(true);
  });

  it("classifies tools plus response_format conflicts as short self-heal provider errors", () => {
    const errorText = "Upstream stream error: tools and response_format cannot be combined. Pick one: use tools for function calling or response_format for structured output.";
    const r = checkFallbackError(400, errorText);
    expect(r).toMatchObject({
      shouldFallback: true,
      cooldownMs: PROVIDER_SELF_HEAL_COOLDOWN_MS,
      selfHeal: true,
    });
    expect(isProviderSelfHealError(400, errorText)).toBe(true);
  });

  it("classifies Cloudflare 530 HTML provider pages as short self-heal errors", () => {
    const errorText = "[530]: <!doctype html> <!--[if lt IE 7]> <html class=\"no-js ie6 oldie\" lang=\"en-US\">";
    const r = checkFallbackError(530, errorText);
    expect(r).toMatchObject({
      shouldFallback: true,
      cooldownMs: PROVIDER_SELF_HEAL_COOLDOWN_MS,
      selfHeal: true,
    });
    expect(isProviderSelfHealError(530, errorText)).toBe(true);
  });

  it("does not bump model failure counters for self-heal errors", () => {
    const conn = {
      "modelFailure_claude-opus-4-8": 4,
      "modelFailureAt_claude-opus-4-8": Date.now(),
    };
    const r = buildModelFailureBackoffUpdate(conn, "claude-opus-4-8", { selfHeal: true });
    expect(r.count).toBe(4);
    expect(r.cooldownMs).toBe(0);
    expect(r.update).toEqual({});
  });
});

describe("per-model failure counter time-decay", () => {
  it("resets to a fresh start after MODEL_FAILURE_IDLE_RESET_MS with no new failure", () => {
    const oldAt = Date.now() - (MODEL_FAILURE_IDLE_RESET_MS + 60000);
    const conn = { "modelFailure_gpt-4": 7, "modelFailureAt_gpt-4": oldAt };
    const r = buildModelFailureBackoffUpdate(conn, "gpt-4", { isRateLimit: false });
    expect(r.count).toBe(1);
    expect(r.cooldownMs).toBe(MODEL_FAILURE_BACKOFF_BASE_MS);
  });

  it("does not decay while still within the idle window", () => {
    const recentAt = Date.now() - 1000;
    const conn = { "modelFailure_gpt-4": 2, "modelFailureAt_gpt-4": recentAt };
    const r = buildModelFailureBackoffUpdate(conn, "gpt-4", { isRateLimit: false });
    expect(r.count).toBe(3);
  });

  it("idle reset window is larger than the max backoff cap", () => {
    expect(MODEL_FAILURE_IDLE_RESET_MS).toBeGreaterThan(MODEL_FAILURE_BACKOFF_MAX_MS);
  });
});

describe("isRateLimitError classification", () => {
  it("treats HTTP 429 as a rate-limit error", () => {
    expect(isRateLimitError(429, "")).toBe(true);
  });

  it("treats rate-limit text rules as rate-limit errors", () => {
    expect(isRateLimitError(503, "overloaded")).toBe(true);
    expect(isRateLimitError(503, "rate limit exceeded")).toBe(true);
    expect(isRateLimitError(429, "too many requests")).toBe(true);
  });

  it("does not classify server/auth errors as rate-limit", () => {
    expect(isRateLimitError(500, "internal error")).toBe(false);
    expect(isRateLimitError(502, "bad gateway")).toBe(false);
    expect(isRateLimitError(401, "invalid key")).toBe(false);
  });
});

describe("auto-disable billing errors", () => {
  it("disables 402 payment errors", () => {
    expect(shouldDisableConnectionForError(402, "Payment required")).toBe(true);
  });

  it("disables 403 credit exhaustion from Pay-as-you-go wallets", () => {
    const errorText = '{"error":{"message":"hết credit (ví Pay-as-you-go)"}}';
    expect(shouldDisableConnectionForError(403, errorText)).toBe(true);
  });

  it("does not disable unrelated 403 errors", () => {
    expect(shouldDisableConnectionForError(403, "request not allowed")).toBe(false);
  });
});


describe("cross-model lock escalation prevention", () => {
  function makeConn(model, count, kind, atMs) {
    const conn = {};
    if (model) {
      conn["comboPreflightFailureKind_" + model] = kind;
      conn["comboPreflightFailureCount_" + model] = count;
      conn["comboPreflightFailureAt_" + model] = new Date(atMs).toISOString();
    } else {
      conn.comboPreflightFailureKind = kind;
      conn.comboPreflightFailureCount = count;
      conn.comboPreflightFailureAt = new Date(atMs).toISOString();
    }
    return conn;
  }

  function getComboPreflightInfo(conn, model) {
    if (model) {
      return {
        kind: conn?.["comboPreflightFailureKind_" + model] ?? null,
        count: conn?.["comboPreflightFailureCount_" + model] ?? 0,
        at: conn?.["comboPreflightFailureAt_" + model] ?? null,
      };
    }
    return {
      kind: conn?.comboPreflightFailureKind ?? null,
      count: conn?.comboPreflightFailureCount ?? 0,
      at: conn?.comboPreflightFailureAt ?? null,
    };
  }

  function buildPreflightUpdate(model, kind, count, now) {
    const upd = {};
    if (model) {
      upd["comboPreflightFailureKind_" + model] = kind;
      upd["comboPreflightFailureCount_" + model] = count;
      upd["comboPreflightFailureAt_" + model] = new Date(now).toISOString();
    } else {
      upd.comboPreflightFailureKind = kind;
      upd.comboPreflightFailureCount = count;
      upd.comboPreflightFailureAt = new Date(now).toISOString();
    }
    return upd;
  }

  it("same model fails twice -> recentFailureCount=2 -> escalates", () => {
    const now = Date.now();
    const conn = makeConn("glm-5.1", 1, "preflight", now - 10000);

    const info = getComboPreflightInfo(conn, "glm-5.1");
    expect(info.count).toBe(1);
    expect(info.kind).toBe("preflight");

    const recentSameKind = info.at && (now - new Date(info.at).getTime() <= 60000);
    const recentFailureCount = recentSameKind ? info.count + 1 : 1;
    expect(recentFailureCount).toBe(2);

    expect(shouldLockConnectionForError({
      status: 502, errorText: "upstream headers timeout", recentFailureCount
    })).toBe(true);
  });

  it("different models each fail once -> not escalate", () => {
    const now = Date.now();
    const conn = makeConn("glm-5.1", 1, "preflight", now - 10000);
    Object.assign(conn, buildPreflightUpdate("glm-5.1", "preflight", 1, now - 10000));

    // glm-5.2 has no prior failures — should start at 1, not 2
    const info2 = getComboPreflightInfo(conn, "glm-5.2");
    expect(info2.count).toBe(0);
    expect(info2.kind).toBe(null);

    const recentSameKind2 = info2.at && (now - new Date(info2.at).getTime() <= 60000);
    const count2 = recentSameKind2 ? info2.count + 1 : 1;
    expect(count2).toBe(1);

    expect(shouldLockConnectionForError({
      status: 502, errorText: "upstream headers timeout", recentFailureCount: count2
    })).toBe(false);

    // glm-5.1 counter preserved
    expect(getComboPreflightInfo(conn, "glm-5.1").count).toBe(1);
  });

  it("null model falls back to connection-level fields", () => {
    const now = Date.now();
    const conn = makeConn(null, 2, "preflight", now - 10000);
    const info = getComboPreflightInfo(conn, null);
    expect(info.count).toBe(2);
    expect(shouldLockConnectionForError({
      status: 502, errorText: "upstream headers timeout", recentFailureCount: 2
    })).toBe(true);
  });

  it("clear per-model counter does not affect other models", () => {
    const conn = {
      "comboPreflightFailureCount_glm-5.1": 2,
      "comboPreflightFailureKind_glm-5.1": "preflight",
      "comboPreflightFailureAt_glm-5.1": new Date().toISOString(),
      "comboPreflightFailureCount_glm-5.2": 1,
      "comboPreflightFailureKind_glm-5.2": "preflight",
      "comboPreflightFailureAt_glm-5.2": new Date().toISOString(),
    };
    delete conn["comboPreflightFailureCount_glm-5.1"];
    delete conn["comboPreflightFailureKind_glm-5.1"];
    delete conn["comboPreflightFailureAt_glm-5.1"];
    expect(getComboPreflightInfo(conn, "glm-5.1").count).toBe(0);
    expect(getComboPreflightInfo(conn, "glm-5.2").count).toBe(1);
  });
});
