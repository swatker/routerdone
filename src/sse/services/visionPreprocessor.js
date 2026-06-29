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
 *  - Runs once per request, at the handleChat level (before combo dispatch)
 *  - Makes a direct upstream call to the vision model (noAuth provider)
 *  - Prefetches remote image URLs to base64 (vision model needs inline data)
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
 * Fetch a remote image URL and convert to base64 data URI.
 * @param {string} url - Remote image URL or data URI
 * @returns {Promise<string|null>} data URI string or null on failure
 */
async function fetchImageAsBase64(url) {
  // Already a data URI
  if (url.startsWith("data:")) return url;

  // Only fetch http/https URLs
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "RouterDone/1.0" },
    });
    clearTimeout(timeout);

    if (!response.ok) { console.log("[VISION] Fetch failed: " + response.status + " for " + url.slice(0, 80)); return null; }

    const contentType = response.headers.get("content-type") || "";
    const buffer = await response.arrayBuffer();

    // Detect mime type
    let mime = contentType.split(";")[0].trim();
    if (!mime || !mime.startsWith("image/")) {
      // Guess from URL extension
      if (url.match(/\.jpe?g$/i)) mime = "image/jpeg";
      else if (url.match(/\.png$/i)) mime = "image/png";
      else if (url.match(/\.gif$/i)) mime = "image/gif";
      else if (url.match(/\.webp$/i)) mime = "image/webp";
      else mime = "image/png"; // default
    }

    const base64 = Buffer.from(buffer).toString("base64");
    return "data:" + mime + ";base64," + base64;
  } catch (fetchErr) {
    console.log("[VISION] Fetch error for " + url.slice(0, 80) + ": " + fetchErr.message);
    return null;
  }
}

/**
 * Build a vision-only request body extracting images from ALL user messages.
 * Prefetches remote image URLs to base64 (vision model needs inline data).
 * @param {object} body - Original request body
 * @param {Function} log - Logger
 * @returns {Promise<object|null>}
 */
async function buildVisionRequestBody(body, log) {
  const messages = body.messages || [];
  if (!messages.length) return null;

  // Collect ALL images from ALL user messages
  const allImageBlocks = [];
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "image_url") {
        const url = typeof block.image_url === "string"
          ? block.image_url
          : block.image_url?.url;
        if (url) {
          // Prefetch remote URL to base64
          if (url.startsWith("http://") || url.startsWith("https://")) {
            log?.info?.("VISION", "Prefetching remote image: " + url.slice(0, 80));
            const base64Url = await fetchImageAsBase64(url);
            if (base64Url) {
              allImageBlocks.push({ type: "image_url", image_url: { url: base64Url } });
            } else {
              log?.warn?.("VISION", "Failed to prefetch image: " + url.slice(0, 80));
            }
          } else {
            // Already base64 data URI — use as-is
            allImageBlocks.push({ type: "image_url", image_url: { url } });
          }
        }
      } else if (block?.type === "image") {
        const src = block.source;
        if (src?.type === "base64" && src?.media_type && src?.data) {
          allImageBlocks.push({
            type: "image_url",
            image_url: { url: "data:" + src.media_type + ";base64," + src.data },
          });
        } else if (src?.type === "url" && src?.url) {
          // Prefetch Claude URL format
          const base64Url = await fetchImageAsBase64(src.url);
          if (base64Url) {
            allImageBlocks.push({ type: "image_url", image_url: { url: base64Url } });
          }
        }
      }
    }
  }

  if (!allImageBlocks.length) return null;

  return {
    stream: false,
    model: "", // caller fills this
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_INSTRUCTION },
          ...allImageBlocks,
        ],
      },
    ],
  };
}

/**
 * Replace all image blocks in the request body with vision context text.
 * Keeps original text blocks intact and appends the vision context.
 * Mutates body in-place for combo compatibility.
 * @param {object} body - Request body
 * @param {string} visionText - Text from vision model
 * @returns {object} Modified body (same reference, mutated in-place)
 */
function injectVisionContext(body, visionText) {
  if (!body?.messages) return body;

  const contextTag =
    "[Vision context from image:\n" + visionText + "\n]";

  for (let mi = 0; mi < body.messages.length; mi++) {
    const msg = body.messages[mi];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    const hasImages = msg.content.some(
      (b) => b?.type === "image_url" || b?.type === "image"
    );
    if (!hasImages) continue;

    // Keep original text blocks, drop image blocks
    const filtered = msg.content.filter(
      (b) => b?.type !== "image_url" && b?.type !== "image"
    );
    // Trim empty text blocks
    const trimmed = filtered.filter(
      (b) => !(b?.type === "text" && !b.text?.trim())
    );

    trimmed.push({ type: "text", text: contextTag });
    body.messages[mi] = { ...msg, content: trimmed };
  }

  return body;
}

/**
 * Core: preprocess vision content if the body has images.
 *
 * @param {object}   body     - Original request body (mutated in-place)
 * @param {object}   settings - App settings (may have visionPreprocessingModel)
 * @param {Function} log      - Logger with .info / .warn / .debug
 * @returns {Promise<object|null>} Modified body with images replaced by text, or null
 */
export async function preprocessVisionContent(body, settings, log) {
  if (!hasImageContent(body)) {
    return null;
  }

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

  log?.info?.("VISION", "Resolved provider: " + provider + " model: " + model);

  // Build the vision-only request body (with remote URL prefetch to base64)
  const visionBody = await buildVisionRequestBody(body, log);
  if (!visionBody) {
    log?.warn?.("VISION", "buildVisionRequestBody returned null (no valid images)");
    return null;
  }
  visionBody.model = model;

  log?.info?.("VISION", "Built vision body with " + visionBody.messages[0].content.length + " content blocks");

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

  log?.info?.("VISION", "Calling " + url + " with model " + model);

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

    log?.info?.("VISION", "Vision model response: " + response.status);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.log("[VISION] Error response: " + errText.slice(0, 500));
      return null;
    }

    const data = await response.json();

    // Extract text (OpenAI format assumed)
    const visionText = data?.choices?.[0]?.message?.content;

    if (!visionText || !visionText.trim()) {
      console.log("[VISION] Empty content. Full response: " + JSON.stringify(data).slice(0, 500));
      return null;
    }

    log?.info?.("VISION", "Got " + visionText.length + " chars from vision model");
    const result = injectVisionContext(body, visionText);
    log?.info?.("VISION", "Images replaced with text context in body");
    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      log?.warn?.("VISION", "Request timed out after " + VISION_TIMEOUT_MS + "ms");
    } else {
      console.log("[VISION] Fetch error: " + error.message);
    }
    return null;
  }
}
