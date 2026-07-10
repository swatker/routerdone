const DEFAULT_THRESHOLD_TOKENS = 45000;
const MIN_THRESHOLD_TOKENS = 36000;
const MAX_THRESHOLD_TOKENS = Number.MAX_SAFE_INTEGER;

export function normalizeContextBackupConfig(config = {}) {
  const thresholdTokens = Number(config.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS);
  const retainRecentTurns = Number(config.retainRecentTurns ?? 3);
  if (!Number.isInteger(thresholdTokens) || thresholdTokens < MIN_THRESHOLD_TOKENS) {
    throw new Error(`thresholdTokens must be an integer >= ${MIN_THRESHOLD_TOKENS}`);
  }
  if (!Number.isInteger(retainRecentTurns) || retainRecentTurns < 1 || retainRecentTurns > 6) {
    throw new Error("retainRecentTurns must be an integer from 1 to 6");
  }
  return {
    enabled: config.enabled === true,
    thresholdTokens,
    retainRecentTurns,
    codexConnectionId: typeof config.codexConnectionId === "string" ? config.codexConnectionId : "",
  };
}

function textOnly(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((x) => x?.type === "text" || x?.type === "input_text" || x?.type === "output_text").map((x) => x.text || "").join("\n");
  return "";
}

export function isContextBackupEligible(body, { isResponses = false } = {}) {
  if (!isResponses || !body || body._compact || !Array.isArray(body.input)) return false;
  if (body.tools?.length || body.tool_choice || body.parallel_tool_calls || body.include) return false;
  return body.input.every((item) => {
    if (!(item?.type === "message" && typeof item.role === "string" && ["user", "assistant", "system"].includes(item.role))) return false;
    if (typeof item.content === "string") return true;
    return Array.isArray(item.content) && item.content.every((part) => part && ["text", "input_text", "output_text"].includes(part.type) && typeof part.text === "string");
  });
}

export function buildContextSummaryBackup(body, { retainRecentTurns = 3 } = {}) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const keep = Math.max(1, retainRecentTurns) * 2;
  if (input.length <= keep) return null;
  const older = input.slice(0, -keep);
  const recent = input.slice(-keep);
  const lines = older.map((item) => `${item.role}: ${textOnly(item.content).replace(/\s+/g, " ").trim()}`).filter((x) => x.replace(/^[^:]+:\s*/, "").trim());
  if (!lines.length) return null;
  const summary = `[RouterDone Context Summary Backup]\n${lines.join("\n")}`;
  return { ...body, input: [{ type: "message", role: "system", content: [{ type: "input_text", text: summary }] }, ...recent] };
}

export const CONTEXT_BACKUP_LIMITS = {
  DEFAULT_THRESHOLD_TOKENS,
  MIN_THRESHOLD_TOKENS,
  MAX_THRESHOLD_TOKENS,
  default: DEFAULT_THRESHOLD_TOKENS,
  min: MIN_THRESHOLD_TOKENS,
  max: MAX_THRESHOLD_TOKENS,
};
