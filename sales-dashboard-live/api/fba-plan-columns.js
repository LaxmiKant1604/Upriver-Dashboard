// ACCOUNT-scoped FBA Shipment Plan column visibility. The saved show/hide layout is a SHARED, account-level display
// preference keyed by the COMPLETE trusted identity (organization_fingerprint, connection_id, account_id,
// report_key='fba-plan') -- NOT per user, and NEVER account_id alone. Any dashboard user authorized for the account
// reads AND updates the same layout; each account keeps its own. GET returns the account's hidden-column id list (or
// the default when unsaved); POST replaces it. The org fingerprint + connection are derived SERVER-SIDE (never
// trusted from the browser); accountId is required and account access is authorized BEFORE any read or write. Column
// ids are validated against the canonical registry (unknown / duplicate / malformed / locked -> 400, zero writes).
// Never touches DataDoe or any source-derived table. Dependencies are injectable (DEFAULT_DEPS) for offline tests.
import {
  DashboardAccessError, getDashboardAccess, assertAccountAccess,
  getFbaPlanAccountColumnPrefs, setFbaPlanAccountColumnPrefs, insertAuditLog,
} from "../lib/server/supabase.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";
import { validateHiddenColumns, PLAN_DEFAULT_HIDDEN_COLS } from "../lib/fba-plan-columns.js";

const S = (v) => (v == null ? "" : String(v));
const REPORT_KEY = "fba-plan";

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { throw new DashboardAccessError("Request body must be valid JSON.", 400); } }
  return req.body;
}
// The organization fingerprint + connection are ALWAYS server-derived from the configured primary DataDoe connection.
// The browser can never supply or retarget them, so an authorized-but-crafted request cannot reach another org/connection.
function orgFingerprint() {
  const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && S(c.apiKey).trim());
  if (!primary) throw new DashboardAccessError("No primary DataDoe connection is configured.", 500);
  return primary.organizationFingerprint || organizationFingerprint(primary.apiKey);
}

const DEFAULT_DEPS = {
  getDashboardAccess, assertAccountAccess, getFbaPlanAccountColumnPrefs, setFbaPlanAccountColumnPrefs, insertAuditLog, orgFingerprint,
};

export async function handler(req, res, deps = DEFAULT_DEPS) {
  try {
    const access = await deps.getDashboardAccess(req); // throws 401 when not authenticated
    if (!access?.userId) { res.status(401).json({ error: "Authentication required." }); return; }

    const accountId = S(req.method === "GET" ? req.query?.accountId : bodyOf(req).accountId).trim();
    if (!accountId) { res.status(400).json({ error: "accountId is required." }); return; }
    deps.assertAccountAccess(access, [accountId]); // admins bypass; a member must hold this account -> 403 otherwise

    // Server-bound identity. The browser may ONLY choose the accountId (then authorized above); org + connection are ours.
    const organization_fingerprint = deps.orgFingerprint();
    const connectionId = "primary";

    if (req.method === "GET") {
      const saved = await deps.getFbaPlanAccountColumnPrefs({ organizationFingerprint: organization_fingerprint, connectionId, accountId, reportKey: REPORT_KEY });
      // Echo the accountId so the client can reject a delayed response under a switched account. An unsaved account
      // returns updatedAt:null; the client then applies PLAN_DEFAULT_HIDDEN_COLS (we surface the default for clarity).
      res.status(200).json({ accountId, hiddenColumns: saved.hiddenColumns || [], updatedAt: saved.updatedAt || null, defaultHiddenColumns: [...PLAN_DEFAULT_HIDDEN_COLS] });
      return;
    }

    if (req.method === "POST") {
      const body = bodyOf(req);
      const check = validateHiddenColumns(body.hiddenColumns);
      if (!check.ok) { res.status(400).json({ error: check.error }); return; }
      const saved = await deps.setFbaPlanAccountColumnPrefs({
        organizationFingerprint: organization_fingerprint, connectionId, accountId, reportKey: REPORT_KEY,
        hiddenColumns: check.cleaned, updatedBy: access.userId, updatedByEmail: S(access.email),
      });
      // Best-effort audit (never blocks the save result).
      try { if (typeof deps.insertAuditLog === "function") await deps.insertAuditLog({ actorUserId: access.userId, action: "fba-plan.columns.set", target: { accountId, hidden: check.cleaned.length } }); } catch { /* ignore */ }
      res.status(200).json({ accountId, hiddenColumns: saved.hiddenColumns || check.cleaned, updatedAt: saved.updatedAt || null });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    if (error instanceof DashboardAccessError) { res.status(error.status || 403).json({ error: error.message }); return; }
    res.status(500).json({ error: "FBA plan column-prefs request failed." });
  }
}

export default function (req, res) { return handler(req, res); }
