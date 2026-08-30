// Durable FBA Shipment Plan PLANNING config API. Account-scoped (a user must hold account_permissions for the
// account; admins bypass). GET returns the saved planning settings + SKU horizon overrides + seller-warehouse rows
// for one account. POST writes ONE of: the account planning settings, a SKU horizon override (or its removal), or a
// seller-warehouse quantity (upsert/clear). NEVER touches DataDoe or any source-derived table; every write is audited.
//
// Warehouse writes (single + bulk) are TRUSTED-validated server-side against the account's OWN evidence (published
// fba-plan snapshot directory/catalog/marketplace scope + the account's existing warehouse identity + cross-account
// SKU ownership). The browser is never a boundary. Dependencies are injectable (DEFAULT_DEPS) so the handler is
// unit-testable without a database.
import {
  DashboardAccessError, getDashboardAccess, assertAccountAccess,
  getFbaPlanningConfig, setFbaPlanningSettings, setFbaSkuHorizonOverride, deleteFbaSkuHorizonOverride,
  recordFbaSellerWarehouse, recordFbaSellerWarehouseBulk, insertAuditLog,
  getLatestReportSnapshotHydrated, getSellerWarehouseRows, getWarehouseOwnershipConflicts,
} from "../lib/server/supabase.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";
import { buildWarehouseAuthority, validateWarehouseRow, validateWarehouseRows, newManualSkuCandidates } from "../lib/server/reports/warehouse-validation.js";

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { throw new DashboardAccessError("Request body must be valid JSON.", 400); } }
  return req.body;
}
const S = (v) => (v == null ? "" : String(v));
function orgFingerprint() {
  const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && S(c.apiKey).trim());
  if (!primary) throw new DashboardAccessError("No primary DataDoe connection is configured.", 500);
  return primary.organizationFingerprint || organizationFingerprint(primary.apiKey);
}
// Validate a horizon payload -> { horizonKind, horizonMonths|null, horizonDays|null } or throws 400.
function normHorizon(b) {
  const kind = S(b.horizonKind).trim();
  if (kind === "months") {
    const m = Number(b.horizonMonths);
    if (![1, 2, 3].includes(m)) throw new DashboardAccessError("horizonMonths must be 1, 2 or 3.", 400);
    return { horizonKind: "months", horizonMonths: m, horizonDays: null };
  }
  if (kind === "days") {
    const d = Number(b.horizonDays);
    if (!Number.isInteger(d) || d < 1 || d > 365) throw new DashboardAccessError("horizonDays must be a whole number 1-365.", 400);
    return { horizonKind: "days", horizonMonths: null, horizonDays: d };
  }
  throw new DashboardAccessError("horizonKind must be 'months' or 'days'.", 400);
}

// The real dependency wiring. Tests pass a mocked subset.
const DEFAULT_DEPS = {
  getDashboardAccess, assertAccountAccess,
  getFbaPlanningConfig, setFbaPlanningSettings, setFbaSkuHorizonOverride, deleteFbaSkuHorizonOverride,
  recordFbaSellerWarehouse, recordFbaSellerWarehouseBulk, insertAuditLog,
  getLatestReportSnapshotHydrated, getSellerWarehouseRows, getWarehouseOwnershipConflicts,
  orgFingerprint,
};

// Build the trusted warehouse-write authority for an account: the published snapshot evidence + the account's OWN
// existing warehouse identity + (for genuinely new manual SKUs among `rows`) cross-account ownership evidence.
// FAIL CLOSED: any failure loading the account's warehouse identity or the cross-account ownership authority stops the
// request with a typed, sanitized 503 BEFORE any write/audit RPC -- an unavailable/errored read is NEVER treated as
// "no identity" or "no ownership". A genuinely-absent snapshot (null, not an error) is handled downstream (rejected).
async function buildAuthority(deps, { organizationFingerprint: org, connectionId, accountId, rows }) {
  let snap, existingWarehouseRows;
  try {
    snap = await deps.getLatestReportSnapshotHydrated({ reportKey: "fba-plan", accountId });
    existingWarehouseRows = await deps.getSellerWarehouseRows({ organizationFingerprint: org, connectionId, accountId });
  } catch (_e) {
    throw new DashboardAccessError("Warehouse write authority is temporarily unavailable; please retry.", 503);
  }
  const authority = buildWarehouseAuthority(snap?.payload || null, { existingWarehouseRows });
  const candidates = newManualSkuCandidates(rows, authority); // [{ marketplace, sku }]
  if (candidates.length > 0) {
    try {
      authority.crossAccountOwnedKeys = await deps.getWarehouseOwnershipConflicts({ organizationFingerprint: org, accountId, pairs: candidates });
    } catch (_e) {
      throw new DashboardAccessError("Warehouse ownership check is temporarily unavailable; please retry.", 503);
    }
  } else {
    authority.crossAccountOwnedKeys = new Set();
  }
  return authority;
}

