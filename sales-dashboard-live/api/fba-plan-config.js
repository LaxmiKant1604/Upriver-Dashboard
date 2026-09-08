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
  recordFbaWddWeights, recordFbaAsinLeadTime, recordFbaAsinLeadTimeBulk, getTrustedAccountBrands,
} from "../lib/server/supabase.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";
import { buildWarehouseAuthority, validateWarehouseRow, validateWarehouseRows, newManualSkuCandidates } from "../lib/server/reports/warehouse-validation.js";
import { resolveUserReportScope, BrandAccessError } from "../lib/server/report-authorization.js";
import { brandKey } from "../lib/server/reports/brand-membership.js";

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { throw new DashboardAccessError("Request body must be valid JSON.", 400); } }
  return req.body;
}
const S = (v) => (v == null ? "" : String(v));
// A REAL calendar date (YYYY-MM-DD AND an actual day; 2026-02-30 / 2026-13-01 rejected). Server twin of the client
// isRealCalendarDate (src/lib/fba-lead-time-import.js) so date validation is consistent on both sides. The DB ::date
// cast would also reject an impossible date, but validating here returns a clear 400 instead of a raw 500.
function isRealCalendarDate(v) {
  const str = S(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}
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
  recordFbaWddWeights, recordFbaAsinLeadTime, recordFbaAsinLeadTimeBulk, getTrustedAccountBrands,
  resolveUserReportScope,
  orgFingerprint,
};

// ADDITIVE WDD / lead-time authorization: the FBA Shipment Plan (report `fba-plan`) is NOT available to brand-restricted
// (SELECTED_BRANDS) users -- resolveUserReportScope throws a 403 for them on this capability. The new WDD-weights +
// lead-time operations apply the EXACT SAME gate (never broadening access): an admin / ALL_BRANDS user is unrestricted;
// a brand-restricted user is denied, so they can never read or edit another brand's WDD settings or ASIN planning
// values. Returns true when allowed, false when the user is brand-restricted (used to hide the new GET fields).
async function fbaPlanCapabilityAllowed(deps, access, accountId) {
  if (typeof deps.resolveUserReportScope !== "function") return true; // gate not wired (never in prod; only a partial test mock)
  try {
    await deps.resolveUserReportScope({ access, requestedAccountId: accountId, requestedBrand: "", action: "fba-plan", getTrustedBrands: deps.getTrustedAccountBrands });
    return true;
  } catch (e) {
    if (e instanceof BrandAccessError) return false;
    throw e;
  }
}

// The account's TRUSTED canonical brand keys (membership) for validating a WDD brand_key write. '' (account-default) is
// always allowed. Fails closed: an unavailable read throws a 503 rather than accepting an unverified brand.
async function accountTrustedBrandKeys(deps, accountId) {
  let names;
  try { names = await deps.getTrustedAccountBrands({ accountId }); }
  catch (_e) { throw new DashboardAccessError("Brand membership is temporarily unavailable; please retry.", 503); }
  const set = new Set();
  for (const n of Array.isArray(names) ? names : []) { const k = brandKey(n && (n.brand ?? n.name ?? n)); if (k) set.add(k); }
  return set;
}

// The account's catalog child-ASIN authority (for lead-time ASIN-ownership validation), from the published fba-plan
// snapshot. Fails closed: a missing/errored snapshot throws so a write can never target an unverified ASIN.
async function accountAsinAuthority(deps, accountId) {
  let snap;
  try { snap = await deps.getLatestReportSnapshotHydrated({ reportKey: "fba-plan", accountId }); }
  catch (_e) { throw new DashboardAccessError("Account ASIN evidence is temporarily unavailable; please retry.", 503); }
  const authority = buildWarehouseAuthority(snap?.payload || null, { existingWarehouseRows: [] });
  return authority.catalogAsins instanceof Set ? authority.catalogAsins : new Set();
}

