// CAMPAIGN -> BRAND mapping API (DORMANT FOUNDATION for a future "Ad Performance by Campaign" page).
//
// Backend only: this route reads the account's EXISTING durable campaign-performance history and lets an EXPLICITLY
// permitted seller user (or an admin) map each campaign to one of the account's TRUSTED brands. It NEVER calls
// DataDoe, never spends a token, never touches a scheduler, and never modifies account_permissions or
// account_brand_grant. Every organization/connection/account/marketplace/profile/campaign/brand fact is resolved or
// validated SERVER-SIDE; nothing is trusted from the browser.
//
// AUTHORIZATION: every action requires the per-account capability `can_manage_campaign_brand_mapping` (admins bypass).
// The capability grants ONLY campaign-mapping ability for that one account -- never any report, account, or brand.
//
// GET  ?action=campaigns&accountId=  -> the campaign directory (durable info + current mapping) for the account.
// GET  ?action=mappings&accountId=   -> current campaign->brand mappings only.
// GET  ?action=brands&accountId=     -> the account's trusted brands available for mapping.
// POST { accountId, kind:'assign'|'clear'|'bulk', ... } -> assign/change one, clear one, or apply many atomically.
import {
  DashboardAccessError, getDashboardAccess,
  getCampaignPerformanceRows, getCampaignBrandMappings, getCampaignMappingCapability,
  recordCampaignBrandMapping, recordCampaignBrandMappingBulk, getTrustedAccountBrands, insertAuditLog,
} from "../lib/server/supabase.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";
import {
  buildCampaignDirectory, buildCampaignAuthority, campaignIdentityKey,
  canonicalMarketplace, normalizeAdsProfile, resolveTrustedBrand,
} from "../lib/server/reports/campaign-directory.js";

const S = (v) => (v == null ? "" : String(v));
const MAX_NOTE = 500;
const MAX_BULK = 5000;

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
// A note is CLEAN when it trims to <=500 chars with NO control characters (the same rule the RPC enforces).
function cleanNote(v) {
  const t = S(v).trim();
  if (t.length > MAX_NOTE) return { ok: false, reason: `note too long (max ${MAX_NOTE})` };
  for (let i = 0; i < t.length; i += 1) { const code = t.charCodeAt(i); if (code < 32 || code === 127) return { ok: false, reason: "note contains control characters" }; }
  return { ok: true, value: t };
}

const DEFAULT_DEPS = {
  getDashboardAccess,
  getCampaignPerformanceRows, getCampaignBrandMappings, getCampaignMappingCapability,
  recordCampaignBrandMapping, recordCampaignBrandMappingBulk, getTrustedAccountBrands, insertAuditLog, orgFingerprint,
};

// The single authorization gate for EVERY action: admin OR an explicit per-account capability grant. Fails closed
// with a 403 that never reveals whether the account exists.
async function assertCampaignCapability(deps, access, { organization_fingerprint, connectionId, accountId }) {
  if (access && access.role === "admin") return;
  const ok = await deps.getCampaignMappingCapability({ organizationFingerprint: organization_fingerprint, connectionId, accountId, userId: access.userId });
  if (!ok) throw new DashboardAccessError("You do not have permission to manage campaign brand mappings for this account.", 403);
}

// The account's durable campaign identity authority + trusted brands (both server-derived; never trusted from the browser).
async function accountCampaignContext(deps, { organization_fingerprint, connectionId, accountId }) {
  let durableRows, mappingRows, trusted;
  try {
    [durableRows, mappingRows, trusted] = await Promise.all([
      deps.getCampaignPerformanceRows({ accountId }),
      deps.getCampaignBrandMappings({ organizationFingerprint: organization_fingerprint, connectionId, accountId }),
      deps.getTrustedAccountBrands({ accountId }),
    ]);
  } catch (_e) { throw new DashboardAccessError("Campaign evidence is temporarily unavailable; please retry.", 503); }
  return { durableRows: durableRows || [], mappingRows: mappingRows || [], trusted: trusted || [] };
}

