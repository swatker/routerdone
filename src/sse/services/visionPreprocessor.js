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
 *  - Skips when the target model already supports vision (targetCaps.vision),
 *    including combos whose every member is vision-capable (resolveTargetCaps)
 *  - Only processes images from the LAST user message (new images)
 *  - Images in older messages are stripped without calling vision model
 *  - Uses self-loopback /api/v1/chat/completions for robust routing
 *  - Non-fatal: if vision call fails, original body passes through
 *    and the normal modality-stripping in chatCore handles images
 *  - Vision model NEVER answers user questions -- only reads images
 *  - Reads `content` first, falls back to `reasoning_content` (reasoning
 *    vision models can exhaust output budget and leave content empty)
 */

import { createHash } from "node:crypto";

const VISION_MODEL_DEFAULT = "oc/mimo-v2.5-free";
const VISION_TIMEOUT_MS = 30000;
const VISION_INSTRUCTION_VERSION = "v1";
const VISION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const VISION_CACHE_MAX_ENTRIES = 500;

const VISION_INSTRUCTION = [
  "Ban la cong cu doc anh. Hay doc anh duoi day va cung cap:",
  "1) OCR: Trich xuat toan bo van ban trong anh",
  "2) Mo ta ngan gon: Noi dung chinh cua anh la gi?",
  "",
  "QUAN TRONG: Chi doc anh. KHONG tra loi cau hoi. KHONG phan tich hay binh luan.",
].join("\n");

// ── In-memory vision description cache ──────────────────────────────────────────
const visionDescriptionCache = new Map();
const visionDescriptionCacheStats = { hits: 0, misses: 0, sets: 0, evictions: 0 };

function nowMs() { return Date.now(); }

function pruneExpiredVisionCache(now = nowMs()) {
  for (const [key, entry] of visionDescriptionCache) {
    if (!entry || entry.expiresAt <= now) {
      visionDescriptionCache.delete(key);
      visionDescriptionCacheStats.evictions += 1;
    }
  }
}

function enforceVisionCacheLimit() {
  while (visionDescriptionCache.size > VISION_CACHE_MAX_ENTRIES) {
    const oldestKey = visionDescriptionCache.keys().next().value;
    if (!oldestKey) return;
    visionDescriptionCache.delete(oldestKey);
    visionDescriptionCacheStats.evictions += 1;
  }
}

export function clearVisionDescriptionCache() {
  visionDescriptionCache.clear();
  visionDescriptionCacheStats.hits = 0;
  visionDescriptionCacheStats.misses = 0;
  visionDescriptionCacheStats.sets = 0;
  visionDescriptionCacheStats.evictions = 0;
}

export function getVisionDescriptionCacheStats() {
  pruneExpiredVisionCache();
  return {
    size: visionDescriptionCache.size,
    hits: visionDescriptionCacheStats.hits,
    misses: visionDescriptionCacheStats.misses,
    sets: visionDescriptionCacheStats.sets,
    evictions: visionDescriptionCacheStats.evictions,
    ttlMs: VISION_CACHE_TTL_MS,
    maxEntries: VISION_CACHE_MAX_ENTRIES,
  };
}

// ── Image hashing and cache key helpers ─────────────────────────────────────────

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function imageUrlFromBlock(block) {
  if (block?.type !== "image_url") return null;
  return typeof block.image_url === "string" ? block.image_url : block.image_url?.url || null;
}

function hashImageUrl(url) {
  if (!url || typeof url !== "string") return null;
  const dataMatch = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (dataMatch) {
    const mime = (dataMatch[1] || "application/octet-stream").toLowerCase();
    const isBase64 = !!dataMatch[2];
    const payload = dataMatch[3] || "";
    const bytes = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    return mime + ":" + sha256Hex(bytes);
  }
  return "url:" + sha256Hex(url);
}

function buildVisionCacheKey(visionModel, imageBlocks) {
  const imageHashes = [];
  for (const block of imageBlocks || []) {
    const url = imageUrlFromBlock(block);
    const hash = hashImageUrl(url);
    if (!hash) return null;
    imageHashes.push(hash);
  }
  if (imageHashes.length === 0) return null;
  return [
    "vision-description",
    VISION_INSTRUCTION_VERSION,
    visionModel || VISION_MODEL_DEFAULT,
    ...imageHashes,
  ].join("|");
}

function getCachedVisionDescription(cacheKey) {
  if (!cacheKey) return null;
  pruneExpiredVisionCache();
  const entry = visionDescriptionCache.get(cacheKey);
  if (!entry) {
    visionDescriptionCacheStats.misses += 1;
    return null;
  }
  // LRU: re-insert at end
  visionDescriptionCache.delete(cacheKey);
  visionDescriptionCache.set(cacheKey, entry);
  visionDescriptionCacheStats.hits += 1;
  return entry.text;
}

function setCachedVisionDescription(cacheKey, text) {
  if (!cacheKey || !text || !text.trim()) return;
  visionDescriptionCache.set(cacheKey, {
    text,
    createdAt: nowMs(),
    expiresAt: nowMs() + VISION_CACHE_TTL_MS,
  });
  visionDescriptionCacheStats.sets += 1;
  enforceVisionCacheLimit();
}

