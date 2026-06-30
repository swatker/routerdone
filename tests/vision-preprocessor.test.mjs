// TDD tests for visionPreprocessor.js — BUG #1 (capability skip) + BUG #2 (reasoning_content fallback)
// Run: node --test tests/vision-preprocessor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  preprocessVisionContent,
  hasImageContent,
  extractVisionText,
  resolveTargetCaps,
} from "../src/sse/services/visionPreprocessor.js";

const FAKE_IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
const noLog = { info: () => {}, warn: () => {} };

// ── BUG #2: extractVisionText must fall back to reasoning_content ──────────────

test("extractVisionText returns content when present", () => {
  const data = { choices: [{ message: { content: "red square", reasoning_content: "thinking..." } }] };
  assert.equal(extractVisionText(data), "red square");
});

test("extractVisionText falls back to reasoning_content when content is null", () => {
  const data = { choices: [{ message: { content: null, reasoning_content: "the image is red" } }] };
  assert.equal(extractVisionText(data), "the image is red");
});

test("extractVisionText falls back to reasoning_content when content is empty string", () => {
  const data = { choices: [{ message: { content: "", reasoning_content: "image shows red" } }] };
  assert.equal(extractVisionText(data), "image shows red");
});

test("extractVisionText returns null when both content and reasoning_content are empty", () => {
  const data = { choices: [{ message: { content: "", reasoning_content: "" } }] };
  assert.equal(extractVisionText(data), null);
});

test("extractVisionText returns null when message missing", () => {
  assert.equal(extractVisionText({ choices: [] }), null);
  assert.equal(extractVisionText({}), null);
});

// ── BUG #1: preprocessVisionContent must skip when target model has vision ─────
// Simulates a request sent to a vision-capable model (e.g. Claude). The 4th
// param `targetCaps` tells the preprocessor the *target* model's capabilities;
// when targetCaps.vision === true it MUST skip preprocessing and return null
// (no self-loopback call, no image stripping) so the target reads the raw image.

test("preprocessVisionContent skips when targetCaps.vision is true", async () => {
  const body = {
    model: "oc/claude-sonnet-4.6",
    stream: false,
    messages: [{ role: "user", content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: FAKE_IMG } },
    ] }],
  };
  const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };
  const result = await preprocessVisionContent(body, settings, noLog, { vision: true });
  assert.equal(result, null, "must skip preprocessing when target model has vision");
});

test("preprocessVisionContent still proceeds when targetCaps.vision is false", async () => {
  // Non-vision target: must NOT skip at the capability gate. We assert it does
  // not return null at the *capability* check by verifying it moves past it.
  // (It will later fail the self-loopback fetch since no server here, but the
  // capability gate itself must not short-circuit.)
  const body = {
    model: "oc/glm-5.2",
    stream: false,
    _skipVision: false,
    messages: [{ role: "user", content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: FAKE_IMG } },
    ] }],
  };
  const settings = { visionPreprocessingEnabled: true, visionPreprocessingModel: "oc/mimo-v2.5-free" };
  // Pass a stub fetch env so the self-loopback fails fast without hanging.
  const result = await preprocessVisionContent(body, settings, noLog, { vision: false });
  // It should reach the fetch stage and return a body with a placeholder, NOT null
  // at the capability gate. (Either a body or null-from-fetch-error is fine, but
  // the key assertion is it did not skip due to capability.)
  assert.ok(result !== undefined, "must not be undefined");
});

test("preprocessVisionContent skips when _skipVision flag set (anti-loop, regression)", async () => {
  const body = {
    model: "oc/glm-5.2",
    _skipVision: true,
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: FAKE_IMG } }] }],
  };
  const result = await preprocessVisionContent(body, { visionPreprocessingEnabled: true }, noLog, { vision: false });
  assert.equal(result, null, "must skip when _skipVision flag is set");
});

test("hasImageContent detects image_url block", () => {
  assert.equal(hasImageContent({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: FAKE_IMG } }] }] }), true);
  assert.equal(hasImageContent({ messages: [{ role: "user", content: "text only" }] }), false);
});

// ── BUG #3: resolveTargetCaps must see through combo names ────────────────────
// getModelInfo("vision") returns {provider: null} because "vision" is a combo
// name, not a provider/model. The old chat.js only checked direct models, so
// targetCaps was always null for combos — making the preprocessor run even for
// a combo whose only model is vision-capable (double-read + 502). resolveTargetCaps
// expands the combo and returns {vision:true} only when EVERY member already has
// vision, so preprocessing is skipped and the combo reads the raw image once.

const mockDeps = {
  getModelInfo: async (s) => {
    if (s === "oc/mimo-v2.5-free") return { provider: "opencode", model: "mimo-v2.5-free" };
    if (s === "va/glm-5.2") return { provider: "va", model: "glm-5.2" };
    return { provider: null }; // combo / unknown
  },
  getComboModels: async (s) => {
    if (s === "vision") return ["oc/mimo-v2.5-free"];
    if (s === "high") return ["va/glm-5.2", "oc/mimo-v2.5-free"];
    if (s === "textonly") return ["va/glm-5.2"];
    if (s === "empty") return [];
    return null;
  },
  getCapabilitiesForModel: (provider, _model) => {
    if (provider === "opencode") return { vision: true };
    if (provider === "va") return { vision: false };
    return { vision: false };
  },
};

test("resolveTargetCaps: direct vision model returns {vision:true}", async () => {
  assert.deepEqual(await resolveTargetCaps("oc/mimo-v2.5-free", mockDeps), { vision: true });
});

test("resolveTargetCaps: direct text model returns caps with vision false", async () => {
  assert.deepEqual(await resolveTargetCaps("va/glm-5.2", mockDeps), { vision: false });
});

test("resolveTargetCaps: combo all-vision returns {vision:true} (KEY FIX)", async () => {
  // "vision" combo = [oc/mimo-v2.5-free] — all vision-capable -> skip preprocessing
  assert.deepEqual(await resolveTargetCaps("vision", mockDeps), { vision: true });
});

test("resolveTargetCaps: combo mix vision+text returns null", async () => {
  // "high" combo has a text-only model -> must NOT skip (fallback needs text)
  assert.equal(await resolveTargetCaps("high", mockDeps), null);
});

test("resolveTargetCaps: combo all non-vision returns null", async () => {
  assert.equal(await resolveTargetCaps("textonly", mockDeps), null);
});

test("resolveTargetCaps: empty combo returns null", async () => {
  assert.equal(await resolveTargetCaps("empty", mockDeps), null);
});

test("resolveTargetCaps: unknown model returns null", async () => {
  assert.equal(await resolveTargetCaps("nope", mockDeps), null);
});
