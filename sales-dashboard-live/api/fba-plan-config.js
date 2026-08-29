// Durable FBA Shipment Plan PLANNING config API. Account-scoped (a user must hold account_permissions for the
// account; admins bypass). GET returns the saved planning settings + SKU horizon overrides + seller-warehouse rows
// for one account. POST writes ONE of: the account planning settings, a SKU horizon override (or its removal), or a
// seller-warehouse quantity (upsert/clear). NEVER touches DataDoe or any source-derived table; every write is audited.
import {
  DashboardAccessError, getDashboardAccess, assertAccountAccess,
  getFbaPlanningConfig, setFbaPlanningSettings, setFbaSkuHorizonOverride, deleteFbaSkuHorizonOverride,
  recordFbaSellerWarehouse, insertAuditLog,
} from "../lib/server/supabase.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";

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

export default async function handler(req, res) {
  try {
    const access = await getDashboardAccess(req);
    const accountId = S(req.method === "GET" ? req.query.accountId : bodyOf(req).accountId).trim();
    if (!accountId) { res.status(400).json({ error: "accountId is required." }); return; }
    assertAccountAccess(access, [accountId]); // admins bypass; a member must hold this account
    const organization_fingerprint = orgFingerprint();
    const connectionId = "primary";

    if (req.method === "GET") {
      const config = await getFbaPlanningConfig({ organizationFingerprint: organization_fingerprint, connectionId, accountId });
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
        const saved = await setFbaPlanningSettings({ organizationFingerprint: organization_fingerprint, connectionId, accountId, ...h, forecastMethod: method, forecastWeights: weights, safetyDays, updatedBy: access.userId });
        await insertAuditLog({ actorUserId: access.userId, action: "fba-plan.settings.updated", target: { accountId, horizon: h, forecastMethod: method, safetyDays } });
        res.status(200).json({ settings: saved });
        return;
      }

      if (kind === "sku-horizon") {
        const sku = S(body.sku).trim();
        if (!sku) { res.status(400).json({ error: "sku is required." }); return; }
        if (body.clear === true) {
          await deleteFbaSkuHorizonOverride({ organizationFingerprint: organization_fingerprint, connectionId, accountId, sku });
          await insertAuditLog({ actorUserId: access.userId, action: "fba-plan.sku-horizon.cleared", target: { accountId, sku } });
          res.status(200).json({ cleared: true, sku });
          return;
        }
        const h = normHorizon(body);
        const saved = await setFbaSkuHorizonOverride({ organizationFingerprint: organization_fingerprint, connectionId, accountId, sku, ...h, updatedBy: access.userId });
        await insertAuditLog({ actorUserId: access.userId, action: "fba-plan.sku-horizon.set", target: { accountId, sku, horizon: h } });
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
        const result = await recordFbaSellerWarehouse({
          organizationFingerprint: organization_fingerprint, connectionId, accountId, marketplace, sku,
          childAsin: S(body.childAsin).trim(), qty, note: S(body.note).slice(0, 500),
          updatedBy: access.userId, updatedByEmail: S(access.email), action: body.clear === true ? "clear" : "set",
        });
        await insertAuditLog({ actorUserId: access.userId, action: body.clear === true ? "fba-plan.warehouse.cleared" : "fba-plan.warehouse.set", target: { accountId, marketplace, sku, qty } });
        res.status(200).json({ warehouse: result });
        return;
      }

      res.status(400).json({ error: "unknown POST kind (expected settings | sku-horizon | warehouse)." });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    if (error instanceof DashboardAccessError) { res.status(error.status || 403).json({ error: error.message }); return; }
    res.status(500).json({ error: "FBA plan config request failed." });
  }
}