export async function handler(req, res, deps = DEFAULT_DEPS) {
  try {
    const access = await deps.getDashboardAccess(req);
    const accountId = S(req.method === "GET" ? req.query.accountId : bodyOf(req).accountId).trim();
    if (!accountId) { res.status(400).json({ error: "accountId is required." }); return; }
    deps.assertAccountAccess(access, [accountId]); // admins bypass; a member must hold this account
    const organization_fingerprint = deps.orgFingerprint();
    const connectionId = "primary";

    if (req.method === "GET") {
      const config = await deps.getFbaPlanningConfig({ organizationFingerprint: organization_fingerprint, connectionId, accountId });
      res.status(200).json(config);
      return;
    }

    if (req.method === "POST") {
      const body = bodyOf(req);
      const kind = S(body.kind).trim();

      if (kind === "settings") {
        const h = normHorizon(body);
        const method = S(body.forecastMethod).trim();
        if (!["three-month", "mtd", "higher", "weighted"].includes(method)) { res.status(400).json({ error: "invalid forecastMethod." }); return; }
        let weights = null;
        if (method === "weighted") {
          const w = Array.isArray(body.forecastWeights) ? body.forecastWeights.map(Number) : null;
          if (!w || w.length !== 4 || w.some((x) => !Number.isFinite(x) || x < 0)) { res.status(400).json({ error: "forecastWeights must be 4 nonnegative numbers." }); return; }
          const sum = Math.round(w.reduce((s, x) => s + x, 0) * 100) / 100;
          if (sum !== 100) { res.status(400).json({ error: `forecastWeights must total exactly 100 (got ${sum}).` }); return; }
          weights = w;
        }
        const safetyDays = Number(body.safetyDays);
        if (!Number.isInteger(safetyDays) || safetyDays < 0 || safetyDays > 365) { res.status(400).json({ error: "safetyDays must be a whole number 0-365." }); return; }
        const saved = await deps.setFbaPlanningSettings({ organizationFingerprint: organization_fingerprint, connectionId, accountId, ...h, forecastMethod: method, forecastWeights: weights, safetyDays, updatedBy: access.userId });
        await deps.insertAuditLog({ actorUserId: access.userId, action: "fba-plan.settings.updated", target: { accountId, horizon: h, forecastMethod: method, safetyDays } });
        res.status(200).json({ settings: saved });
        return;
      }

      if (kind === "sku-horizon") {
        const sku = S(body.sku).trim();
        if (!sku) { res.status(400).json({ error: "sku is required." }); return; }
        if (body.clear === true) {
          await deps.deleteFbaSkuHorizonOverride({ organizationFingerprint: organization_fingerprint, connectionId, accountId, sku });
          await deps.insertAuditLog({ actorUserId: access.userId, action: "fba-plan.sku-horizon.cleared", target: { accountId, sku } });
          res.status(200).json({ cleared: true, sku });
          return;
        }
        const h = normHorizon(body);
        const saved = await deps.setFbaSkuHorizonOverride({ organizationFingerprint: organization_fingerprint, connectionId, accountId, sku, ...h, updatedBy: access.userId });
        await deps.insertAuditLog({ actorUserId: access.userId, action: "fba-plan.sku-horizon.set", target: { accountId, sku, horizon: h } });
        res.status(200).json({ override: saved });
        return;
      }

      if (kind === "warehouse") {
        const marketplace = S(body.marketplace).trim();
        const sku = S(body.sku).trim();
        if (!marketplace || !sku) { res.status(400).json({ error: "marketplace and sku are required." }); return; }
        let qty = null;
        if (body.clear !== true) {
          qty = Number(body.qty);
          if (!Number.isInteger(qty) || qty < 0) { res.status(400).json({ error: "qty must be a nonnegative whole number of units." }); return; }
        }
        // Trusted server-side identity + isolation validation (a SET only; a CLEAR just removes the account's own row).
        // Same rules as bulk, so inline + bulk cannot diverge. The child ASIN is RESOLVED server-side (browser ignored).
        let childAsin = S(body.childAsin).trim();
        if (body.clear !== true) {
          const authority = await buildAuthority(deps, { organizationFingerprint: organization_fingerprint, connectionId, accountId, rows: [{ marketplace, sku, childAsin }] });
          const check = validateWarehouseRow({ marketplace, sku, childAsin }, authority);
          if (!check.ok) { res.status(400).json({ error: check.problems.join("; ") }); return; }
          childAsin = check.resolvedChildAsin;
        }
        const result = await deps.recordFbaSellerWarehouse({
          organizationFingerprint: organization_fingerprint, connectionId, accountId, marketplace, sku,
          childAsin, qty, note: S(body.note).slice(0, 500),
          updatedBy: access.userId, updatedByEmail: S(access.email), action: body.clear === true ? "clear" : "set",
        });
        await deps.insertAuditLog({ actorUserId: access.userId, action: body.clear === true ? "fba-plan.warehouse.cleared" : "fba-plan.warehouse.set", target: { accountId, marketplace, sku, qty } });
        res.status(200).json({ warehouse: result });
        return;
      }

      if (kind === "warehouse-bulk") {
        // Atomic multi-row apply. The browser preview is NOT trusted: every row is independently re-validated here
        // against the account's OWN evidence. ANY invalid row => zero writes AND zero audit (validated BEFORE the
        // single atomic RPC). Child ASINs are RESOLVED server-side.
        const rawRows = Array.isArray(body.rows) ? body.rows : null;
        if (!rawRows || rawRows.length === 0) { res.status(400).json({ error: "rows must be a non-empty array." }); return; }
        if (rawRows.length > 5000) { res.status(400).json({ error: "too many rows (max 5000 per import)." }); return; }
        const norm = [];
        for (const raw of rawRows) {
          const qty = Number(raw.qty);
          if (!Number.isInteger(qty) || qty < 0) { res.status(400).json({ error: `qty for ${S(raw.marketplace)} / ${S(raw.sku)} must be a nonnegative whole number.` }); return; }
          norm.push({ marketplace: S(raw.marketplace).trim(), sku: S(raw.sku).trim(), childAsin: S(raw.childAsin).trim(), qty, note: S(raw.note).slice(0, 500) });
        }
        const authority = await buildAuthority(deps, { organizationFingerprint: organization_fingerprint, connectionId, accountId, rows: norm });
        const checked = validateWarehouseRows(norm, authority);
        if (!checked.ok) {
          const first = checked.errors[0];
          res.status(400).json({ error: `${checked.errors.length} row(s) rejected; nothing was written. First: ${first.marketplace}/${first.sku} -- ${first.problems.join("; ")}`, rejected: checked.errors.length });
          return;
        }
        const rows = checked.valid.map((r) => ({ marketplace: r.marketplace, sku: r.sku, childAsin: r.childAsin || "", qty: r.qty, note: r.note || "" }));
        const result = await deps.recordFbaSellerWarehouseBulk({
          organizationFingerprint: organization_fingerprint, connectionId, accountId, rows,
          updatedBy: access.userId, updatedByEmail: S(access.email),
        });
        await deps.insertAuditLog({ actorUserId: access.userId, action: "fba-plan.warehouse.bulk", target: { accountId, applied: rows.length } });
        res.status(200).json({ bulk: result, applied: rows.length });
        return;
      }

      res.status(400).json({ error: "unknown POST kind (expected settings | sku-horizon | warehouse | warehouse-bulk)." });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    if (error instanceof DashboardAccessError) { res.status(error.status || 403).json({ error: error.message }); return; }
    res.status(500).json({ error: "FBA plan config request failed." });
  }
}

export default function (req, res) { return handler(req, res); }