export async function handler(req, res, deps = DEFAULT_DEPS) {
  try {
    const access = await deps.getDashboardAccess(req);
    const q = req.method === "GET" ? (req.query || {}) : bodyOf(req);
    const accountId = S(q.accountId).trim();
    if (!accountId) { res.status(400).json({ error: "accountId is required." }); return; }
    const organization_fingerprint = deps.orgFingerprint();
    const connectionId = "primary";
    await assertCampaignCapability(deps, access, { organization_fingerprint, connectionId, accountId });

    if (req.method === "GET") {
      const action = S(req.query.action).trim() || "campaigns";
      if (action === "brands") {
        const trusted = await deps.getTrustedAccountBrands({ accountId }).catch(() => { throw new DashboardAccessError("Trusted brands are temporarily unavailable; please retry.", 503); });
        res.status(200).json({ brands: (trusted || []).map((b) => ({ key: b.key, display: b.display || b.key })) });
        return;
      }
      if (action === "mappings") {
        const { mappingRows } = await accountCampaignContext(deps, { organization_fingerprint, connectionId, accountId });
        res.status(200).json({ mappings: mappingRows.map((m) => ({
          campaignId: m.ad_campaign_id, marketplace: m.marketplace, adsProfileId: m.ads_profile_id,
          brandKey: m.canonical_brand_key, brandDisplay: m.brand_display_name, mappingSource: m.mapping_source, mappingUpdatedAt: m.updated_at,
        })) });
        return;
      }
      // action === "campaigns" (default): the full directory (durable info only) joined to current mappings.
      const { durableRows, mappingRows } = await accountCampaignContext(deps, { organization_fingerprint, connectionId, accountId });
      res.status(200).json({ campaigns: buildCampaignDirectory({ durableRows, mappingRows }) });
      return;
    }

    if (req.method === "POST") {
      const body = bodyOf(req);
      const kind = S(body.kind).trim() || "assign";
      const ctx = await accountCampaignContext(deps, { organization_fingerprint, connectionId, accountId });
      const authority = buildCampaignAuthority(ctx.durableRows);

      if (kind === "assign" || kind === "clear") {
        const marketplace = canonicalMarketplace(body.marketplace);
        const adsProfileId = normalizeAdsProfile(body.adsProfileId);
        const campaignId = S(body.campaignId).trim();
        if (!marketplace || !campaignId) { res.status(400).json({ error: "marketplace and campaignId are required." }); return; }
        const note = cleanNote(body.note);
        if (!note.ok) { res.status(400).json({ error: note.reason }); return; }
        const identity = campaignIdentityKey({ marketplace, adsProfileId, campaignId });

        let brandKey = "";
        let brandDisplay = "";
        if (kind === "assign") {
          // An ASSIGN must prove the campaign belongs to this account's durable history AND the brand is trusted.
          if (!authority.has(identity)) { res.status(400).json({ error: "This campaign is not in the account's campaign history." }); return; }
          const brand = resolveTrustedBrand(body.brand, ctx.trusted);
          if (!brand || brand.clear) { res.status(400).json({ error: "A valid trusted brand is required to assign a mapping." }); return; }
          brandKey = brand.key; brandDisplay = brand.display;
        }
        // A CLEAR removes only this account's own mapping row (no history proof needed); brandKey stays "".

        const result = await deps.recordCampaignBrandMapping({
          organizationFingerprint: organization_fingerprint, connectionId, accountId, marketplace, adsProfileId, campaignId,
          brandKey, brandDisplay, source: "MANUAL", note: note.value, actor: access.userId, actorEmail: S(access.email),
        });
        await deps.insertAuditLog({ actorUserId: access.userId, action: kind === "clear" ? "campaign-brand-mapping.clear" : "campaign-brand-mapping.assign", target: { accountId, marketplace, adsProfileId, campaignId, brandKey } });
        res.status(200).json({ mapping: result });
        return;
      }

      if (kind === "bulk") {
        const rawRows = Array.isArray(body.rows) ? body.rows : null;
        if (!rawRows || rawRows.length === 0) { res.status(400).json({ error: "rows must be a non-empty array." }); return; }
        if (rawRows.length > MAX_BULK) { res.status(400).json({ error: `too many rows (max ${MAX_BULK} per import).` }); return; }
        const trustedList = ctx.trusted;
        const norm = [];
        const seen = new Map(); // identityKey -> brandKey (catch same-file conflicts before the RPC too)
        const errors = [];
        for (const raw of rawRows) {
          const marketplace = canonicalMarketplace(raw.marketplace);
          const adsProfileId = normalizeAdsProfile(raw.adsProfileId ?? raw.ads_profile_id);
          const campaignId = S(raw.campaignId ?? raw.ad_campaign_id).trim();
          if (!marketplace || !campaignId) { errors.push("a row has a blank marketplace or campaignId"); continue; }
          const identity = campaignIdentityKey({ marketplace, adsProfileId, campaignId });
          const note = cleanNote(raw.note);
          if (!note.ok) { errors.push(`campaign ${campaignId}: ${note.reason}`); continue; }
          const brand = resolveTrustedBrand(raw.brand, trustedList);
          let brandKey = "";
          let brandDisplay = "";
          if (brand === null) { errors.push(`campaign ${campaignId}: unknown brand`); continue; }
          if (!brand.clear) {
            // ASSIGN rows must be proven in durable history; CLEAR rows (blank brand) only remove an own row.
            if (!authority.has(identity)) { errors.push(`campaign ${campaignId} is not in the account's campaign history`); continue; }
            brandKey = brand.key; brandDisplay = brand.display;
          }
          if (seen.has(identity) && seen.get(identity) !== brandKey) { errors.push(`campaign ${campaignId} appears more than once with conflicting brands`); continue; }
          seen.set(identity, brandKey);
          norm.push({ marketplace, adsProfileId, campaignId, brandKey, brandDisplay, note: note.value });
        }
        if (errors.length) { res.status(400).json({ error: `${errors.length} row(s) rejected; nothing was written. First: ${errors[0]}`, rejected: errors.length }); return; }
        const result = await deps.recordCampaignBrandMappingBulk({
          organizationFingerprint: organization_fingerprint, connectionId, accountId, rows: norm, actor: access.userId, actorEmail: S(access.email),
        });
        await deps.insertAuditLog({ actorUserId: access.userId, action: "campaign-brand-mapping.bulk", target: { accountId, applied: norm.length } });
        res.status(200).json({ bulk: result, applied: norm.length });
        return;
      }

      res.status(400).json({ error: "unknown POST kind (expected assign | clear | bulk)." });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    if (error instanceof DashboardAccessError) { res.status(error.status || 403).json({ error: error.message }); return; }
    res.status(500).json({ error: "Campaign brand mapping request failed." });
  }
}

export default function (req, res) { return handler(req, res); }
