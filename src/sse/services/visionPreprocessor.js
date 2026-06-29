/**
 * Vision Preprocessor Service
 *
 * Detects image content in chat requests and preprocesses it through
 * a vision-capable model (e.g. oc/mimo-v2.5-free) BEFORE the chat body
 * reaches a non-vision model. The vision model extracts OCR + brief
 * visual context as text, which replaces the image blocks so the
 * downstream model can understand the image without vision support.
 *
 * Key design:
 *  - Runs once per request, at the handleSingleModelChat level
 *  - Makes a direct upstream call to the vision model (noAuth provider)
 *  - Non-fatal: if vision call fails, original body passes through
 *    and the normal modality-stripping in chatCore handles images
 *  - Vision model NEVER answers user questions — only reads images
 */

import { PROVIDERS } from "open-sse/config/providers.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { getExecutor } from "open-sse/executors/index.js";

// Config — override via settings.visionPreprocessingModel
const VISION_MODEL_DEFAULT = "oc/mimo-v2.5-free";
const VISION_TIMEOUT_MS = 30000;

const VISION_INSTRUCTION = [
  "Ban la cong cu doc anh. Hay doc anh duoi day va cung cap:",
  "1) OCR: Trich xuat toan bo van ban trong anh",
  "2) Mo ta ngan gon: Noi dung chinh cua anh la gi?",
  "",
  "QUAN TRONG: Chi doc anh. KHONG tra loi cau hoi. KHONG phan tich hay binh luan.",
].join("\n");

/**
 * Check if request body contains image content (OpenAI chat format).
 * @param {object} body - Request body with messages[]
 * @returns {boolean}
 */
export function hasImageContent(body) {
  if (!body?.messages) return false;
  for (const msg of body.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "image_url" || block?.type === "image") return true;
    }
  }
  return false;
}

/**
 * Build a vision-only request body extracting images from the last user message.
 * Returns { stream:false, messages:[...] } or null if no images found.
 * @param {object} body - Original request body
 * @returns {object|null}
 */
function buildVisionRequestBody(body) {
  const messages = body.messages || [];
  if (!messages.length) return null;

  // Find last user message with image content
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const c = messages[i].content;
    if (!Array.isArray(c)) continue;
    if (c.some((b) => b?.type === "image_url" || b?.type === "image")) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return null;

  const lastMsg = messages[lastUserIdx];
  const imageBlocks = lastMsg.content.filter(
    (b) => b?.type === "image_url" || b?.type === "image"
  );
  if (!imageBlocks.length) return null;

  // Normalize image blocks to OpenAI image_url format
  const normalizedImages = imageBlocks.map((b) => {
    if (b.type === "image") {
      // Claude format: { type:"image", source:{ type:"base64", media_type, data } }
      const src = b.source;
      if (src?.type === "base64" && src?.media_type && src?.data) {
        return {
          type: "image_url",
          image_url: { url: "data:" + src.media_type + ";base64," + src.data },
        };
      }
      if (src?.type === "url" && src?.url) {
        return { type: "image_url", image_url: { url: src.url } };
      }
    }
    // OpenAI format: { type:"image_url", image_url:{ url:"..." } }
    return { type: "image_url", image_url: b.image_url || b };
  });

  return {
    stream: false,
    model: "", // caller fills this
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_INSTRUCTION },
          ...normalizedImages,
        ],
      },
    ],
  };
}

/**
 * Replace all image blocks in the request body with vision context text.
 * Keeps original text blocks intact and appends the vision context.
 * @param {object} body - Original request body
 * @param {string} visionText - Text from vision model
 * @returns {object} Modified body
 */
function injectVisionContext(body, visionText) {
  if (!body?.messages) return body;

  const contextTag =
    "[Vision context from image:\n" + visionText + "\n]";

  const newMessages = body.messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;

    const hasImages = msg.content.some(
      (b) => b?.type === "image_url" || b?.type === "image"
    );
    if (!hasImages) return msg;

    // Keep original text blocks, drop image blocks
    const filtered = msg.content.filter(
      (b) => b?.type !== "image_url" && b?.type !== "image"
    );
    // Trim empty text blocks
    const trimmed = filtered.filter(
      (b) => !(b?.type === "text" && !b.text?.trim())
    );

    trimmed.push({ type: "text", text: contextTag });
    return { ...msg, content: trimmed };
  });

  return { ...body, messages: newMessages };
}

/**
 * Core: preprocess vision content if the body has images.
 *
 * @param {object}   body     - Original request body (not mutated)
 * @param {object}   settings - App settings (may have visionPreprocessingModel)
 * @param {Function} log      - Logger with .info / .warn / .debug
 * @returns {Promise<object|null>} Modified body with images replaced by text, or null
 */
export async function preprocessVisionContent(body, settings, log) {
  if (!hasImageContent(body)) return null;

  // Resolve vision model string
  const visionModel =
    settings?.visionPreprocessingModel || VISION_MODEL_DEFAULT;
  const slashIdx = visionModel.indexOf("/");
  if (slashIdx === -1) {
    log?.warn?.("VISION", "Invalid vision model string: " + visionModel);
    return null;
  }

  const providerAlias = visionModel.slice(0, slashIdx);
  const model = visionModel.slice(slashIdx + 1);
  const provider = resolveProviderAlias(providerAlias);

  // Build the vision-only request body
  const visionBody = buildVisionRequestBody(body);
  if (!visionBody) return null;
  visionBody.model = model;

  // Build upstream URL and headers via the provider's executor
  const executor = getExecutor(provider);

  let url;
  try {
    url = executor.buildUrl(model, false);
  } catch (_e1) {
    // Fallback: construct from provider config
    const cfg = PROVIDERS[provider];
    const base = cfg?.transport?.baseUrl || cfg?.baseUrl;
    if (!base) {
      log?.warn?.("VISION", "No base URL for provider " + provider);
      return null;
    }
    const clean = base.endsWith("/") ? base.slice(0, -1) : base;
    url = clean + "/zen/v1/chat/completions";
  }

  let headers;
  try {
    headers = executor.buildHeaders({}, false);
    // Override Accept for non-streaming
    headers["Accept"] = "application/json";
  } catch (_e2) {
    headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer public",
    };
  }

  log?.info?.("VISION", "Preprocessing images via " + visionModel);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(visionBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      log?.warn?.(
        "VISION",
        "Request failed: " + response.status + " " + errText.slice(0, 200)
      );
      return null;
    }

    const data = await response.json();
    // Extract text (OpenAI format assumed)
    const visionText = data?.choices?.[0]?.message?.content;

    if (!visionText || !visionText.trim()) {
      log?.warn?.("VISION", "Empty response from vision model");
      return null;
    }

    log?.info?.("VISION", "Got " + visionText.length + " chars from vision model");
    return injectVisionContext(body, visionText);
  } catch (error) {
    if (error.name === "AbortError") {
      log?.warn?.("VISION", "Request timed out after " + VISION_TIMEOUT_MS + "ms");
    } else {
      log?.warn?.("VISION", "Error: " + error.message);
    }
    return null;
  }
}
