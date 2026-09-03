import {
  DashboardAccessError,
  assertAdmin,
  getDashboardAccess,
  getInitialAdminBootstrapStatus,
  inviteDashboardUser,
  listDashboardUsers,
  updateDashboardUser,
  getUserAccountBrandScopes,
  getTrustedAccountBrands,
  replaceAccountBrandScope,
  getAccountDirectorySnapshotAccounts,
  getUserCampaignMappingCapabilities,
  setCampaignMappingCapability,
  insertAuditLog,
} from "../lib/server/supabase.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";
import { brandKey as canonicalBrandKey } from "../lib/server/reports/brand-membership.js";
import { resolveAuthorizedBrandMap } from "../lib/server/report-authorization.js";

function primaryOrgFingerprint() {
  try {
    const primary = getDataDoeConnections().find((c) => c && c.id === "primary" && String(c.apiKey || "").trim());
    return primary ? (primary.organizationFingerprint || organizationFingerprint(primary.apiKey)) : "";
  } catch { return ""; }
}

function bodyFor(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); }
    catch { throw new DashboardAccessError("Request body must be valid JSON.", 400); }
  }
  return req.body;
}

const DEFAULT_DEPS = {
  getInitialAdminBootstrapStatus, getDashboardAccess, assertAdmin, listDashboardUsers,
  inviteDashboardUser, updateDashboardUser, getUserAccountBrandScopes, getTrustedAccountBrands,
  replaceAccountBrandScope, primaryOrgFingerprint,
  getAccountDirectorySnapshotAccounts, getUserCampaignMappingCapabilities, setCampaignMappingCapability, insertAuditLog,
};

// Whether ONE account id is present in the organization's trusted account directory (server-derived; never trusted
// from the browser). Fail-closed: a directory read error throws (the caller returns 5xx before any write).
async function accountInTrustedDirectory(deps, accountId) {
  const accounts = await deps.getAccountDirectorySnapshotAccounts();
  return (Array.isArray(accounts) ? accounts : []).some((a) => String(a.accountId) === String(accountId));
}

