"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

const RETENTION_OPTIONS = [
  { value: "900000", label: "15 min" },
  { value: "3600000", label: "1 hour" },
  { value: "21600000", label: "6 hours" },
  { value: "86400000", label: "24 hours" },
  { value: "0", label: "Off" },
];

const LOG_LEVEL_COLORS = {
  LOG: "text-green-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-purple-400",
};

// ── Structured log parsers ──────────────────────────────────────────

// [02:21:11] 📊 [USAGE] P | in=2000 | out=1 | account=test-con... (estimated)
const USAGE_RE = /^(\[(?:LOG|INFO|WARN)\])?\s*📊\s*\[USAGE\]\s+(.+?)\s+\|\s+in=(\S+)\s+\|\s+out=(\S+)\s*\|\s*account=(.+?)(?:\s*\((estimated|real)\))?\s*$/;

// Note: console.log strips emoji, so we also try without 📊
const USAGE_RE_NOEMOJI = /^(\[(?:LOG|INFO|WARN)\])?\s*\[USAGE\]\s+(.+?)\s+\|\s+in=(\S+)\s+\|\s+out=(\S+)\s*\|\s*account=(.+?)(?:\s*\((estimated|real)\))?\s*$/;

// [02:21:11] 🌊 [STREAM] OPENAI | gpt-4o | 3026ms | error: ...
// [02:21:11] 🌊 [STREAM] OPENAI | gpt-4o | 3026ms (success)
const STREAM_RE = /^(\[(?:LOG|INFO|WARN)\])?\s*🌊\s*\[STREAM\]\s+(.+?)\s+\|\s+(.+?)\s+\|\s+(\d+)ms\s*(\|\s*(.+))?\s*$/;
const STREAM_RE_NOEMOJI = /^(\[(?:LOG|INFO|WARN)\])?\s*\[STREAM\]\s+(.+?)\s+\|\s+(.+?)\s+\|\s+(\d+)ms\s*(\|\s*(.+))?\s*$/;

// [02:21:17] 🐛 [DBG:FETCH] TEST → https://x/api | ← 200 | ttft=0ms
const FETCH_RE = /^(\[(?:LOG|INFO|DEBUG)\])?\s*🐛\s*\[DBG:FETCH\]\s+(.+?)\s+→\s+(\S+).*?\|\s*←\s+(\d+).*$/;
const FETCH_RE_NOEMOJI = /^(\[(?:LOG|INFO|DEBUG)\])?\s*\[DBG:FETCH\]\s+(.+?)\s+→\s+(\S+).*?\|\s*←\s+(\d+).*$/;

// [02:21:11] [PENDING] START | provider=openai | model=gpt-4
// [02:21:11] [PENDING] END | provider=openai | model=gpt-4
const PENDING_RE = /^(\[(?:LOG|INFO)\])?\s*\[PENDING\]\s+(START|END)\s*\|\s*provider=(\S+)\s*\|\s*model=(\S+)/;

// Badge colors for status codes
function statusBadge(status) {
  if (status === "200" || status === "201" || status === "success") {
    return { bg: "bg-emerald-500/15", text: "text-emerald-300", border: "border-emerald-500/30" };
  }
  if (status === "error" || status === "timeout" || status === "empty") {
    return { bg: "bg-red-500/15", text: "text-red-300", border: "border-red-500/30" };
  }
  return { bg: "bg-amber-500/15", text: "text-amber-300", border: "border-amber-500/30" };
}

function parseLogLine(line) {
  // Strip the timestamp prefix first
  const stripped = line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "");

  // Try USAGE pattern
  let m = USAGE_RE.exec(line) || USAGE_RE_NOEMOJI.exec(line);
  if (m) {
    const [, , provider, tokenIn, tokenOut, account, estimated] = m;
    const prov = provider.replace(/CODEX|OPENAI|GEMINI|GROQ|ANTHROPIC/gi, (x) => x.toUpperCase());
    return {
      type: "usage",
      provider: prov,
      tokenIn,
      tokenOut,
      account: account.trim().replace(/\.+$/, ""),
      estimated: estimated === "estimated",
    };
  }

  // Try STREAM pattern
  m = STREAM_RE.exec(line) || STREAM_RE_NOEMOJI.exec(line);
  if (m) {
    const [, , provider, model, duration, , detail] = m;
    const isError = detail && !detail.includes("success") && !detail.includes("complete");
    let status = isError ? "error" : "success";
    let errorText = "";
    if (isError) {
      // Extract error type
      const errMatch = detail.match(/error:\s*(.+)/);
      errorText = errMatch ? errMatch[1] : detail.trim();
      if (errorText.includes("empty")) status = "empty";
      if (errorText.includes("timeout")) status = "timeout";
    }
    return {
      type: "stream",
      provider: provider.replace(/CODEX|OPENAI|GEMINI|GROQ|ANTHROPIC/gi, (x) => x.toUpperCase()),
      model,
      duration: parseInt(duration),
      status,
      errorText,
    };
  }

  // Try FETCH pattern
  m = FETCH_RE.exec(line) || FETCH_RE_NOEMOJI.exec(line);
  if (m) {
    const [, , label, url, status] = m;
    return { type: "fetch", label, url, status };
  }

  // Try PENDING pattern
  m = PENDING_RE.exec(line);
  if (m) {
    const [, , direction, provider, model] = m;
    return { type: "pending", direction, provider, model };
  }

  return null; // unstructured line
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(0);
  return `${m}m ${s}s`;
}