// ── Core functions ──────────────────────────────────────────────────────────────

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

async function fetchImageAsBase64(url) {
  if (url.startsWith("data:")) return url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "RouterDone/1.0" },
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.log("[VISION] Fetch failed: " + response.status + " for " + url.slice(0, 80));
      return null;
    }
    const contentType = response.headers.get("content-type") || "";
    const buffer = await response.arrayBuffer();
    let mime = contentType.split(";")[0].trim();
    if (!mime || !mime.startsWith("image/")) {
      if (url.match(/\.jpe?g$/i)) mime = "image/jpeg";
      else if (url.match(/\.png$/i)) mime = "image/png";
      else if (url.match(/\.gif$/i)) mime = "image/gif";
      else if (url.match(/\.webp$/i)) mime = "image/webp";
      else mime = "image/png";
    }
    const base64 = Buffer.from(buffer).toString("base64");
    return "data:" + mime + ";base64," + base64;
  } catch (fetchErr) {
    console.log("[VISION] Fetch error for " + url.slice(0, 80) + ": " + fetchErr.message);
    return null;
  }
}

async function extractImagesFromMessage(msg, log) {
  const imageBlocks = [];
  if (!Array.isArray(msg.content)) return imageBlocks;
  for (const block of msg.content) {
    if (block?.type === "image_url") {
      const url = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
      if (!url) continue;
      if (url.startsWith("http://") || url.startsWith("https://")) {
        log?.info?.("VISION", "Prefetching remote image: " + url.slice(0, 80));
        const base64Url = await fetchImageAsBase64(url);
        if (base64Url) {
          imageBlocks.push({ type: "image_url", image_url: { url: base64Url } });
        } else {
          log?.warn?.("VISION", "Failed to prefetch image: " + url.slice(0, 80));
        }
      } else {
        imageBlocks.push({ type: "image_url", image_url: { url } });
      }
    } else if (block?.type === "image") {
      const src = block.source;
      if (src?.type === "base64" && src?.media_type && src?.data) {
        imageBlocks.push({ type: "image_url", image_url: { url: "data:" + src.media_type + ";base64," + src.data } });
      } else if (src?.type === "url" && src?.url) {
        const base64Url = await fetchImageAsBase64(src.url);
        if (base64Url) {
          imageBlocks.push({ type: "image_url", image_url: { url: base64Url } });
        }
      }
    }
  }
  return imageBlocks;
}

function buildVisionRequestFromImages(imageBlocks) {
  if (!imageBlocks?.length) return null;
  return {
    stream: false,
    model: "",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: VISION_INSTRUCTION },
        ...imageBlocks,
      ],
    }],
  };
}

// Extract the vision model's textual description from its chat completion
// response. Prefer `content`; fall back to `reasoning_content` because some
// reasoning-capable vision models (e.g. mimo-v2.5-free) can exhaust their
// output budget on reasoning and leave `content` empty, in which case the
// reasoning trace still carries the image description.
export function extractVisionText(data) {
  const msg = data?.choices?.[0]?.message;
  if (!msg) return null;
  const content = typeof msg.content === "string" ? msg.content : null;
  const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : null;
  return content || reasoning || null;
}

// Resolve the *target* model's vision capability for a model string that may be
// either a direct `provider/model` or a combo name. Returns `{ vision: true }`
// only when EVERY model the request can route to already supports vision
// natively — in that case preprocessing would only downgrade quality (replace a
// raw image with a text description). Returns null otherwise (mixed / non-vision
// / unknown) so preprocessing runs and gives non-vision fallback members usable
// text context instead of a raw image they cannot read.
//
// `deps` is injected so this stays unit-testable without a DB:
//   { getModelInfo, getComboModels, getCapabilitiesForModel }
export async function resolveTargetCaps(modelStr, deps) {
  const { getModelInfo, getComboModels, getCapabilitiesForModel } = deps;

  // Direct provider/model — resolve caps straight away.
  const info = await getModelInfo(modelStr);
  if (info?.provider) {
    return getCapabilitiesForModel(info.provider, info.model);
  }

  // Combo — skip preprocessing only if ALL members are vision-capable.
  // If any member lacks vision, preprocessing must run so that member still
  // receives a text description instead of being fed a raw image it can't read.
  const members = await getComboModels(modelStr);
  if (!members || members.length === 0) return null;

  for (const m of members) {
    const mInfo = await getModelInfo(m);
    if (!mInfo?.provider) {
      // Nested combo / unknown member — be safe, don't skip.
      return null;
    }
    const caps = getCapabilitiesForModel(mInfo.provider, mInfo.model);
    if (caps?.vision !== true) {
      return null;
    }
  }
  return { vision: true };
}

function stripImagesFromMessage(msg, placeholder) {
  if (!Array.isArray(msg.content)) return msg;
  const filtered = msg.content.filter(b => b?.type !== "image_url" && b?.type !== "image");
  const trimmed = filtered.filter(b => !(b?.type === "text" && !b.text?.trim()));
  if (placeholder) {
    trimmed.push({ type: "text", text: placeholder });
  }
  return { ...msg, content: trimmed };
}

