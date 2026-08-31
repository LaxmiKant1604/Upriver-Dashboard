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
} from "../lib/server/supabase.js";
import { getDataDoeConnections } from "../lib/server/datadoe-connections.js";
import { organizationFingerprint } from "../lib/server/source-identity.js";
import { brandKey as canonicalBrandKey } from "../lib/server/reports/brand-membership.js";

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
};

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

    res.status(400).json({ error: "Unknown access-management request." });
  } catch (error) {
    const status = error instanceof DashboardAccessError ? error.status : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Unexpected access-management error." });
  }
}

export default function (req, res) { return handler(req, res); }
