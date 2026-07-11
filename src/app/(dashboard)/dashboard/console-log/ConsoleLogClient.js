"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
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
      timeZone, hour12: false, hourCycle: "h23",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      fractionalSecondDigits: 3,
    }).formatToParts(new Date(createdAt));
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return get("hour") + ":" + get("minute") + ":" + get("second") + "." + get("fractionalSecond");
  } catch { return null; }
}

function formatDisplayLine(entry, timeZone) {
  const n = normalizeLogEntry(entry);
  const c = formatClock(n.createdAt, timeZone);
  return c ? "[" + c + "] " + n.line : n.line;
}

// ── Color helpers ──

function statusColor(status) {
  const code = Number(status);
  if (code >= 500) return { badge: "bg-red-600/30 text-red-200 border-red-500/40", text: "text-red-300" };
  if (code >= 400) return { badge: "bg-amber-600/30 text-amber-200 border-amber-500/40", text: "text-amber-300" };
  if (code >= 200 && code < 300) return { badge: "bg-emerald-600/30 text-emerald-200 border-emerald-500/40", text: "text-emerald-300" };
  return { badge: "bg-slate-600/30 text-slate-200 border-slate-500/40", text: "text-slate-300" };
}

function isErrorStatus(status) { return Number(status) >= 400; }

// ── Error summary ──

function ErrorSummary({ entries }) {
  const errors = useMemo(() => {
    const groups = {};
    for (const entry of entries) {
      const r = entry.request;
      if (!r) continue;
      const status = Number(r.status);
      if (status < 400) continue;
      const key = status + "|" + (r.model || "?") + "|" + (r.provider || "?");
      if (!groups[key]) groups[key] = { status, model: r.model || "?", provider: r.provider || "?", count: 0, lastAt: null };
      groups[key].count++;
      if (!groups[key].lastAt || entry.createdAt > groups[key].lastAt) groups[key].lastAt = entry.createdAt;
    }
    return Object.values(groups).sort((a, b) => b.count - a.count);
  }, [entries]);

  if (!errors.length) return null;

  const totalErrors = errors.reduce((s, g) => s + g.count, 0);

  return (
    <div className="mb-3 flex flex-wrap items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
      <span className="text-xs font-bold text-red-300 uppercase tracking-wide pt-0.5 w-full">
        Lỗi ({totalErrors})
      </span>
      <div className="flex flex-wrap gap-2 w-full">
        {errors.slice(0, 8).map((g, i) => {
          const sc = statusColor(g.status);
          return (
            <div key={i} className={"flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] " + sc.badge}>
              <span className="font-bold tabular-nums">{g.status}</span>
              <span className="opacity-70">{g.provider.slice(0, 18)}/{g.model.slice(0, 16)}</span>
              <span className="tabular-nums opacity-80 font-semibold">x{g.count}</span>
            </div>
          );
        })}
        {errors.length > 8 && <span className="text-[11px] text-text-muted self-center">+{errors.length - 8} more</span>}
      </div>
    </div>
  );
}

// ── Log row (new compact design) ──