export async function preprocessVisionContent(body, settings, log, targetCaps) {
  if (!hasImageContent(body)) return null;

  // Skip if the *target* model already supports vision natively — preprocessing
  // would only downgrade quality (replace a raw image with a text description).
  // targetCaps is resolved by the caller (chat.js) via getCapabilitiesForModel.
  if (targetCaps?.vision === true) {
    log?.info?.("VISION", "Target model has vision capability, skipping preprocessing");
    return null;
  }

  // Prevent infinite loop: skip if this is already a vision loopback request
  if (body._skipVision) {
    return null;
  }

  if (settings?.visionPreprocessingEnabled === false) {
    log?.info?.("VISION", "Vision preprocessing disabled by settings");
    return null;
  }

  const visionModel = settings?.visionPreprocessingModel || VISION_MODEL_DEFAULT;
  if (!visionModel.includes("/")) {
    log?.warn?.("VISION", "Invalid vision model string: " + visionModel);
    return null;
  }

  // Skip if target model IS the vision model (it can handle images natively)
  const visionModelId = visionModel.split("/").slice(1).join("/");
  if (body.model === visionModel || body.model === visionModelId) {
    log?.info?.("VISION", "Target model is vision model, skipping preprocessing");
    return null;
  }

  const messages = body.messages || [];

  // Find the LAST user message index
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) {
    log?.warn?.("VISION", "No user message found");
    return null;
  }

  // Strip images from ALL older messages (no vision call needed)
  let strippedCount = 0;
  for (let mi = 0; mi < messages.length; mi++) {
    if (mi === lastUserIdx) continue;
    const msg = messages[mi];
    if (!Array.isArray(msg.content)) continue;
    const hasImgs = msg.content.some(b => b?.type === "image_url" || b?.type === "image");
    if (hasImgs) {
      messages[mi] = stripImagesFromMessage(msg);
      strippedCount++;
    }
  }
  if (strippedCount > 0) {
    log?.info?.("VISION", "Stripped images from " + strippedCount + " older message(s)");
  }

  // Process images in the LAST user message only
  const lastMsg = messages[lastUserIdx];
  const lastMsgImages = lastMsg.content?.filter(b => b?.type === "image_url" || b?.type === "image") || [];

  if (lastMsgImages.length === 0) {
    return strippedCount > 0 ? body : null;
  }

  log?.info?.("VISION", "Processing " + lastMsgImages.length + " image(s) in last user message");

  // Extract image blocks and build cache key
  const imageBlocks = await extractImagesFromMessage(lastMsg, log);
  if (!imageBlocks.length) {
    log?.warn?.("VISION", "No valid images to preprocess");
    return null;
  }

  const cacheKey = buildVisionCacheKey(visionModel, imageBlocks);
  const cachedVisionText = getCachedVisionDescription(cacheKey);
  if (cachedVisionText) {
    messages[lastUserIdx] = stripImagesFromMessage(lastMsg, "[Image description: " + cachedVisionText + "]");
    log?.info?.("VISION", "Using cached image description (" + cachedVisionText.length + " chars)");
    return body;
  }

  const visionBody = buildVisionRequestFromImages(imageBlocks);
  if (!visionBody) {
    log?.warn?.("VISION", "No valid images to preprocess");
    return null;
  }
  visionBody.model = visionModel;

  // Mark request to prevent infinite vision loopback recursion
  visionBody._skipVision = true;

  // Call vision model via self-loopback
  const port = process.env.PORT || 20128;
  const apiUrl = "http://127.0.0.1:" + port + "/api/v1/chat/completions";
  log?.info?.("VISION", "Calling vision model " + visionModel + " via self-loopback");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(visionBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    log?.info?.("VISION", "Vision model response: " + response.status);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.log("[VISION] Error response: " + errText.slice(0, 500));
      messages[lastUserIdx] = stripImagesFromMessage(lastMsg, "[Image -- vision model failed to describe]");
      return body;
    }

    const data = await response.json();
    const visionText = extractVisionText(data);

    if (!visionText || !visionText.trim()) {
      console.log("[VISION] Empty content. Response: " + JSON.stringify(data).slice(0, 500));
      messages[lastUserIdx] = stripImagesFromMessage(lastMsg, "[Image -- vision model returned empty]");
      return body;
    }

    setCachedVisionDescription(cacheKey, visionText);
    log?.info?.("VISION", "Got " + visionText.length + " chars from vision model");
    messages[lastUserIdx] = stripImagesFromMessage(lastMsg, "[Image description: " + visionText + "]");
    log?.info?.("VISION", "Images replaced with description in last message");
    return body;

  } catch (error) {
    if (error.name === "AbortError") {
      log?.warn?.("VISION", "Request timed out after " + VISION_TIMEOUT_MS + "ms");
    } else {
      console.log("[VISION] Fetch error: " + error.message);
    }
    messages[lastUserIdx] = stripImagesFromMessage(lastMsg, "[Image -- vision preprocessing error]");
    return body;
  }
}
