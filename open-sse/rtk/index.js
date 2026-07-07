// RTK port: compress tool_result content in LLM request bodies
// Injected at the top of translateRequest (before any format translation)
import { RAW_CAP, MIN_COMPRESS_SIZE, AGE_LIGHT_TURNS, AGE_HEAVY_TURNS, AGE_LIGHT_MIN_BYTES, AGE_HEAVY_MIN_BYTES, AGE_HEAVY_RECOMPRESS_BYTES } from "./constants.js";
import { autoDetectFilter } from "./autodetect.js";
import { safeApply } from "./applyFilter.js";
import { scoredTruncate } from "./filters/scoredTruncate.js";

const WEAK_COMPRESS_MIN_BYTES = 100_000;
const WEAK_COMPRESS_MAX_SAVED_RATIO = 0.05;

// Compress tool_result content in-place. Returns stats or null if disabled/failed.
export function compressMessages(body, enabled) {
  if (!enabled) return null;
  if (!body) return null;

  // Kiro format: conversationState.history + conversationState.currentMessage
  if (body.conversationState) {
    return compressKiroFormat(body, enabled);
  }

  // Support both OpenAI/Claude "messages" and OpenAI Responses "input"
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!items) return null;

  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  const seen = new Set(); // cross-message tool result dedup
  const compress = (text, shape, age) => {
    if (typeof text !== "string") return text;
    // Progressive compression: recent -> gentle, old -> aggressive
    // Keep the base floor at MIN_COMPRESS_SIZE so clearly structured tool output
    // (diff/grep/log) still compresses even when it is in a recent turn. Age only
    // controls the extra aggressive second pass for old history.
    const minBytes = MIN_COMPRESS_SIZE;
    if (text.length < minBytes) return text;
    const fp = text.length + ":" + text.slice(0, 300);
    if (seen.has(fp)) {
      const rep = `[RTK: duplicate tool result omitted (${text.length}B)]`;
      stats.bytesBefore += text.length;
      stats.bytesAfter += rep.length;
      stats.hits.push({ shape, filter: "cross-dedup", saved: text.length - rep.length });
      return rep;
    }
    seen.add(fp);
    let out = compressText(text, stats, shape);
    // Old messages: aggressive second pass with scored-truncate
    if (age >= AGE_HEAVY_TURNS && typeof out === "string" && out.length > AGE_HEAVY_RECOMPRESS_BYTES) {
      const heavy = scoredTruncate(out);
      if (heavy && heavy.length > 0 && heavy.length < out.length) {
        stats.bytesAfter += heavy.length - out.length;
        stats.hits.push({ shape, filter: "age-progressive", saved: out.length - heavy.length });
        out = heavy;
      }
    }
    return out;
  };
  try {
    for (let i = 0; i < items.length; i++) {
      const msg = items[i];
      if (!msg) continue;
      const age = items.length - 1 - i;

      // Shape 4: OpenAI Responses — top-level { type:"function_call_output", output: string | [{type:"input_text", text}] }
      if (msg.type === "function_call_output") {
        if (typeof msg.output === "string") {
          msg.output = compress(msg.output, "openai-responses-string", age);
        } else if (Array.isArray(msg.output)) {
          for (let k = 0; k < msg.output.length; k++) {
            const part = msg.output[k];
            if (part && part.type === "input_text" && typeof part.text === "string") {
              part.text = compress(part.text, "openai-responses-array", age);
            }
          }
        }
        continue;
      }

      // Shape 1: OpenAI tool message — { role:"tool", content: "string" }
      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = compress(msg.content, "openai-tool", age);
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      // Shape 1b: OpenAI tool message — { role:"tool", content:[{type:"text", text:"..."}] }
      if (msg.role === "tool") {
        for (let k = 0; k < msg.content.length; k++) {
          const part = msg.content[k];
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = compress(part.text, "openai-tool-array", age);
          }
        }
        continue;
      }

      // Shape 2/3: blocks array with tool_result entries
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!block || block.type !== "tool_result") continue;
        if (block.is_error === true) continue; // preserve error traces

        if (typeof block.content === "string") {
          // Shape 2: claude string form
          block.content = compress(block.content, "claude-string", age);
        } else if (Array.isArray(block.content)) {
          // Shape 3: claude array form — compress each text part
          for (let k = 0; k < block.content.length; k++) {
            const part = block.content[k];
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = compress(part.text, "claude-array", age);
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressMessages error:", e.message);
    return null;
  }
  return stats;
}

