// Ad Performance by Campaign -- VIEWING API (dormant feature; ASIN Ads stays live). Serves campaign metrics + KPIs for
// ONE authorized account from the EXISTING durable campaign-performance history, joined to the saved campaign->brand
// mapping. VIEWING follows account + brand authorization (NOT the mapping capability; editing does). Reads durable
// data only; never calls DataDoe; empty history -> empty view. It touches NO existing report.
//
// GET ?accountId=&from=&to=&brand=  ->
//   { accountId, from, to, restricted, campaigns:[...], summary:{ byCurrency }, brandScope }
// Account view (admin / ALL_BRANDS) returns all campaigns + account/Unmapped/brand totals + conservation. A
// SELECTED_BRANDS viewer is projected to campaigns mapped to their permitted brands ONLY (never Unmapped, never
// another brand). Currencies are never combined.
import {
  DashboardAccessError, getDashboardAccess, assertAccountAccess,
  getCampaignPerformanceRows, getCampaignBrandMappings, getTrustedAccountBrands,
} from "../lib/server/supabase.js";
import { brandKey } from "../lib/server/reports/brand-membership.js";
import { buildCampaignAdsView, summarizeCampaignAds, projectCampaignsForScope } from "../lib/server/reports/campaign-ads.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";

const S = (v) => (v == null ? "" : String(v));
const ALL_TOKENS = new Set(["", "all", "all brands", "all permitted", "all permitted brands"]);
const isAll = (b) => ALL_TOKENS.has(S(b).trim().toLowerCase());

// The organization fingerprint, derived SERVER-SIDE from the primary DataDoe connection (never from the browser),
// so saved mappings (written under the same fingerprint) join back correctly.
function orgFingerprint() {
  const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && S(c.apiKey).trim());
  return primary ? (primary.organizationFingerprint || organizationFingerprint(primary.apiKey)) : "";
}

const DEFAULT_DEPS = { getDashboardAccess, assertAccountAccess, getCampaignPerformanceRows, getCampaignBrandMappings, getTrustedAccountBrands, orgFingerprint };

// Resolve the viewer's brand scope for this account WITHOUT touching the shared report-authorization registry
// (dormant feature, minimal blast radius). Mirrors the canonical rule: admin / ALL_BRANDS -> full; SELECTED_BRANDS ->
// granted brands intersected with the account's TRUSTED membership. Fails closed (403) with no info leak.
async function resolveScope(deps, access, accountId, requestedBrand) {
  if (access.role === "admin") {
    return isAll(requestedBrand) ? { mode: "ALL" } : { mode: "NAMED", requestedKey: brandKey(requestedBrand) };
  }
  const grant = access.accountGrants ? access.accountGrants[accountId] : null;
  const mode = grant && grant.mode === "SELECTED_BRANDS" ? "SELECTED_BRANDS" : "ALL_BRANDS";
  if (mode === "ALL_BRANDS") {
    return isAll(requestedBrand) ? { mode: "ALL" } : { mode: "NAMED", requestedKey: brandKey(requestedBrand) };
  }
  const trusted = await deps.getTrustedAccountBrands({ accountId });
  const trustedKeys = new Set((Array.isArray(trusted) ? trusted : []).map((b) => b.key));
  const permitted = [...new Set((grant.brandKeys || []).map((k) => brandKey(k)).filter(Boolean))].filter((k) => trustedKeys.has(k));
  if (!permitted.length) throw new DashboardAccessError("You have no permitted brands for this account.", 403);
  if (isAll(requestedBrand)) return { mode: "ALL_PERMITTED", permittedKeys: permitted };
  const rk = brandKey(requestedBrand);
  if (!rk || !permitted.includes(rk)) throw new DashboardAccessError("You do not have access to the requested brand.", 403);
  return { mode: "NAMED", permittedKeys: permitted, requestedKey: rk };
}

export async function handler(req, res, deps = DEFAULT_DEPS) {
  try {
    if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed." }); return; }
    const access = await deps.getDashboardAccess(req);
    const accountId = S(req.query.accountId).trim();
    if (!accountId) { res.status(400).json({ error: "accountId is required." }); return; }
    deps.assertAccountAccess(access, [accountId]); // account authorization (admins bypass)

    const from = S(req.query.from).trim() || null;
    const to = S(req.query.to).trim() || null;
    const scope = await resolveScope(deps, access, accountId, req.query.brand);

    const org = deps.orgFingerprint();
    let durableRows, mappingRows;
    try {
      [durableRows, mappingRows] = await Promise.all([
        deps.getCampaignPerformanceRows({ accountId }),
        org ? deps.getCampaignBrandMappings({ organizationFingerprint: org, connectionId: "primary", accountId }).catch(() => []) : [],
      ]);
    } catch (_e) { throw new DashboardAccessError("Campaign Ads evidence is temporarily unavailable; please retry.", 503); }

    // An empty mapping set simply yields Unmapped campaigns (never fabricated).
    const view = buildCampaignAdsView({ durableRows: durableRows || [], mappingRows: mappingRows || [], from, to });
    const projected = projectCampaignsForScope(view.campaigns, scope);

    // Summary: full for an unrestricted view; scoped to the projected (permitted) campaigns for a restricted viewer so
    // account/Unmapped totals never leak another brand's spend.
    let summaryView = view;
    if (scope.mode !== "ALL") {
      const keep = new Set(projected.map((c) => `${c.campaignId}|${c.marketplace}|${c.adsProfileId}`));
      summaryView = { _internal: (view._internal || []).filter((r) => keep.has(`${r.campaignId}|${r.marketplace}|${r.adsProfileId}`)) };
    }
    const summary = summarizeCampaignAds(summaryView);

    res.status(200).json({
      accountId, from, to,
      restricted: scope.mode !== "ALL",
      brandScope: scope.mode,
      campaigns: projected,
      summary,
      hasData: (durableRows || []).length > 0,
    });
  } catch (error) {
    if (error instanceof DashboardAccessError) { res.status(error.status || 403).json({ error: error.message }); return; }
    res.status(500).json({ error: "Campaign Ads request failed." });
  }
}

export default function (req, res) { return handler(req, res); }
