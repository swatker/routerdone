import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { setConsoleLogRetentionMs } from "@/lib/consoleLogBuffer";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, ...safeSettings } = settings;
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    if (Object.prototype.hasOwnProperty.call(body, "consoleLogRetentionMs")) {
      const value = Number(body.consoleLogRetentionMs);
      if (!Number.isFinite(value) || value < 0 || value > 24 * 60 * 60 * 1000) {
        return NextResponse.json({ error: "Invalid console log retention" }, { status: 400 });
      }
      body.consoleLogRetentionMs = value;
    }

    if (Object.prototype.hasOwnProperty.call(body, "routerDoneContextBackup")) {
      const cfg = body.routerDoneContextBackup;
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return NextResponse.json({ error: "Invalid context backup settings" }, { status: 400 });
      }
      const threshold = Number(cfg.thresholdTokens ?? 45000);
      const retain = Number(cfg.retainRecentTurns ?? 3);
      if (typeof cfg.enabled !== "boolean" || !Number.isSafeInteger(threshold) || threshold < 36000 || !Number.isInteger(retain) || retain < 1 || retain > 6 || (cfg.codexConnectionId !== undefined && typeof cfg.codexConnectionId !== "string")) {
        return NextResponse.json({ error: "Invalid context backup settings" }, { status: 400 });
      }
      body.routerDoneContextBackup = {
        enabled: cfg.enabled,
        thresholdTokens: threshold,
        retainRecentTurns: retain,
        codexConnectionId: cfg.codexConnectionId || "",
      };
    }

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First time setting password, no current password needed
        // Allow empty currentPassword or default "123456"
        if (body.currentPassword && body.currentPassword !== "123456") {
           return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    // Validate modelRedirects is a plain object of string -> string
    if (Object.prototype.hasOwnProperty.call(body, "modelRedirects")) {
      const redirects = body.modelRedirects;
      if (redirects !== null && typeof redirects === "object" && !Array.isArray(redirects)) {
        const cleaned = {};
        for (const [key, val] of Object.entries(redirects)) {
          if (typeof key === "string" && typeof val === "string" && key.trim() && val.trim()) {
            cleaned[key.trim()] = val.trim();
          }
        }
        body.modelRedirects = cleaned;
      } else {
        delete body.modelRedirects;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "consoleLogRetentionMs")) {
      setConsoleLogRetentionMs(settings.consoleLogRetentionMs);
    }

    const { password, ...safeSettings } = settings;
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
