"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";

const RETENTION_OPTIONS = [
  { value: "900000", label: "15 min" },
  { value: "3600000", label: "1 hour" },
  { value: "21600000", label: "6 hours" },
  { value: "86400000", label: "24 hours" },
  { value: "0", label: "Off" },
];

function getBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function normalizeLogEntry(entry) {
  if (typeof entry === "string") return { line: entry, createdAt: null, request: null };
  if (!entry || typeof entry !== "object") return { line: String(entry ?? ""), createdAt: null, request: null };
  return {
    line: typeof entry.line === "string" ? entry.line : String(entry.line ?? ""),
    createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : null,
    request: entry.request && typeof entry.request === "object" ? entry.request : null,
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
      fractionalSecondDigits: 3,
    }).formatToParts(new Date(createdAt));
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get("hour")}:${get("minute")}:${get("second")}.${get("fractionalSecond")}`;
  } catch {
    return null;
  }
}

function formatDisplayLine(entry, timeZone) {
  const normalized = normalizeLogEntry(entry);
  const clock = formatClock(normalized.createdAt, timeZone);
  return clock ? `[${clock}] ${normalized.line}` : normalized.line;
}

function getStatusStyle(status) {
  const code = Number(status);
  if (code >= 200 && code < 300) return "text-emerald-300 border-emerald-500/30 bg-emerald-500/15";
  if (code >= 400) return "text-red-300 border-red-500/30 bg-red-500/15";
  return "text-amber-300 border-amber-500/30 bg-amber-500/15";
}

function renderRequestLog(entry, timeZone) {
  const { request } = normalizeLogEntry(entry);
  if (!request) return null;
  const clock = formatClock(entry.createdAt, timeZone) || "--:--:--.---";
  const status = request.status ?? 200;
  const tokens = request.tokens || {};
  const input = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const output = tokens.output_tokens ?? tokens.completion_tokens ?? 0;

  return (
    <div className="flex min-w-max items-center gap-1.5 py-0.5 hover:bg-white/[0.03] rounded px-1 -mx-1">
      <span className="text-text-muted tabular-nums">[{clock}]</span>
      <span className={`border px-1 py-px rounded text-[10px] font-semibold tabular-nums ${getStatusStyle(status)}`}>[{status}]</span>
      <span className="text-violet-300">stream:{String(Boolean(request.stream))}</span>
      <span className="text-cyan-300 font-semibold">{request.provider || "unknown"}</span>
      <span className="text-text-muted">/</span>
      <span className="text-blue-200">{request.model || "unknown"}</span>
      <span className="text-text-muted">|</span>
      <span className="text-amber-300 tabular-nums">{Math.round(request.duration || 0)}ms</span>
      <span className="text-text-muted tabular-nums">(TTFT {Math.round(request.ttft || 0)})</span>
      <span className="text-text-muted">|</span>
      <span className="text-emerald-300 tabular-nums">In: {input}</span>
      <span className="text-text-muted">|</span>
      <span className="text-sky-300 tabular-nums">Out: {output}</span>
    </div>
  );
}

function colorLine(line) {
  if (/\[(ERROR|FAILED)\]/.test(line)) return <span className="text-red-400">{line}</span>;
  if (/\[WARN/.test(line)) return <span className="text-yellow-400">{line}</span>;
  return <span className="text-green-400">{line}</span>;
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [timeZone] = useState(getBrowserTimeZone);
  const [retentionMs, setRetentionMs] = useState(String(CONSOLE_LOG_CONFIG.defaultRetentionMs));
  const [savingRetention, setSavingRetention] = useState(false);
  const logRef = useRef(null);

  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  const handleDownload = () => {
    const content = logs.map((entry) => formatDisplayLine(entry, timeZone)).join("\n");
    const blob = new Blob([content ? `${content}\n` : ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `routerdone-console-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    let alive = true;
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => res.ok ? res.json() : null)
      .then((settings) => {
        if (alive && settings) setRetentionMs(String(settings.consoleLogRetentionMs ?? CONSOLE_LOG_CONFIG.defaultRetentionMs));
      })
      .catch((err) => console.error("Failed to load console log settings:", err));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");
    es.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "init" || message.type === "sync") {
        setLogs((message.logs || []).map(normalizeLogEntry).slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (message.type === "line") {
        setLogs((current) => [...current, normalizeLogEntry(message.entry ?? message.line)].slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (message.type === "clear") {
        setLogs([]);
      }
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const handleRetentionChange = async (event) => {
    const next = event.target.value;
    setRetentionMs(next);
    setSavingRetention(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consoleLogRetentionMs: Number(next) }),
      });
      if (!response.ok) throw new Error("Failed to update retention");
    } catch (err) {
      console.error("Failed to update console log retention:", err);
    } finally {
      setSavingRetention(false);
    }
  };

  return (
    <div>
      <Card>
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 pt-3 pb-2">
          <label className="flex items-center gap-2 text-xs font-medium text-text-muted">
            <span>Auto-delete</span>
            <select value={retentionMs} onChange={handleRetentionChange} disabled={savingRetention} className="h-7 rounded-[8px] border border-border bg-surface-2 px-3 text-xs font-semibold text-text-main outline-none disabled:opacity-50">
              {RETENTION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <Button size="sm" variant="outline" icon="download" onClick={handleDownload} disabled={logs.length === 0}>Download</Button>
          <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>Clear old</Button>
        </div>
        <div ref={logRef} className="bg-black rounded-b-lg p-4 text-xs font-mono h-[calc(100vh-220px)] overflow-auto">
          {logs.length === 0 ? <span className="text-text-muted">No console logs yet.</span> : (
            <div className="space-y-0.5">
              {logs.map((entry, index) => <div key={index}>{renderRequestLog(entry, timeZone) || colorLine(formatDisplayLine(entry, timeZone))}</div>)}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