function RequestRow({ entry, timeZone }) {
  const { request } = normalizeLogEntry(entry);
  if (!request) {
    const line = formatDisplayLine(entry, timeZone);
    const isWarn = /\[WARN/.test(line);
    const isErr = /\[(ERROR|FAILED)\]/.test(line);
    return <div className={isErr ? "text-red-400" : isWarn ? "text-amber-400" : "text-green-400"}>{line}</div>;
  }

  const clock = formatClock(entry.createdAt, timeZone) || "--:--:--.---";
  const status = request.status ?? 200;
  const sc = statusColor(status);
  const tokens = request.tokens || {};
  const input = tokens.input_tokens ?? tokens.prompt_tokens ?? 0;
  const output = tokens.output_tokens ?? tokens.completion_tokens ?? 0;
  const provider = request.displayProvider || request.provider?.slice(0, 20) || "?";
  const model = request.model || "?";
  const combo = request.comboName;

  return (
    <div className="group flex items-center gap-1.5 py-[2px] hover:bg-white/[0.04] rounded px-1 -mx-1 text-[11px] font-mono leading-tight">
      <span className="text-text-muted tabular-nums w-[90px] flex-none">[{clock}]</span>
      <span className={"border px-1 rounded text-[10px] font-bold tabular-nums flex-none " + sc.badge}>
        {status}
      </span>
      <span className={Number(request.stream) ? "text-cyan-400" : "text-amber-400"}>{Number(request.stream) ? "⚡" : "⬇"}</span>
      {combo && <span className="text-indigo-300 font-semibold text-[10px]">[{combo}]</span>}
      <span className="text-sky-200 font-semibold">{provider}</span>
      <span className="text-text-muted">/</span>
      <span className="text-blue-200">{model.slice(0, 24)}</span>
      <span className="text-amber-300 tabular-nums ml-auto">{Math.round(request.duration || 0)}ms</span>
      {request.ttft > 0 && <span className="text-text-muted tabular-nums">T{Math.round(request.ttft)}</span>}
      <span className="text-emerald-300 tabular-nums">In:{input}</span>
      <span className="text-sky-300 tabular-nums">Out:{output}</span>
    </div>
  );
}

// ── Main component ──

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [timeZone] = useState(getBrowserTimeZone);
  const [tab, setTab] = useState("all"); // "all" | "errors"
  const [retentionMs, setRetentionMs] = useState(String(CONSOLE_LOG_CONFIG.defaultRetentionMs));
  const [savingRetention, setSavingRetention] = useState(false);
  const logRef = useRef(null);
  const autoScroll = useRef(true);

  // Load retention setting
  useEffect(() => {
    let alive = true;
    fetch("/api/settings", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(settings => { if (alive && settings) setRetentionMs(String(settings.consoleLogRetentionMs ?? CONSOLE_LOG_CONFIG.defaultRetentionMs)); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // SSE stream
  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");
    es.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "init" || msg.type === "sync") {
        setLogs((msg.logs || []).map(normalizeLogEntry).slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "line") {
        setLogs(cur => [...cur, normalizeLogEntry(msg.entry ?? msg.line)].slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "clear") {
        setLogs([]);
      }
    };
    return () => es.close();
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const handleScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    autoScroll.current = (scrollHeight - scrollTop - clientHeight) < 40;
  };

  // Filter to entries with requests for tabs
  const allEntries = useMemo(() => logs.filter(e => normalizeLogEntry(e).request), [logs]);
  const errorEntries = useMemo(() => allEntries.filter(e => isErrorStatus(e.request?.status)), [allEntries]);

  const displayed = tab === "errors" ? errorEntries : logs;

  const handleClear = async () => {
    try { await fetch("/api/translator/console-logs", { method: "DELETE" }); }
    catch { /* ignore */ }
  };

  const handleDownload = () => {
    const content = logs.map(e => formatDisplayLine(e, timeZone)).join("\n");
    const blob = new Blob([content ? content + "\n" : ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "routerdone-console-log-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
    document.body.appendChild(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
  };

  const handleRetentionChange = async (e) => {
    const next = e.target.value;
    setRetentionMs(next);
    setSavingRetention(true);
    try {
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consoleLogRetentionMs: Number(next) }) });
    } catch { /* ignore */ }
    finally { setSavingRetention(false); }
  };

  return (
    <div>
      <Card>
        {/* Top bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-1">
          <div className="flex gap-1">
            <button
              onClick={() => setTab("all")}
              className={"px-3 py-1 rounded text-xs font-semibold transition " + (tab === "all" ? "bg-surface-2 text-text-main" : "text-text-muted hover:text-text-main")}
            >
              Tất cả
            </button>
            <button
              onClick={() => setTab("errors")}
              className={"px-3 py-1 rounded text-xs font-semibold transition " + (tab === "errors" ? "bg-red-500/20 text-red-300" : "text-text-muted hover:text-red-300")}
            >
              Lỗi {errorEntries.length > 0 && <span className="tabular-nums ml-1">({errorEntries.length})</span>}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs font-medium text-text-muted">
              <span>Auto-delete</span>
              <select value={retentionMs} onChange={handleRetentionChange} disabled={savingRetention} className="h-7 rounded-[8px] border border-border bg-surface-2 px-3 text-xs font-semibold text-text-main outline-none disabled:opacity-50">
                {RETENTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <Button size="sm" variant="outline" icon="download" onClick={handleDownload} disabled={logs.length === 0}>Download</Button>
            <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>Clear</Button>
          </div>
        </div>

        {/* Error summary (only visible on All tab) */}
        {tab === "all" && <ErrorSummary entries={allEntries} />}

        {/* Log scroll */}
        <div ref={logRef} onScroll={handleScroll} className="bg-black rounded-b-lg p-3 text-xs font-mono overflow-auto" style={{ height: "calc(100vh - 240px)" }}>
          {displayed.length === 0 ? (
            <span className="text-text-muted">{tab === "errors" ? "Không có lỗi." : "No console logs yet."}</span>
          ) : (
            <div className="space-y-0.5">
              {displayed.map((entry, index) => <RequestRow key={index} entry={entry} timeZone={timeZone} />)}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
