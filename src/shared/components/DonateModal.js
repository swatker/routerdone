"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { GITHUB_CONFIG } from "@/shared/constants/config";

function formatVnd(amount) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(amount);
}

function buildVietQrUrl(channel, amount) {
  const query = new URLSearchParams({
    accountName: channel.accountName || "",
    addInfo: channel.content || "",
  });

  if (amount) query.set("amount", String(amount));

  return `https://img.vietqr.io/image/${channel.bankBin}-${channel.accountNo}-compact2.png?${query.toString()}`;
}

export default function DonateModal({ isOpen, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const modalRef = useRef(null);

  useEffect(() => {
    if (!isOpen || data) return;
    setLoading(true);
    setError("");
    fetch(GITHUB_CONFIG.donateUrl, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [isOpen, data]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="donate-modal-title"
        className="relative flex max-h-[88vh] w-full max-w-[860px] flex-col overflow-hidden rounded-xl border border-black/10 bg-surface shadow-2xl animate-in fade-in zoom-in-95 duration-200 dark:border-white/10"
      >
        <div className="flex items-center justify-between border-b border-black/5 px-4 py-3 dark:border-white/5">
          <h2 id="donate-modal-title" className="flex min-w-0 items-center gap-3 text-lg font-semibold text-text-main">
            <span className="material-symbols-outlined flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-pink-500/10 text-[21px] text-pink-500">
              volunteer_activism
            </span>
            <span className="truncate">
              {data?.title || "Ủng hộ RouterDone"}
            </span>
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Đóng"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {loading && (
            <div className="flex items-center justify-center py-10 text-text-muted">
              <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
              Loading...
            </div>
          )}
          {error && (
            <div className="text-red-500 py-4">Failed to load donate info: {error}</div>
          )}
          {!loading && !error && data && (
            <>
              {data.message && (
                <p className="mx-auto mb-5 max-w-2xl text-center text-sm leading-6 text-text-muted">
                  {data.message}
                </p>
              )}
              <div
                className={
                  data.channels?.length === 1
                    ? "mx-auto grid w-full max-w-[420px] grid-cols-1 items-start gap-4"
                    : "grid grid-cols-1 items-start gap-4 md:grid-cols-[minmax(0,1.12fr)_minmax(260px,0.88fr)]"
                }
              >
                {data.channels?.map((ch) => (
                  <DonateChannelCard key={ch.id} channel={ch} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function DonateChannelCard({ channel }) {
  const { label, description, icon, color, url, qr } = channel;
  const [copied, setCopied] = useState("");
  const [selectedAmount, setSelectedAmount] = useState(channel.defaultAmount || channel.amounts?.[0] || 0);
  const isVietQr = channel.type === "vietqr";
  const qrUrl = isVietQr ? buildVietQrUrl(channel, selectedAmount) : qr;

  const copyValue = async (key, value) => {
    if (!value) return;
    await navigator.clipboard?.writeText(String(value));
    setCopied(key);
    window.setTimeout(() => setCopied(""), 1200);
  };

  const content = (
    <>
      <div className="mb-4 flex w-full items-start gap-3">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${color}20`, color }}
        >
          <span className="material-symbols-outlined text-[25px]">{icon}</span>
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-base font-semibold leading-6 text-text-main">{label}</div>
          {description && (
            <div className="text-sm leading-5 text-text-muted">{description}</div>
          )}
        </div>
      </div>
      {qrUrl && (
        <img
          src={qrUrl}
          alt={`${label} QR`}
          className="mx-auto aspect-square w-full max-w-[210px] rounded-lg bg-white object-contain p-1 shadow-sm"
        />
      )}
      {isVietQr && (
        <div className="mt-4 w-full space-y-3">
          {channel.amounts?.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {channel.amounts.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => setSelectedAmount(amount)}
                  className={`min-h-8 whitespace-nowrap rounded-lg border px-2 py-1.5 text-xs font-semibold transition-colors ${
                    selectedAmount === amount
                      ? "border-transparent text-white"
                      : "border-black/10 dark:border-white/10 text-text-muted hover:text-text-main"
                  }`}
                  style={selectedAmount === amount ? { backgroundColor: color } : undefined}
                >
                  {formatVnd(amount).replace("₫", "đ")}
                </button>
              ))}
            </div>
          )}
          <div className="space-y-1.5 text-xs">
            <CopyRow
              label="Ngân hàng"
              value={channel.bankName}
              copied={copied === "bank"}
              onCopy={() => copyValue("bank", channel.bankName)}
            />
            <CopyRow
              label="Số TK"
              value={channel.accountNo}
              copied={copied === "account"}
              onCopy={() => copyValue("account", channel.accountNo)}
            />
            <CopyRow
              label="Chủ TK"
              value={channel.accountName}
              copied={copied === "name"}
              onCopy={() => copyValue("name", channel.accountName)}
            />
            <CopyRow
              label="Nội dung"
              value={channel.content}
              copied={copied === "content"}
              onCopy={() => copyValue("content", channel.content)}
            />
          </div>
        </div>
      )}
      {!isVietQr && (
        <div className="w-full space-y-3">
          {channel.account && (
            <CopyRow
              label="Tài khoản"
              value={channel.account}
              copied={copied === "account"}
              onCopy={() => copyValue("account", channel.account)}
            />
          )}
          {channel.note && (
            <p className="rounded-lg bg-black/[0.03] px-3 py-2 text-sm leading-5 text-text-muted dark:bg-white/[0.04]">
              {channel.note}
            </p>
          )}
        </div>
      )}
    </>
  );

  return (
    <div className="flex w-full flex-col items-center rounded-xl border border-black/10 bg-surface/60 p-4 transition-colors hover:border-pink-500/40 dark:border-white/10 sm:p-5">
      {content}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: color }}
        >
          Mở
          <span className="material-symbols-outlined text-[16px]">open_in_new</span>
        </a>
      )}
    </div>
  );
}

function CopyRow({ label, value, copied, onCopy }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      className="grid w-full grid-cols-[82px_minmax(0,1fr)_20px] items-center gap-2 rounded-lg bg-black/[0.03] px-3 py-2 text-left hover:bg-black/[0.06] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
    >
      <span className="text-text-muted">{label}</span>
      <span className="min-w-0 break-words font-semibold leading-snug text-text-main">{value}</span>
      <span className="material-symbols-outlined justify-self-end text-[15px] text-text-muted">
        {copied ? "check" : "content_copy"}
      </span>
    </button>
  );
}

DonateModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