export async function handler(req, res, deps = DEFAULT_DEPS) {
  try {
    const action = String(req.query.action || "me");

    // A public, non-sensitive boolean used only to hide the one-time bootstrap
    // form after the fixed owner identity has been created.
    if (req.method === "GET" && action === "bootstrap-status") {
      res.status(200).json(await deps.getInitialAdminBootstrapStatus());
      return;
    }

    const access = await deps.getDashboardAccess(req);

    if (req.method === "GET" && action === "me") {
      // CENTRALIZED brand authorization for the browser: attach, per authorized account, the permitted brand keys the
      // user may see (ALL_BRANDS -> the account's trusted brands; SELECTED_BRANDS -> trusted INTERSECT granted). A
      // non-admin ALL_BRANDS account is therefore materialized as THAT account's brands, never "globally unrestricted"
      // -- so every client selector can filter to the authorized per-account brand set (defense in depth; the server
      // still projects every payload + 403s a forbidden request). Admin -> no per-account map (unrestricted org-wide).
      // Computed ONLY here (once per access load / focus revalidate), never in the hot-path getDashboardAccess.
      // Fail-soft PER account: an unreadable membership leaves that account WITHOUT a permitted list (the client keeps
      // it unrestricted rather than hiding every brand; the server scoping remains authoritative).
      if (access && access.role !== "admin" && access.accountGrants) {
        try {
          const map = await resolveAuthorizedBrandMap({ access, getTrustedBrands: deps.getTrustedAccountBrands });
          for (const [acct, info] of Object.entries(map.accounts || {})) {
            if (info && info.resolved && access.accountGrants[acct]) {
              access.accountGrants[acct] = { ...access.accountGrants[acct], permittedBrandKeys: info.permittedKeys };
            }
          }
        } catch { /* fail-soft: no map attached; client falls back, server enforcement is authoritative */ }
      }
      res.status(200).json({ access });
      return;
    }

    deps.assertAdmin(access);
    if (req.method === "GET" && action === "users") {
      res.status(200).json({ users: await deps.listDashboardUsers() });
      return;
    }

    // The current per-account brand scope for ONE user (for the admin UI's per-account mode + selected-brand chips).
    if (req.method === "GET" && action === "user-scopes") {
      const userId = String(req.query.userId || "").trim();
      if (!userId) { res.status(400).json({ error: "A userId is required." }); return; }
      res.status(200).json({ scopes: await deps.getUserAccountBrandScopes(userId) });
      return;
    }

    // The TRUSTED brands for ONE account (the ONLY brands an admin may grant), so the UI's brand multi-select offers
    // exactly the account's proven membership -- never a fabricated or organization-wide brand.
    if (req.method === "GET" && action === "account-brands") {
      const accountId = String(req.query.accountId || "").trim();
      if (!accountId) { res.status(400).json({ error: "An accountId is required." }); return; }
      const brands = await deps.getTrustedAccountBrands({ accountId });
      res.status(200).json({ accountId, brands: brands.map((b) => ({ key: b.key, display: b.display })) });
      return;
    }

    const body = bodyFor(req);
    if (req.method === "POST" && action === "invite") {
      const invited = await deps.inviteDashboardUser(body);
      res.status(201).json({ user: invited });
      return;
    }
    if (req.method === "PATCH" && action === "user") {
      const user = await deps.updateDashboardUser(body);
      res.status(200).json({ user });
      return;
    }

    // Atomically set ONE (user, account) grant's brand scope. Validates EVERY selected brand key against the
    // account's TRUSTED membership BEFORE any write (an invalid/unknown brand -> 400, zero writes), then calls the
    // SECURITY DEFINER RPC (audited). The acting admin is authorized (assertAdmin above); admins administer all
    // accounts. `mode` is explicit: never inferred.
    if (req.method === "POST" && action === "brand-scope") {
      const userId = String(body.userId || "").trim();
      const accountId = String(body.accountId || "").trim();
      const mode = String(body.mode || "").toUpperCase();
      if (!userId || !accountId) { res.status(400).json({ error: "A user and account are required." }); return; }
      if (mode !== "ALL_BRANDS" && mode !== "SELECTED_BRANDS") { res.status(400).json({ error: "mode must be ALL_BRANDS or SELECTED_BRANDS." }); return; }

      let brandKeys = [];
      let brandDisplays = [];
      if (mode === "SELECTED_BRANDS") {
        const requested = Array.isArray(body.brands) ? body.brands : [];
        // Accept {key, display} objects or plain names; canonicalize the key.
        const wanted = new Map(); // canonicalKey -> display
        for (const b of requested) {
          const raw = b && typeof b === "object" ? (b.key ?? b.display ?? b.name ?? "") : b;
          const key = canonicalBrandKey(raw);
          if (!key) continue;
          const disp = b && typeof b === "object" && b.display ? String(b.display) : String(raw);
          if (!wanted.has(key)) wanted.set(key, disp);
        }
        if (wanted.size === 0) { res.status(400).json({ error: "Select at least one brand, or choose All brands." }); return; }
        // VALIDATE every requested brand against the account's TRUSTED membership -- one unknown brand -> zero writes.
        const trusted = await deps.getTrustedAccountBrands({ accountId });
        const trustedByKey = new Map(trusted.map((t) => [t.key, t.display]));
        const unknown = [...wanted.keys()].filter((k) => !trustedByKey.has(k));
        if (unknown.length) { res.status(400).json({ error: `One or more selected brands are not part of this account's data (${unknown.length}). Nothing was saved.`, rejected: unknown.length }); return; }
        brandKeys = [...wanted.keys()];
        brandDisplays = brandKeys.map((k) => trustedByKey.get(k) || wanted.get(k));
      }

      const result = await deps.replaceAccountBrandScope({
        organizationFingerprint: deps.primaryOrgFingerprint(),
        userId, accountId, mode, brandKeys, brandDisplays,
        actorId: access.userId, actorEmail: access.email || "",
        correlationId: String((req.headers && req.headers["x-request-id"]) || req.query.correlationId || ""),
      });
      res.status(200).json({ ok: true, userId, accountId, mode, result });
      return;
    }

    // ---- Campaign-mapping capability administration (admin only) ----------------------------------------------
    // A capability grants ONLY the ability to manage campaign->brand mappings for ONE account it is granted for. It
    // NEVER creates account access (the target user must already have it) and NEVER creates/changes brand access; it
    // never touches account_permissions or account_brand_grant. All writes go through the SECURITY DEFINER RPC.
    if (req.method === "GET" && action === "campaign-map-caps") {
      const userId = String(req.query.userId || "").trim();
      if (!userId) { res.status(400).json({ error: "A userId is required." }); return; }
      const capabilities = await deps.getUserCampaignMappingCapabilities({ userId, organizationFingerprint: deps.primaryOrgFingerprint(), connectionId: "primary" });
      res.status(200).json({ userId, capabilities: capabilities.map((c) => ({ accountId: c.accountId })) });
      return;
    }

    if (req.method === "POST" && (action === "campaign-map-grant" || action === "campaign-map-revoke")) {
      const grant = action === "campaign-map-grant";
      const userId = String(body.userId || "").trim();
      const accountId = String(body.accountId || "").trim();
      if (!userId || !accountId) { res.status(400).json({ error: "A user and account are required." }); return; }
      // The account must exist in the org's trusted directory (both grant and revoke reference a real account).
      if (!(await accountInTrustedDirectory(deps, accountId))) { res.status(404).json({ error: "Unknown account." }); return; }
      // A GRANT additionally requires the target user to ALREADY hold normal account access -- a capability can never
      // create account access. (A REVOKE is always allowed and idempotent.)
      if (grant) {
        const scopes = await deps.getUserAccountBrandScopes(userId);
        const hasAccess = (Array.isArray(scopes) ? scopes : []).some((s) => String(s.accountId) === accountId);
        if (!hasAccess) { res.status(403).json({ error: "The user does not have access to that account; grant account access first." }); return; }
      }
      const result = await deps.setCampaignMappingCapability({
        organizationFingerprint: deps.primaryOrgFingerprint(), connectionId: "primary", accountId, userId, enabled: grant,
        actor: access.userId, actorEmail: access.email || "", correlationId: String((req.headers && req.headers["x-request-id"]) || body.correlationId || ""),
      });
      await deps.insertAuditLog({ actorUserId: access.userId, action: grant ? "campaign-map-capability.grant" : "campaign-map-capability.revoke", target: { userId, accountId } });
      res.status(200).json({ ok: true, userId, accountId, enabled: grant, result });
      return;
    }

    res.status(400).json({ error: "Unknown access-management request." });
  } catch (error) {
    const status = error instanceof DashboardAccessError ? error.status : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Unexpected access-management error." });
  }
}

export default function (req, res) { return handler(req, res); }
