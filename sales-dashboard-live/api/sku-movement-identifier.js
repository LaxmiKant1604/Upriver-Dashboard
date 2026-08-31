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
} from "../lib/server/supabase.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";

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

// The set of ASINs proven for THIS account (from its latest ALL-brand SKU Movement snapshot). An ASIN not in this
// set is unknown/cross-account and a write is rejected. FAIL CLOSED: a load error -> 503 before any write; a
// genuinely-absent snapshot -> 400 (nothing to identify yet). This is the server-side ASIN-belongs-to-account gate.
async function accountAsinAuthority(deps, { accountId }) {
  let snap;
  try { snap = await deps.getLatestReportSnapshotForScope({ reportKey: "sku-movement", accountId, reportVersion: SKU_MOVEMENT_VERSION, scope: { brand: "ALL" } }); } catch (_e) { throw new DashboardAccessError("SKU Movement evidence is temporarily unavailable; please retry.", 503); }
  const rows = snap && snap.payload && Array.isArray(snap.payload.rows) ? snap.payload.rows : null;
  if (!rows) throw new DashboardAccessError("No SKU Movement evidence for this account yet; identifiers can be set once the report is available.", 400);
  return new Set(rows.map((r) => S(r.asin).trim().toUpperCase()).filter(Boolean));
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
      const identifiers = await deps.getSkuMovementIdentifiers({ organizationFingerprint: organization_fingerprint, connectionId, accountId });
      res.status(200).json({ identifiers });
      return;
    }

    if (req.method === "POST") {
      const body = bodyOf(req);
      const kind = S(body.kind).trim() || "set";
      const marketplace = await accountMarketplace(deps, accountId);

      if (kind === "set") {
        const asin = S(body.childAsin).trim().toUpperCase();
        if (!asin) { res.status(400).json({ error: "childAsin is required." }); return; }
        const clean = cleanIdentifier(body.identifier);
        if (!clean.ok) { res.status(400).json({ error: clean.reason }); return; }
        // A CLEAR (blank identifier) needs no ASIN authority (it only removes the account's own row); a SET must
        // prove the ASIN belongs to this account's evidence.
        if (clean.value !== "") {
          const authority = await accountAsinAuthority(deps, { accountId });
          if (!authority.has(asin)) { res.status(400).json({ error: `ASIN ${asin} is not in this account's SKU Movement evidence.` }); return; }
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
        const authority = await accountAsinAuthority(deps, { accountId });
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
