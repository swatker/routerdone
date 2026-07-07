import { countTextTokens } from "open-sse/utils/tokenEstimate.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

function collectScalarText(value, parts, seen) {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    parts.push(String(value));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectScalarText(item, parts, seen);
    return;
  }
  for (const child of Object.values(value)) collectScalarText(child, parts, seen);
}

function valueToText(value) {
  if (typeof value === "string") return value;
  const parts = [];
  collectScalarText(value, parts, new WeakSet());
  return parts.join("\n");
}

function anthropicCountTokensText(body) {
  if (!body || typeof body !== "object") return valueToText(body);
  const parts = [];
  if (body.system !== undefined) parts.push(valueToText(body.system));
  if (body.tools !== undefined) parts.push(valueToText(body.tools));
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg || typeof msg !== "object") parts.push(valueToText(msg));
    else if (msg.content !== undefined) parts.push(valueToText(msg.content));
  }
  return parts.filter(Boolean).join("\n");
}

/**
 * POST /v1/messages/count_tokens - Token count response
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  const result = countTextTokens(anthropicCountTokensText(body), body?.model);
  const payload = {
    input_tokens: result.count,
    mode: result.mode,
    tokenizer: result.tokenizer,
  };
  if (result.confidence !== undefined) payload.confidence = result.confidence;

  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}