// Server-side WDD-weight validation (mirrors src/lib/fba-wdd.js#validateWddWeights): each 0..100, total EXACTLY 100.
function normWddWeights(b) {
  const w7 = Number(b.w7), w30 = Number(b.w30), w60 = Number(b.w60);
  if ([w7, w30, w60].some((x) => !Number.isFinite(x) || x < 0 || x > 100)) return { error: "each weight must be a number between 0 and 100." };
  const total = Math.round((w7 + w30 + w60) * 100) / 100;
  if (total > 100) return { error: `weights total ${total}; they must total exactly 100.` };
  if (total < 100) return { error: "Weights must total 100%." };
  return { w7, w30, w60 };
}

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
    // F2: the FBA Shipment Plan report is DENY_FOR_BRAND_RESTRICTED_USERS, so its configuration endpoint must be
    // denied to the SAME users -- CONSISTENTLY across GET and every POST kind (previously only the base GET stripped
    // wddWeights/leadTimes and only the wdd/lead-time writes gated, leaving settings/sku-horizon/warehouse readable
    // and writable by a brand-restricted account member). Admin / ALL_BRANDS pass unchanged; a SELECTED_BRANDS user
    // gets 403 with no configuration returned and no mutation. This closes the read+write brand-scope gap.
    if (!(await fbaPlanCapabilityAllowed(deps, access, accountId))) {
      res.status(403).json({ error: "This report is not available for your brand-limited access." });
      return;
    }
    const organization_fingerprint = deps.orgFingerprint();
    const connectionId = "primary";

    if (req.method === "GET") {
      const config = await deps.getFbaPlanningConfig({ organizationFingerprint: organization_fingerprint, connectionId, accountId });
      // The ADDITIVE WDD-weights + lead-time config is gated on the fba-plan capability (identical to the report). A
      // brand-restricted user keeps the EXISTING planner config byte-identical but never receives the new rows.
      const allowNew = await fbaPlanCapabilityAllowed(deps, access, accountId);
      if (!allowNew) { config.wddWeights = []; config.leadTimes = []; }
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

      // ================= ADDITIVE (Migration 22): WDD weights + per-ASIN lead-time / reorder inputs =================
      // All three apply the SAME capability gate as the fba-plan report: a brand-restricted user is denied 403 (never
      // broadening access), so they can never read or edit another brand's WDD settings or ASIN planning values.
      if (kind === "wdd-weights" || kind === "lead-time" || kind === "lead-time-bulk") {
        if (!(await fbaPlanCapabilityAllowed(deps, access, accountId))) {
          res.status(403).json({ error: "The FBA Shipment Plan is not available for your brand-limited access." });
          return;
        }

        if (kind === "wdd-weights") {
          const bkRaw = S(body.brandKey).trim();
          const bk = bkRaw ? brandKey(bkRaw) : ""; // '' == the account-default record (unmapped ASINs)
          if (body.clear === true) {
            await deps.recordFbaWddWeights({ organizationFingerprint: organization_fingerprint, connectionId, accountId, brandKey: bk, action: "clear", updatedBy: access.userId });
            await deps.insertAuditLog({ actorUserId: access.userId, action: "fba-plan.wdd-weights.cleared", target: { accountId, brandKey: bk } });
            res.status(200).json({ cleared: true, brandKey: bk });
            return;
          }
          const w = normWddWeights(body);
          if (w.error) { res.status(400).json({ error: w.error }); return; }
          if (bk) {
            // A NAMED brand must be a TRUSTED brand of this account (canonical-brand ownership); '' is always allowed.
            const trusted = await accountTrustedBrandKeys(deps, accountId);
            if (!trusted.has(bk)) { res.status(400).json({ error: "unknown brand for this account." }); return; }
          }
          const saved = await deps.recordFbaWddWeights({ organizationFingerprint: organization_fingerprint, connectionId, accountId, brandKey: bk, w7: w.w7, w30: w.w30, w60: w.w60, action: "set", updatedBy: access.userId });
          await deps.insertAuditLog({ actorUserId: access.userId, action: "fba-plan.wdd-weights.set", target: { accountId, brandKey: bk, weights: [w.w7, w.w30, w.w60] } });
          res.status(200).json({ weights: saved });
          return;
        }

        const dayVal = (v) => { if (v == null || v === "") return null; const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 3650) return NaN; return n; };

        if (kind === "lead-time") {
          const childAsin = S(body.childAsin).trim().toUpperCase();
          if (!childAsin) { res.status(400).json({ error: "childAsin is required." }); return; }
          const action = S(body.action).trim() || "set";
          if (!["set", "start", "clear"].includes(action)) { res.status(400).json({ error: "action must be set, start or clear." }); return; }
          if (action === "clear") {
            await deps.recordFbaAsinLeadTime({ organizationFingerprint: organization_fingerprint, connectionId, accountId, childAsin, action: "clear", updatedBy: access.userId, updatedByEmail: S(access.email) });
            await deps.insertAuditLog({ actorUserId: access.userId, action: "fba-plan.lead-time.cleared", target: { accountId, childAsin } });
            res.status(200).json({ cleared: true, childAsin });
            return;
          }
          // ASIN ownership: the child ASIN must be in this account's catalog (server-trusted, browser never a boundary).
          const asins = await accountAsinAuthority(deps, accountId);
          if (asins.size === 0) { res.status(400).json({ error: "no published FBA plan for this account yet; refresh the plan before saving lead times." }); return; }
          if (!asins.has(childAsin)) { res.status(400).json({ error: `ASIN ${childAsin} is not in this account's catalog.` }); return; }
          const production = dayVal(body.production), shipping = dayVal(body.shipping), awd = dayVal(body.awd), safety = dayVal(body.safety);
          if ([production, shipping, awd, safety].some((x) => Number.isNaN(x))) { res.status(400).json({ error: "each lead-time day must be a whole number 0-3650 or blank." }); return; }
          let startedDate = null;
          if (action === "start") {
            startedDate = S(body.startedDate).trim();
            if (!isRealCalendarDate(startedDate)) { res.status(400).json({ error: "startedDate must be a real date (YYYY-MM-DD, marketplace-local) to start a countdown." }); return; }
            if (production == null || shipping == null || awd == null) { res.status(400).json({ error: "production, shipping and AWD transit are required before starting a countdown." }); return; }
          }
          const saved = await deps.recordFbaAsinLeadTime({ organizationFingerprint: organization_fingerprint, connectionId, accountId, childAsin, production, shipping, awd, safety, note: S(body.note).slice(0, 500), action, startedDate, updatedBy: access.userId, updatedByEmail: S(access.email) });
          await deps.insertAuditLog({ actorUserId: access.userId, action: `fba-plan.lead-time.${action}`, target: { accountId, childAsin } });
          res.status(200).json({ leadTime: saved });
          return;
        }

        if (kind === "lead-time-bulk") {
          // Atomic multi-ASIN import. The browser preview is NOT trusted: every ASIN is re-validated for account
          // ownership here; ANY invalid/duplicate row => zero writes AND zero audit (validated BEFORE the atomic RPC).
          const rawRows = Array.isArray(body.rows) ? body.rows : null;
          if (!rawRows || rawRows.length === 0) { res.status(400).json({ error: "rows must be a non-empty array." }); return; }
          if (rawRows.length > 5000) { res.status(400).json({ error: "too many rows (max 5000 per import)." }); return; }
          const asins = await accountAsinAuthority(deps, accountId);
          if (asins.size === 0) { res.status(400).json({ error: "no published FBA plan for this account yet; refresh the plan before importing lead times." }); return; }
          const seen = new Set();
          const norm = [];
          for (const raw of rawRows) {
            const childAsin = S(raw.childAsin).trim().toUpperCase();
            if (!childAsin) { res.status(400).json({ error: "a row has a blank childAsin; nothing was written." }); return; }
            if (!asins.has(childAsin)) { res.status(400).json({ error: `ASIN ${childAsin} is not in this account's catalog; nothing was written.` }); return; }
            if (seen.has(childAsin)) { res.status(400).json({ error: `duplicate ASIN ${childAsin} in this import; nothing was written.` }); return; }
            seen.add(childAsin);
            const production = dayVal(raw.production), shipping = dayVal(raw.shipping), awd = dayVal(raw.awd), safety = dayVal(raw.safety);
            if ([production, shipping, awd, safety].some((x) => Number.isNaN(x))) { res.status(400).json({ error: `a day value for ${childAsin} is invalid; nothing was written.` }); return; }
            let inboundEta = S(raw.inboundEta).trim();
            if (inboundEta && !isRealCalendarDate(inboundEta)) { res.status(400).json({ error: `inbound_eta for ${childAsin} must be a real date (YYYY-MM-DD) or blank; nothing was written.` }); return; }
            if (!inboundEta) inboundEta = null;
            // Notes are preserved through the bulk import (parser -> API -> RPC -> reload); a blank note clears (migration 23).
            const note = S(raw.note).slice(0, 500);
            norm.push({ childAsin, production, shipping, awd, safety, inboundEta, note });
          }
          const result = await deps.recordFbaAsinLeadTimeBulk({ organizationFingerprint: organization_fingerprint, connectionId, accountId, rows: norm, updatedBy: access.userId, updatedByEmail: S(access.email) });
          await deps.insertAuditLog({ actorUserId: access.userId, action: "fba-plan.lead-time.bulk", target: { accountId, applied: norm.length } });
          res.status(200).json({ bulk: result, applied: norm.length });
          return;
        }
      }

      res.status(400).json({ error: "unknown POST kind (expected settings | sku-horizon | warehouse | warehouse-bulk | wdd-weights | lead-time | lead-time-bulk)." });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    if (error instanceof DashboardAccessError) { res.status(error.status || 403).json({ error: error.message }); return; }
    res.status(500).json({ error: "FBA plan config request failed." });
  }
}

export default function (req, res) { return handler(req, res); }
