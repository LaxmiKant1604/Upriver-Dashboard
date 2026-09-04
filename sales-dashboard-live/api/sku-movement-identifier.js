// SKU MOVEMENT manual IDENTIFIER API. Account-scoped (a user must hold account_permissions for the account; admins
// bypass). GET returns the account's saved identifiers (a { CHILD_ASIN: identifier } map). POST writes ONE of: a
// single identifier (set/clear) or a bulk apply (all-or-nothing). NEVER touches DataDoe or any source-derived table;
// every write is audited. The organization fingerprint and the marketplace are derived SERVER-SIDE (never trusted
// from the browser); every ASIN is validated to belong to THIS account's SKU Movement evidence before any write, so
// unknown/cross-account ASINs are rejected. Dependencies are injectable (DEFAULT_DEPS) for offline handler tests.
import {
  DashboardAccessError, getDashboardAccess, assertAccountAccess,
  getSkuMovementIdentifiers, recordSkuMovementIdentifier, recordSkuMovementIdentifierBulk,
  getLatestReportSnapshotForScope, getAccountDirectorySnapshotAccounts, insertAuditLog,
  getTrustedAccountBrands,
} from "../lib/server/supabase.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";
// F4: the sku-movement report is BRAND_DERIVABLE_FROM_ASIN_SKU (rows carry `brand` and are projected to the caller's
// permitted brands on read). The identifier endpoint must apply the SAME brand scope to its reads and writes, using
// the ONE central resolver -- never a browser-supplied brand.
import { resolveUserReportScope, BrandAccessError } from "../lib/server/report-authorization.js";
import { brandKey } from "../lib/server/reports/brand-membership.js";

const S = (v) => (v == null ? "" : String(v));
const SKU_MOVEMENT_VERSION = "sku-movement/v2";
const MAX_IDENT = 120;

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { throw new DashboardAccessError("Request body must be valid JSON.", 400); } }
  return req.body;
}
function orgFingerprint() {
  const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && S(c.apiKey).trim());
  if (!primary) throw new DashboardAccessError("No primary DataDoe connection is configured.", 500);
  return primary.organizationFingerprint || organizationFingerprint(primary.apiKey);
}
// An identifier is CLEAN when it trims to <=120 chars with NO control characters (the same rule the RPC enforces).
function cleanIdentifier(v) {
  const t = S(v).trim();
  if (t.length > MAX_IDENT) return { ok: false, reason: `identifier too long (max ${MAX_IDENT})` };
  for (let i = 0; i < t.length; i += 1) { const code = t.charCodeAt(i); if (code < 32 || code === 127) return { ok: false, reason: "identifier contains control characters" }; }
  return { ok: true, value: t };
}

const DEFAULT_DEPS = {
  getDashboardAccess, assertAccountAccess,
  getSkuMovementIdentifiers, recordSkuMovementIdentifier, recordSkuMovementIdentifierBulk,
  getLatestReportSnapshotForScope, getAccountDirectorySnapshotAccounts, insertAuditLog, orgFingerprint,
  resolveUserReportScope, getTrustedAccountBrands,
};

// The account's canonical marketplace (server-derived from the account-directory snapshot; NEVER from the browser).
async function accountMarketplace(deps, accountId) {
  let accounts;
  try { accounts = await deps.getAccountDirectorySnapshotAccounts(); } catch (_e) { throw new DashboardAccessError("Account directory is temporarily unavailable; please retry.", 503); }
  const a = (Array.isArray(accounts) ? accounts : []).find((x) => String(x.accountId) === String(accountId));
  const mkt = S(a && a.country).trim().toUpperCase();
  if (!mkt) throw new DashboardAccessError("This account has no resolved marketplace.", 400);
  return mkt;
}

