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
 *  - Only processes images from the LAST user message (new images)
 *  - Images in older messages are stripped without calling vision model
 *  - Uses self-loopback /api/v1/chat/completions for robust routing
 *  - Non-fatal: if vision call fails, original body passes through
 *    and the normal modality-stripping in chatCore handles images
 *  - Vision model NEVER answers user questions -- only reads images
 */

const VISION_MODEL_DEFAULT = "oc/mimo-v2.5-free";
const VISION_TIMEOUT_MS = 30000;

const VISION_INSTRUCTION = [
  "Ban la cong cu doc anh. Hay doc anh duoi day va cung cap:",
  "1) OCR: Trich xuat toan bo van ban trong anh",
  "2) Mo ta ngan gon: Noi dung chinh cua anh la gi?",
  "",
  "QUAN TRONG: Chi doc anh. KHONG tra loi cau hoi. KHONG phan tich hay binh luan.",
].join("\n");

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

async function buildVisionRequest(msg, log) {
  const imageBlocks = await extractImagesFromMessage(msg, log);
  if (!imageBlocks.length) return null;
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

function stripImagesFromMessage(msg, placeholder) {
  if (!Array.isArray(msg.content)) return msg;
  const filtered = msg.content.filter(b => b?.type !== "image_url" && b?.type !== "image");
  const trimmed = filtered.filter(b => !(b?.type === "text" && !b.text?.trim()));
  if (placeholder) {
    trimmed.push({ type: "text", text: placeholder });
  }
  return { ...msg, content: trimmed };
}

export async function preprocessVisionContent(body, settings, log) {
  if (!hasImageContent(body)) return null;

  if (settings?.visionPreprocessingEnabled === false) {
    log?.info?.("VISION", "Vision preprocessing disabled by settings");
    return null;
  }

  const visionModel = settings?.visionPreprocessingModel || VISION_MODEL_DEFAULT;
  if (!visionModel.includes("/")) {
    log?.warn?.("VISION", "Invalid vision model string: " + visionModel);
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

  const visionBody = await buildVisionRequest(lastMsg, log);
  if (!visionBody) {
    log?.warn?.("VISION", "No valid images to preprocess");
    return null;
  }
  visionBody.model = visionModel.split("/").slice(1).join("/");

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
    const visionText = data?.choices?.[0]?.message?.content;

    if (!visionText || !visionText.trim()) {
      console.log("[VISION] Empty content. Response: " + JSON.stringify(data).slice(0, 500));
      messages[lastUserIdx] = stripImagesFromMessage(lastMsg, "[Image -- vision model returned empty]");
      return body;
    }

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