// Compress Kiro format: conversationState.history[].userInputMessage.userInputMessageContext.toolResults[].content[].text
function compressKiroFormat(body, enabled) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  const seen = new Set();
  const compress = (text, shape, age) => {
    if (typeof text !== "string") return text;
    // Keep the base floor at MIN_COMPRESS_SIZE so clearly structured tool output
    // (diff/grep/log) still compresses even when it is in a recent turn. Age only
    // controls the extra aggressive second pass for old history.
    const minBytes = MIN_COMPRESS_SIZE;
    if (text.length < minBytes) return text;
    const fp = text.length + ":" + text.slice(0, 300);
    if (seen.has(fp)) {
      const rep = `[RTK: duplicate tool result omitted (${text.length}B)]`;
      stats.bytesBefore += text.length;
      stats.bytesAfter += rep.length;
      stats.hits.push({ shape, filter: "cross-dedup", saved: text.length - rep.length });
      return rep;
    }
    seen.add(fp);
    let out = compressText(text, stats, shape);
    if (age >= AGE_HEAVY_TURNS && typeof out === "string" && out.length > AGE_HEAVY_RECOMPRESS_BYTES) {
      const heavy = scoredTruncate(out);
      if (heavy && heavy.length > 0 && heavy.length < out.length) {
        stats.bytesAfter += heavy.length - out.length;
        stats.hits.push({ shape, filter: "age-progressive", saved: out.length - heavy.length });
        out = heavy;
      }
    }
    return out;
  };
  try {
    const state = body.conversationState;
    const allMessages = [...(Array.isArray(state?.history) ? state.history : [])];
    if (state?.currentMessage) allMessages.push(state.currentMessage);

    for (let mi = 0; mi < allMessages.length; mi++) {
      const msg = allMessages[mi];
      const age = allMessages.length - 1 - mi;
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults;
      if (!Array.isArray(toolResults)) continue;

      for (const tr of toolResults) {
        if (tr.status === "error") continue; // preserve error traces
        if (!Array.isArray(tr.content)) continue;

        for (const part of tr.content) {
          if (part && typeof part.text === "string") {
            part.text = compress(part.text, "kiro-tool-result", age);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressKiroFormat error:", e.message);
    return null;
  }
  return stats;
}

function compressText(text, stats, shape) {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;

  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const fn = autoDetectFilter(text);
  if (!fn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  let out = safeApply(fn, text);
  let filterName = fn.filterName || fn.name;
  const savedRatio = out && out.length > 0 ? (bytesIn - out.length) / bytesIn : 0;
  if (out && out.length > 0 && out.length < bytesIn && bytesIn >= WEAK_COMPRESS_MIN_BYTES && savedRatio < WEAK_COMPRESS_MAX_SAVED_RATIO && fn !== scoredTruncate) {
    const fallbackOut = safeApply(scoredTruncate, text);
    if (fallbackOut && fallbackOut.length > 0 && fallbackOut.length < out.length) {
      out = fallbackOut;
      filterName = scoredTruncate.filterName || scoredTruncate.name;
    }
  }

  // Safety: never return empty, never grow the input
  if (!out || out.length === 0 || out.length >= bytesIn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  stats.bytesAfter += out.length;
  stats.hits.push({ shape, filter: filterName, saved: bytesIn - out.length });
  return out;
}

// Convenience: format a log line from stats
export function formatRtkLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}
