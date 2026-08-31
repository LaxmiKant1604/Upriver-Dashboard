// SKU MOVEMENT per-USER preferences: the column-visibility set (hidden column ids) + the chosen recent-window N.
// USER-scoped (never account-scoped): the userId is taken from the Bearer token (getDashboardAccess), never the body,
// so a user can only read/write their OWN prefs. Reuses the reviewed fba_plan_column_prefs table under report_key
// 'sku-movement' (hidden_columns) plus its additive `prefs` jsonb (recentDays). Fail-soft: a schema/API outage
// degrades to defaults on read; the frontend keeps its local last-known preference. No DataDoe. Injectable deps.
import {
  DashboardAccessError, getDashboardAccess, getFbaPlanColumnPrefs, setFbaPlanColumnPrefs,
} from "../lib/server/supabase.js";
import { clampRecentDays, DEFAULT_RECENT_DAYS } from "../lib/sku-movement-window.js";

const REPORT_KEY = "sku-movement";
const S = (v) => (v == null ? "" : String(v));
function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { throw new DashboardAccessError("Request body must be valid JSON.", 400); } }
  return req.body;
}
const DEFAULT_DEPS = { getDashboardAccess, getFbaPlanColumnPrefs, setFbaPlanColumnPrefs };

export async function handler(req, res, deps = DEFAULT_DEPS) {
  try {
    const access = await deps.getDashboardAccess(req);
    if (!access.userId) { res.status(401).json({ error: "Sign in to save SKU Movement preferences." }); return; }

    if (req.method === "GET") {
      const p = await deps.getFbaPlanColumnPrefs({ userId: access.userId, reportKey: REPORT_KEY });
      const recentDays = p && p.prefs && p.prefs.recentDays != null ? clampRecentDays(p.prefs.recentDays) : DEFAULT_RECENT_DAYS;
      res.status(200).json({ hiddenColumns: p.hiddenColumns || [], recentDays, updatedAt: p.updatedAt || null });
      return;
    }

    if (req.method === "POST") {
      const body = bodyOf(req);
      // Read the current row so a partial update (only columns, or only N) never clobbers the other field.
      const cur = await deps.getFbaPlanColumnPrefs({ userId: access.userId, reportKey: REPORT_KEY }).catch(() => ({ hiddenColumns: [], prefs: {} }));
      const hiddenColumns = Array.isArray(body.hiddenColumns) ? body.hiddenColumns.map(S) : (cur.hiddenColumns || []);
      const prefs = { ...(cur.prefs || {}) };
      if (body.recentDays != null) prefs.recentDays = clampRecentDays(body.recentDays);
      const saved = await deps.setFbaPlanColumnPrefs({ userId: access.userId, reportKey: REPORT_KEY, hiddenColumns, prefs });
      const recentDays = saved && saved.prefs && saved.prefs.recentDays != null ? clampRecentDays(saved.prefs.recentDays) : DEFAULT_RECENT_DAYS;
      res.status(200).json({ hiddenColumns: saved.hiddenColumns || [], recentDays });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    if (error instanceof DashboardAccessError) { res.status(error.status || 403).json({ error: error.message }); return; }
    res.status(500).json({ error: "SKU Movement preferences request failed." });
  }
}

export default function (req, res) { return handler(req, res); }
