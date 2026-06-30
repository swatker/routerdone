# Changelog

All notable changes to the `swatker/routerdone` fork are documented here.
This fork tracks `thoa100m/routerdone` upstream and adds local fixes on top.
Dates use the ISO `YYYY-MM-DD` format. Versions follow the upstream tag the fork
is based on.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/) as
released upstream.

## [0.5.92] — 2026-06-30

### Vision Preprocessing
A new inline preprocessor converts image blocks into OCR text before a request
reaches a model that has no vision support, so non-vision models can still
answer questions about images. Runs at the `handleChat` level, before combo
dispatch.

- **feat:** inline vision preprocessor — `oc/mimo-v2.5-free` reads images and
  returns OCR + brief description; image blocks are replaced with
  `[Image description: ...]` text. (`9638401`, `9e5baa4`, `29b3beb`, `8fa0023`)
- **feat:** Vision Preprocessing settings UI — toggle on/off + model picker, in
  `Dashboard -> Profile -> Vision Preprocessing`. (`a4b7e97`, `a5b5b88`,
  `ec5b3c0`, `9d7b6a0`)
- **fix:** only process images in the LAST user message; images in older turns
  are stripped without a vision call (prevents re-reading history every turn).
  (`11e0bba`)
- **fix:** switch to self-loopback `/api/v1/chat/completions` for robust routing,
  auth, and credential reuse. (`11e0bba`)
- **fix:** prevent infinite loopback recursion via a `_skipVision` flag on the
  loopback body. (`ec11b8d`)
- **fix:** keep the full model string (`oc/mimo-v2.5-free`) for correct routing;
  stripping the `oc/` prefix caused a 404 fallback to the `openai` provider.
  (`60eea24`)
- **fix:** skip preprocessing when the target model already supports vision
  (`targetCaps.vision === true`), so vision-capable models read the raw image
  instead of a downgraded text description. (`b6d2517`)
- **fix:** `resolveTargetCaps()` sees through combo names — `getModelInfo(combo)`
  returns `provider:null`, so `targetCaps` was always null for combos and the
  preprocessor ran even when a combo's only model was vision-capable, causing a
  double-read (preprocessor self-loopback + combo dispatch) and a combo-route
  502. Now expands the combo and skips only when every member is vision-capable;
  mixed/non-vision combos still preprocess so fallback members get text context.
  (`61a1325`)
- **fix:** `extractVisionText()` prefers `message.content` and falls back to
  `message.reasoning_content` — reasoning-capable vision models can exhaust the
  output budget on reasoning and leave `content` empty. (`b6d2517`)
- **config:** raise the combo `vision` preflight timeout. The combo route
  headers deadline is `firstByteTimeoutMs(3000) + firstProductiveTimeoutMs(9000)
  = 12000ms`; `oc/mimo-v2.5-free` needs ~10–12s per image, so it hit the 12s
  deadline and aborted to 502 on slower turns. Set
  `comboStrategies.vision.preflightTimeoutMs = 30000` (deadline → 33s) in the
  runtime DB settings. This is a runtime config, not a code commit — re-apply
  after a fresh DB deploy (Dashboard combo settings or direct DB edit).
- **test:** `tests/vision-preprocessor.test.mjs` (16 cases, `node:test`): 9
  original + 7 new `resolveTargetCaps` cases (direct/combo all-vision/mix/empty/
  unknown). E2E verified on container v0.5.92: image → combo `vision` (single
  read, skip preprocessing) → `oc/mimo-v2.5-free` returns
  `"Bức ảnh là một mảng màu đỏ rực rỡ và đều đặn."` (200, 4.6s).

### Combo / Routing
- **fix:** recover from combo fallback model lock. (`c58eece`)
- **fix:** reset stale fallback cooldown. (`760d4a8`)
- **fix:** avoid locking models for invalid `image_url` payloads. (`87c0329`)
- **fix:** handle provider billing and 530 recovery. (`44e8f99`)
- **tune:** combo preflight timeout for reasoning models. (`c579b8b`)

### Build / Infra
- **chore:** merge upstream v0.5.92 (8 versions, clean merge). (`4ebf6db`)
- **chore:** harden Dokploy Docker builds. (`bb97807`)
- **chore:** remove external Dockerfile frontend. (`7f48428`)

## [0.5.84] — 2026-06-29

### Upstream
- **chore:** merge upstream v0.5.84. (`b0500aa`)

### Stream
- **fix:** retry empty upstream preflight. (`7734173`)
- **fix:** stream preflight timeout policy. (`c83a3a4`)
- **fix:** handle Codex usage auth failures clearly. (`14b6e4b`)
- **fix:** token estimation and hard-cap pruning. (`0a671a4`)

## [0.5.75] — 2026-06-28

### Upstream
- **chore:** merge upstream v0.5.75 into main; the force-stream fix for
  `openai-compatible-*` is now provided upstream and is preserved in this fork.
  (`0383f16`)

### Force-stream (superseded by upstream v0.5.75)
Earlier fork fix for `stream:false` over `openai-compatible-*` providers
returning `502 Empty upstream stream before content`. Upstream v0.5.75 now
ships the same fix; the fork no longer needs to maintain it separately.

## [0.5.62] — 2026-06-26

### Combo / Context
- **fix:** cooldown auth-locked fallback models. (`a890679`)
- **feat:** context guard — evict old reasoning blobs to prevent
  >1M-token input overflow. (`6e2b503`)

### Routing
- **fix:** `const modelStr` caused `TypeError` on `gpt-5.4-mini` redirect.
  (`e826f15`)

### UI
- **fix:** sidebar dual update notification — Version (update: X) for GitHub
  releases + Core (latest: X) for npm upstream; strip BOM from `route.js`.
  (`d500de2`)