function formatTokens(n) {
  const num = parseInt(n);
  if (!num) return "0";
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

// ── Line renderer ───────────────────────────────────────────────────

function renderStructuredLine(parsed, line, clock) {
  switch (parsed.type) {
    case "usage": {
      const sb = statusBadge("200");
      return (
        <div className="flex items-center gap-2 py-0.5 hover:bg-white/[0.03] rounded px-1 -mx-1 group">
          <span className="text-text-muted shrink-0 w-[70px] text-right tabular-nums">{clock}</span>
          <span className={`shrink-0 px-1.5 py-px rounded text-[10px] font-semibold ${sb.bg} ${sb.text} border ${sb.border}`}>
            USAGE
          </span>
          <span className="text-cyan-300 font-semibold shrink-0">{parsed.provider}</span>
          <span className="text-text-muted">|</span>
          <span className="text-green-400 tabular-nums">
            in:{formatTokens(parsed.tokenIn)}
          </span>
          <span className="text-text-muted">→</span>
          <span className="text-blue-400 tabular-nums">
            out:{formatTokens(parsed.tokenOut)}
          </span>
          <span className="text-text-muted">|</span>
          <span className="text-text-muted text-[10px] truncate max-w-[200px]" title={parsed.account}>
            {parsed.account}
          </span>
          {parsed.estimated && (
            <span className="text-amber-400/60 text-[10px] italic">(est)</span>
          )}
        </div>
      );
    }

    case "stream": {
      const isError = parsed.status !== "success";
      const sb = isError
        ? { bg: "bg-red-500/15", text: "text-red-300", border: "border-red-500/30" }
        : statusBadge("200");
      const statusLabel = parsed.status === "empty" ? "EMPTY"
        : parsed.status === "timeout" ? "TIMEOUT"
        : isError ? "ERROR" : "OK";
      const durationColor = parsed.duration > 10000 ? "text-amber-400"
        : parsed.duration > 5000 ? "text-yellow-400"
        : "text-text-muted";

      return (
        <div className="flex items-center gap-2 py-0.5 hover:bg-white/[0.03] rounded px-1 -mx-1">
          <span className="text-text-muted shrink-0 w-[70px] text-right tabular-nums">{clock}</span>
          <span className={`shrink-0 px-1.5 py-px rounded text-[10px] font-semibold ${sb.bg} ${sb.text} border ${sb.border}`}>
            {statusLabel}
          </span>
          <span className="text-cyan-300 font-semibold shrink-0">{parsed.provider}</span>
          <span className="text-text-muted">/</span>
          <span className="text-blue-200 shrink-0">{parsed.model}</span>
          <span className={`${durationColor} tabular-nums shrink-0`}>{formatDuration(parsed.duration)}</span>
          {isError && parsed.errorText && (
            <>
              <span className="text-text-muted">—</span>
              <span className="text-red-400/80 text-[10px] truncate max-w-[300px]" title={parsed.errorText}>
                {parsed.errorText}
              </span>
            </>
          )}
        </div>
      );
    }

    case "fetch": {
      const sb = statusBadge(parsed.status);
      const method = parsed.label.replace(/TEST\s*/, "");
      const shortUrl = parsed.url.replace(/^https?:\/\//, "").slice(0, 40);
      return (
        <div className="flex items-center gap-2 py-0.5 hover:bg-white/[0.03] rounded px-1 -mx-1">
          <span className="text-text-muted shrink-0 w-[70px] text-right tabular-nums">{clock}</span>
          <span className={`shrink-0 px-1.5 py-px rounded text-[10px] font-semibold ${sb.bg} ${sb.text} border ${sb.border}`}>
            {parsed.status}
          </span>
          <span className="text-purple-300 text-[10px] shrink-0">{method || "FETCH"}</span>
          <span className="text-text-muted text-[10px] truncate max-w-[250px]" title={parsed.url}>{shortUrl}</span>
        </div>
      );
    }

    case "pending": {
      const isStart = parsed.direction === "START";
      const color = isStart ? "text-amber-400/70" : "text-emerald-400/70";
      const icon = isStart ? "▸" : "✓";
      return (
        <div className={`flex items-center gap-2 py-0.5 hover:bg-white/[0.03] rounded px-1 -mx-1 ${color}`}>
          <span className="text-text-muted shrink-0 w-[70px] text-right tabular-nums">{clock}</span>
          <span className="text-[10px]">{icon}</span>
          <span>{parsed.direction.toLowerCase()}</span>
          <span className="text-text-muted">|</span>
          <span className="text-cyan-300/80">{parsed.provider}</span>
          <span className="text-text-muted">/</span>
          <span className="text-blue-200/80">{parsed.model}</span>
        </div>
      );
    }

    default:
      return null;
  }
}

// ── Legacy renderer for unstructured lines ──────────────────────────

function colorLine(line) {
  const match = line.match(/\[(\w+)\]/g);
  const levelTag = match ? match[1]?.replace(/\[|\]/g, "") : null;
  const color = LOG_LEVEL_COLORS[levelTag] || "text-green-400";
  return <span className={color}>{line}</span>;
}

function getBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function normalizeLogEntry(entry) {
  if (typeof entry === "string") return { line: entry, createdAt: null };
  if (!entry || typeof entry !== "object") return { line: String(entry ?? ""), createdAt: null };
  return {
    line: typeof entry.line === "string" ? entry.line : String(entry.line ?? ""),
    createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : null,
  };
}

function formatClock(createdAt, timeZone) {
  if (!createdAt) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour12: false,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(createdAt));
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get("hour")}:${get("minute")}:${get("second")}`;
  } catch {
    return null;
  }
}

function formatDisplayLine(entry, timeZone) {
  const normalized = normalizeLogEntry(entry);
  const localClock = formatClock(normalized.createdAt, timeZone);
  if (!localClock) return normalized.line;
  return normalized.line.replace(/^\[\d{2}:\d{2}:\d{2}\]/, `[${localClock}]`);
}

const handleDownload = (logs, timeZone) => {
  const content = logs.map((line) => formatDisplayLine(line, timeZone)).join("\n");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const blob = new Blob([content ? `${content}\n` : ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `routerdone-console-log-${timestamp}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [timeZone] = useState(getBrowserTimeZone);
  const [connected, setConnected] = useState(false);
  const [retentionMs, setRetentionMs] = useState(String(CONSOLE_LOG_CONFIG.defaultRetentionMs));
  const [savingRetention, setSavingRetention] = useState(false);
  const logRef = useRef(null);

  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      // UI syncs via SSE after keeping the last 5 minutes.
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  const handleRetentionChange = async (event) => {
    const next = event.target.value;
    setRetentionMs(next);
    setSavingRetention(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consoleLogRetentionMs: Number(next) }),
      });
      if (!res.ok) throw new Error("Failed to update retention");
    } catch (err) {
      console.error("Failed to update console log retention:", err);
    } finally {
      setSavingRetention(false);
    }
  };

  useEffect(() => {
    let alive = true;
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => res.ok ? res.json() : null)
      .then((settings) => {
        if (!alive || !settings) return;
        setRetentionMs(String(settings.consoleLogRetentionMs ?? CONSOLE_LOG_CONFIG.defaultRetentionMs));
      })
      .catch((err) => console.error("Failed to load console log settings:", err));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "init") {
        setLogs((msg.logs || []).map(normalizeLogEntry).slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "line") {
        setLogs((prev) => {
          const next = [...prev, normalizeLogEntry(msg.entry ?? msg.line)];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "clear") {
        setLogs([]);
      } else if (msg.type === "sync") {
        setLogs((msg.logs || []).map(normalizeLogEntry).slice(-CONSOLE_LOG_CONFIG.maxLines));
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // ── Render each log entry ────────────────────────────────────────
  function renderLogEntry(entry, idx) {
    const displayLine = formatDisplayLine(entry, timeZone);
    const parsed = parseLogLine(displayLine);
    if (parsed) {
      const clock = formatClock(normalizeLogEntry(entry).createdAt, timeZone);
      const elapsed = renderStructuredLine(parsed, displayLine, clock);
      if (elapsed) return <div key={idx}>{elapsed}</div>;
    }
    // Fallback: legacy color-coded text
    return <div key={idx}>{colorLine(displayLine)}</div>;
  }

  return (
    <div className="">
      <Card>
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 pt-3 pb-2">
          <label className="flex items-center gap-2 text-xs font-medium text-text-muted">
            <span className="whitespace-nowrap">Auto-delete</span>
            <span className="relative inline-flex items-center">
              <select
                value={retentionMs}
                onChange={handleRetentionChange}
                disabled={savingRetention}
                className="h-7 w-32 appearance-none rounded-[8px] border border-border bg-surface-2 py-1 pl-3 pr-8 text-xs font-semibold text-text-main outline-none transition-all focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20 disabled:opacity-50"
              >
                {RETENTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="material-symbols-outlined pointer-events-none absolute right-2 text-[18px] text-text-muted">expand_more</span>
            </span>
          </label>
          <Button size="sm" variant="outline" icon="download" onClick={() => handleDownload(logs, timeZone)} disabled={logs.length === 0}>
            Download
          </Button>
          <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
            Clear old
          </Button>
        </div>
        <div
          ref={logRef}
          className="bg-black rounded-b-lg p-4 text-xs font-mono h-[calc(100vh-220px)] overflow-y-auto"
        >
          {logs.length === 0 ? (
            <span className="text-text-muted">No console logs yet.</span>
          ) : (
            <div className="space-y-0.5">
              {logs.map((entry, i) => renderLogEntry(entry, i))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