// The caller's brand scope for THIS account, via the ONE central resolver (never a browser-supplied brand). Admin /
// ALL_BRANDS -> { restricted:false }; SELECTED_BRANDS -> { restricted:true, permitted:<canonical brand keys> }. Fails
// closed: a BrandAccessError (e.g. no permitted brands) -> 403; any other resolver error -> 503. The gate-not-wired
// path (a partial test mock without resolveUserReportScope) is treated as unrestricted, byte-identical to before.
async function resolveCallerScope(deps, { access, accountId }) {
  if (typeof deps.resolveUserReportScope !== "function") return { restricted: false, permitted: new Set() };
  try {
    const scope = await deps.resolveUserReportScope({ access, requestedAccountId: accountId, requestedBrand: "", action: "sku-movement", getTrustedBrands: deps.getTrustedAccountBrands });
    return { restricted: !!scope.restricted, permitted: scope.permittedBrandKeys instanceof Set ? scope.permittedBrandKeys : new Set(scope.permittedBrandKeys || []) };
  } catch (e) {
    if (e instanceof BrandAccessError) throw new DashboardAccessError(e.message, e.status || 403);
    throw new DashboardAccessError("Brand scope is temporarily unavailable; please retry.", 503);
  }
}

// The set of ASINs the CALLER may act on for this account: the account's SKU Movement evidence, restricted to the
// caller's permitted brands when they are brand-limited (unrestricted callers get every account ASIN, identical to
// the prior all-brand authority). An ASIN not in this set is unknown / cross-account / cross-brand and a write is
// rejected. FAIL CLOSED: a load error -> 503; a genuinely-absent snapshot -> 400 (nothing to identify yet).
async function permittedAsinAuthority(deps, { accountId, scope }) {
  let snap;
  try { snap = await deps.getLatestReportSnapshotForScope({ reportKey: "sku-movement", accountId, reportVersion: SKU_MOVEMENT_VERSION, scope: { brand: "ALL" } }); } catch (_e) { throw new DashboardAccessError("SKU Movement evidence is temporarily unavailable; please retry.", 503); }
  const rows = snap && snap.payload && Array.isArray(snap.payload.rows) ? snap.payload.rows : null;
  if (!rows) throw new DashboardAccessError("No SKU Movement evidence for this account yet; identifiers can be set once the report is available.", 400);
  const asins = new Set();
  for (const r of rows) {
    const asin = S(r.asin).trim().toUpperCase();
    if (!asin) continue;
    if (scope.restricted && !scope.permitted.has(brandKey(r.brand))) continue; // only the caller's permitted-brand ASINs
    asins.add(asin);
  }
  return asins;
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
      const scope = await resolveCallerScope(deps, { access, accountId });
      const identifiers = await deps.getSkuMovementIdentifiers({ organizationFingerprint: organization_fingerprint, connectionId, accountId });
      if (!scope.restricted) { res.status(200).json({ identifiers }); return; } // admin / ALL_BRANDS -> full map (unchanged)
      // F4: a brand-restricted caller sees only their permitted-brand identifiers. Fail closed: if the evidence
      // snapshot is absent (nothing to scope against), return an empty map rather than the whole account's map.
      let permitted;
      try { permitted = await permittedAsinAuthority(deps, { accountId, scope }); }
      catch (e) { if (e instanceof DashboardAccessError && e.status === 400) permitted = new Set(); else throw e; }
      const filtered = {};
      for (const [asin, id] of Object.entries(identifiers || {})) { if (permitted.has(S(asin).trim().toUpperCase())) filtered[asin] = id; }
      res.status(200).json({ identifiers: filtered });
      return;
    }

    if (req.method === "POST") {
      const body = bodyOf(req);
      const kind = S(body.kind).trim() || "set";
      const marketplace = await accountMarketplace(deps, accountId);
      // F4: resolve the caller's brand scope once; reads + writes below are limited to the caller's permitted-brand ASINs.
      const scope = await resolveCallerScope(deps, { access, accountId });

      if (kind === "set") {
        const asin = S(body.childAsin).trim().toUpperCase();
        if (!asin) { res.status(400).json({ error: "childAsin is required." }); return; }
        const clean = cleanIdentifier(body.identifier);
        if (!clean.ok) { res.status(400).json({ error: clean.reason }); return; }
        // A SET must prove the ASIN is within the caller's permitted-brand evidence. A CLEAR (blank) is unconditional
        // for an unrestricted caller (preserves clearing a stale identifier whose ASIN left the evidence), but a
        // brand-restricted caller must still own the ASIN's brand -- otherwise a clear would mutate another brand's row.
        if (clean.value !== "" || scope.restricted) {
          const authority = await permittedAsinAuthority(deps, { accountId, scope });
          if (!authority.has(asin)) { res.status(400).json({ error: `ASIN ${asin} is not in this account's permitted SKU Movement evidence.` }); return; }
        }
        const result = await deps.recordSkuMovementIdentifier({
          organizationFingerprint: organization_fingerprint, connectionId, accountId, marketplace, childAsin: asin,
          identifier: clean.value, updatedBy: access.userId, updatedByEmail: S(access.email),
        });
        await deps.insertAuditLog({ actorUserId: access.userId, action: clean.value === "" ? "sku-movement.identifier.cleared" : "sku-movement.identifier.set", target: { accountId, marketplace, childAsin: asin } });
        res.status(200).json({ identifier: result });
        return;
      }

      if (kind === "bulk") {
        const rawRows = Array.isArray(body.rows) ? body.rows : null;
        if (!rawRows || rawRows.length === 0) { res.status(400).json({ error: "rows must be a non-empty array." }); return; }
        if (rawRows.length > 5000) { res.status(400).json({ error: "too many rows (max 5000 per import)." }); return; }
        const authority = await permittedAsinAuthority(deps, { accountId, scope });
        // Server-side re-validation of EVERY row (the browser preview is never trusted): unknown ASIN, over-long /
        // control-char identifier, and duplicate-ASIN-conflicting-identifier -> ZERO writes (validated before the RPC).
        const norm = [];
        const seen = new Map(); // asin -> identifier (to catch same-file conflicts before the RPC too)
        const errors = [];
        for (const raw of rawRows) {
          const asin = S(raw.childAsin ?? raw.asin ?? raw.child_asin).trim().toUpperCase();
          const clean = cleanIdentifier(raw.identifier);
          if (!asin) { errors.push("a row has a blank ASIN"); continue; }
          if (!authority.has(asin)) { errors.push(`ASIN ${asin} is not in this account's SKU Movement evidence`); continue; }
          if (!clean.ok) { errors.push(`ASIN ${asin}: ${clean.reason}`); continue; }
          if (seen.has(asin) && seen.get(asin) !== clean.value) { errors.push(`ASIN ${asin} appears more than once with conflicting identifiers`); continue; }
          seen.set(asin, clean.value);
          norm.push({ childAsin: asin, identifier: clean.value });
        }
        if (errors.length) { res.status(400).json({ error: `${errors.length} row(s) rejected; nothing was written. First: ${errors[0]}`, rejected: errors.length }); return; }
        const result = await deps.recordSkuMovementIdentifierBulk({
          organizationFingerprint: organization_fingerprint, connectionId, accountId, marketplace, rows: norm,
          updatedBy: access.userId, updatedByEmail: S(access.email),
        });
        await deps.insertAuditLog({ actorUserId: access.userId, action: "sku-movement.identifier.bulk", target: { accountId, marketplace, applied: norm.length } });
        res.status(200).json({ bulk: result, applied: norm.length });
        return;
      }

      res.status(400).json({ error: "unknown POST kind (expected set | bulk)." });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    if (error instanceof DashboardAccessError) { res.status(error.status || 403).json({ error: error.message }); return; }
    res.status(500).json({ error: "SKU Movement identifier request failed." });
  }
}

export default function (req, res) { return handler(req, res); }
