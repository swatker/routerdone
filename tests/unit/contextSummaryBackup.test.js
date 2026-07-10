import { describe, expect, it } from "vitest";
import { buildContextSummaryBackup, isContextBackupEligible, normalizeContextBackupConfig, CONTEXT_BACKUP_LIMITS } from "../../src/sse/services/contextSummaryBackup.js";

describe("RouterDone Context Summary Backup", () => {
  it("validates minimum threshold and retain range", () => {
    expect(CONTEXT_BACKUP_LIMITS.MIN_THRESHOLD_TOKENS).toBe(36000);
    expect(normalizeContextBackupConfig({ thresholdTokens: Number.MAX_SAFE_INTEGER }).thresholdTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeContextBackupConfig({ thresholdTokens: 9000000000000 }).thresholdTokens).toBe(9000000000000);
    expect(() => normalizeContextBackupConfig({ thresholdTokens: 35999 })).toThrow();
    expect(normalizeContextBackupConfig({ thresholdTokens: 36000, retainRecentTurns: 6 }).thresholdTokens).toBe(36000);
    expect(() => normalizeContextBackupConfig({ retainRecentTurns: 7 })).toThrow();
  });
  it("rejects non-text/tool Responses input", () => {
    expect(isContextBackupEligible({ input: [{ type: "message", role: "user", content: [{ type: "input_image" }] }] }, { isResponses: true })).toBe(false);
    expect(isContextBackupEligible({ input: [{ type: "message", role: "user", content: "x" }], tools: [{}] }, { isResponses: true })).toBe(false);
  });
  it("does not fabricate a summary for empty content", () => {
    const body = { input: Array.from({ length: 8 }, (_, i) => ({ type: "message", role: "user", content: "" })) };
    expect(buildContextSummaryBackup(body, { retainRecentTurns: 2 })).toBeNull();
  });
  it("keeps recent turns and prepends factual summary", () => {
    const body = { model: "x", input: Array.from({ length: 8 }, (_, i) => ({ type: "message", role: i % 2 ? "assistant" : "user", content: `turn ${i}` })) };
    const result = buildContextSummaryBackup(body, { retainRecentTurns: 2 });
    expect(result.input).toHaveLength(5);
    expect(result.input[0].role).toBe("system");
    expect(result.input.at(-1).content).toBe("turn 7");
  });
});
