/**
 * GET /api/engine — engine configuration status for the UI (ADR-004).
 * Exposes ONLY non-secret facts: the active mode, whether a cloud key is
 * configured (boolean), the configured cloud MODEL NAME (not the key),
 * and the auto route. The key itself never leaves the server process.
 */
import { NextResponse } from "next/server";
import { engineConfig, parseEngineMode } from "../../../lib/env";

export const runtime = "nodejs";

export async function GET() {
  const cfg = engineConfig();
  return NextResponse.json({
    mode: cfg.mode,
    env_mode: parseEngineMode(process.env.ALEX_ENGINE),
    cloud_available: cfg.cloud != null,
    cloud_model: cfg.cloud?.model ?? null,
    cloud_base_url_configured: !!process.env.ALEX_CLOUD_BASE_URL,
    auto_route: cfg.autoRoute,
    fallback_default: cfg.cloud?.fallback ?? "abort",
  });
}
