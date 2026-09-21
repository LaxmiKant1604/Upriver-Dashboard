// Minimal server-only Supabase REST client. It stays client-bundle-free (only server-only imports) so
// Vercel can use the credentials injected by its Supabase Marketplace integration without exposing the
// secret key in the Vite bundle. The one import below is the shared, server-only owner-identity helper,
// used to RECOMPUTE and validate sync_source_job_owners.owner_id before any write (never a secret).

import { createHash } from "node:crypto";
import { sourceJobOwnerId } from "./source-identity.js";
import { normalizeFulfillmentChannel } from "./sync/oli-order-rules.js";
import { resolveActiveCycleHead } from "./sync/source-cycle-attempts.js";
import { membershipBrandsForAccount } from "./reports/brand-membership.js";
import { ACTIVE_ADS_SOURCE_KEY } from "./active-ads-source.js";
import { isRoutingScope } from "./sync/scheduler-scope.js";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
// Vercel Marketplace projects can expose either the legacy service-role JWT or
// Supabase's newer secret key. Prefer the service-role key when both exist:
// it is accepted by every REST/Storage endpoint used by the server snapshot
// layer, while keeping the newer key as a compatible fallback.
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const READ_RETRY_DELAYS_MS = Object.freeze([250, 750, 1500]);
const READ_RETRY_STATUSES = new Set([500, 502, 503, 504]);

function waitForReadRetry(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("Supabase read aborted."));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Supabase read aborted."));
    }, { once: true });
  });
}

// PostgREST occasionally resets a long paginated read or returns a brief 5xx. Retrying an idempotent GET at
// the failed page is safe and avoids restarting a 143-page OLI history proof. Mutating requests never use this
// helper and therefore retain strict single-attempt / commit-unknown semantics.
async function fetchReadOnly(url, options = {}, attempt = 0) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (options.signal?.aborted || attempt >= READ_RETRY_DELAYS_MS.length) throw error;
    await waitForReadRetry(READ_RETRY_DELAYS_MS[attempt], options.signal);
    return fetchReadOnly(url, options, attempt + 1);
  }
  if (READ_RETRY_STATUSES.has(response.status) && attempt < READ_RETRY_DELAYS_MS.length) {
    await waitForReadRetry(READ_RETRY_DELAYS_MS[attempt], options.signal);
    return fetchReadOnly(url, options, attempt + 1);
  }
  return response;
}

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
}

const INITIAL_ADMIN_EMAIL = "laxmikant@upriver.in";

export class DashboardAccessError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = "DashboardAccessError";
    this.status = status;
  }
}

function requireConfiguration() {
  if (!isSupabaseConfigured()) {
    throw new Error("Supabase is not configured. Connect the Supabase Vercel integration and add SUPABASE_URL plus SUPABASE_SECRET_KEY.");
  }
}

async function request(path, { method = "GET", body, headers = {}, signal = null } = {}) {
  requireConfiguration();
  // Round-6 fix 4: an optional route-owned AbortSignal reaches the REAL HTTP layer, so a bounded route can
  // genuinely abort an in-flight PostgREST request instead of merely abandoning its promise. Callers that
  // pass no signal are byte-identical to before.
  const fetchOptions = {
    method,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  };
  const response = method === "GET"
    ? await fetchReadOnly(`${SUPABASE_URL}${path}`, fetchOptions)
    : await fetch(`${SUPABASE_URL}${path}`, fetchOptions);
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    // Attach SAFE structured error info: the HTTP status and the PostgREST/Postgres error code only
    // (e.g. PGRST205, 42P01). Never the apikey/Authorization headers (which are request-side), a
    // token, or the raw response payload -- only PostgREST's own { code, message, hint } descriptors.
    const error = new Error(`Supabase request failed (${response.status}): ${result?.message || result?.hint || "Unknown error"}`);
    error.status = response.status;
    error.code = result && typeof result.code === "string" ? result.code : null;
    throw error;
  }
  return result;
}

function storageObjectUrl(bucket, objectPath) {
  const safeBucket = encodeURIComponent(bucket);
  const safePath = String(objectPath || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${SUPABASE_URL}/storage/v1/object/${safeBucket}/${safePath}`;
}

async function putPrivateStorageObject(bucket, objectPath, contents, contentType = "application/json", { signal = null } = {}) {
  requireConfiguration();
  const response = await fetchReadOnly(storageObjectUrl(bucket, objectPath), {
    method: "POST",
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: contents,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(`Supabase Storage upload failed (${response.status}): ${result?.message || result?.error || "Unknown error"}`);
  }
}

async function getPrivateStorageJson(bucket, objectPath, { signal = null } = {}) {
  requireConfiguration();
  const response = await fetch(storageObjectUrl(bucket, objectPath), {
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Supabase Storage download failed (${response.status}).`);
  return response.json();
}

async function deletePrivateStorageObjects(bucket, objectPaths, { signal = null } = {}) {
  if (!objectPaths.length) return;
  await request(`/storage/v1/object/${encodeURIComponent(bucket)}`, {
    method: "DELETE",
    signal,
    body: { prefixes: objectPaths },
  });
}

async function authRequest(path, { method = "GET", body, accessToken } = {}) {
  requireConfiguration();
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${accessToken || SUPABASE_SECRET_KEY}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new DashboardAccessError(result?.msg || result?.message || "Authentication request failed.", response.status === 401 ? 401 : 500);
  }
  return result;
}

function bearerToken(req) {
  const header = String(req.headers?.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function getDashboardAccess(req) {
  const accessToken = bearerToken(req);
  if (!accessToken) throw new DashboardAccessError("Please sign in to access the dashboard.", 401);
  const user = await authRequest("/auth/v1/user", { accessToken });
  const profileQuery = new URLSearchParams({
    select: "role,display_name",
    user_id: `eq.${user.id}`,
    limit: "1",
  });
  const profiles = await request(`/rest/v1/user_profiles?${profileQuery}`);
  const profile = profiles[0];
  if (!profile) throw new DashboardAccessError("Your dashboard profile is still being created. Please try again in a moment.", 403);
  const permissionsQuery = new URLSearchParams({
    select: "account_id,brand_scope_mode",
    user_id: `eq.${user.id}`,
  });
  const permissions = await request(`/rest/v1/account_permissions?${permissionsQuery}`);
  // Per-account brand scope. A grant is ALL_BRANDS unless it explicitly stores SELECTED_BRANDS AND has at least one
  // selected-brand row (a defensive read: a SELECTED_BRANDS mode with zero brand rows is treated as no brands, never
  // as "all"). The canonical brand keys are loaded once (only when at least one account is narrowed) and intersected
  // with the account's TRUSTED membership later, at serve time, by resolveUserReportScope.
  const selectedAccountIds = permissions.filter((p) => p.brand_scope_mode === "SELECTED_BRANDS").map((p) => p.account_id);
  let brandRows = [];
  if (selectedAccountIds.length) {
    const inList = selectedAccountIds.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
    const grantQuery = new URLSearchParams({
      select: "account_id,canonical_brand_key",
      user_id: `eq.${user.id}`,
    });
    grantQuery.append("account_id", `in.(${inList})`);
    brandRows = await request(`/rest/v1/account_brand_grant?${grantQuery}`).catch(() => []);
  }
  const brandKeysByAccount = new Map();
  for (const r of Array.isArray(brandRows) ? brandRows : []) {
    const list = brandKeysByAccount.get(r.account_id) || [];
    if (r.canonical_brand_key) list.push(r.canonical_brand_key);
    brandKeysByAccount.set(r.account_id, list);
  }
  const accountGrants = {};
  for (const p of permissions) {
    const mode = p.brand_scope_mode === "SELECTED_BRANDS" ? "SELECTED_BRANDS" : "ALL_BRANDS";
    accountGrants[p.account_id] = { mode, brandKeys: mode === "SELECTED_BRANDS" ? (brandKeysByAccount.get(p.account_id) || []) : null };
  }
  return {
    userId: user.id,
    email: user.email || "",
    displayName: profile.display_name || user.user_metadata?.display_name || "",
    role: profile.role,
    accountIds: permissions.map((permission) => permission.account_id),
    // Per-account brand scope keyed by account_id: { mode, brandKeys }. brandKeys is null for ALL_BRANDS, an array of
    // canonical brand keys for SELECTED_BRANDS. Admins ignore this (full access). Never trusted from the browser.
    accountGrants,
  };
}

export function assertAccountAccess(access, accountIds) {
  if (access.role === "admin") return;
  const allowed = new Set(access.accountIds);
  if (!accountIds.length || accountIds.some((accountId) => !allowed.has(accountId))) {
    throw new DashboardAccessError("You do not have access to the selected Amazon account.", 403);
  }
}

export function assertAdmin(access) {
  if (access.role !== "admin") throw new DashboardAccessError("Administrator access is required.", 403);
}

export async function listDashboardUsers() {
  const [profiles, permissions, authUsers] = await Promise.all([
    request("/rest/v1/user_profiles?select=user_id,role,display_name,created_at,updated_at&order=created_at.asc"),
    request("/rest/v1/account_permissions?select=user_id,account_id&order=account_id.asc"),
    authRequest("/auth/v1/admin/users?page=1&per_page=1000"),
  ]);
  const emailById = new Map((authUsers.users || []).map((user) => [user.id, user.email || ""]));
  const accountsByUser = new Map();
  for (const permission of permissions) {
    const current = accountsByUser.get(permission.user_id) || [];
    current.push(permission.account_id);
    accountsByUser.set(permission.user_id, current);
  }
  return profiles.map((profile) => ({
    id: profile.user_id,
    email: emailById.get(profile.user_id) || "Pending invitation",
    displayName: profile.display_name || "",
    role: profile.role,
    accountIds: accountsByUser.get(profile.user_id) || [],
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
  }));
}

// This intentionally returns only bootstrap state, not any user information.
// The login screen uses it to remove the one-time owner-creation action once
// the owner has an Auth account.
export async function getInitialAdminBootstrapStatus() {
  const authUsers = await authRequest("/auth/v1/admin/users?page=1&per_page=1000");
  const owner = (authUsers.users || []).find((user) =>
    String(user.email || "").trim().toLowerCase() === INITIAL_ADMIN_EMAIL
  );
  return {
    initialAdminExists: Boolean(owner),
    confirmationPending: Boolean(owner && !owner.email_confirmed_at && !owner.confirmed_at),
  };
}

function validManagedRole(role) {
  return role === "viewer" || role === "editor";
}

function normalizeAccountIds(accountIds) {
  if (!Array.isArray(accountIds)) throw new DashboardAccessError("Account assignments must be an array.", 400);
  return [...new Set(accountIds.map((accountId) => String(accountId).trim()).filter(Boolean))];
}

// PURE surgical diff (no I/O): given a user's CURRENT account ids and the WANTED set, compute exactly which to add and
// which to remove. `normalized` is the de-duplicated/trimmed wanted set. IDEMPOTENT: wanted == current -> both lists
// empty (a re-invite/re-save is a no-op, so no duplicate membership rows can be created). Accounts that STAY are in
// neither list, so their brand_scope_mode + selected-brand rows are preserved and removing one account never disturbs
// the others. Extracted so these invitation-idempotency + account-isolation guarantees are unit-testable offline.
export function computeAccountPermissionDiff(currentIds, wantedIds) {
  const normalized = normalizeAccountIds(wantedIds);
  const wanted = new Set(normalized);
  const current = new Set((Array.isArray(currentIds) ? currentIds : []).map((id) => String(id)));
  const toRemove = [...current].filter((id) => !wanted.has(id));
  const toAdd = normalized.filter((id) => !current.has(id));
  return { normalized, toAdd, toRemove };
}

// Set a user's ACCOUNT grants to exactly `accountIds`, as a SURGICAL DIFF so a brand-scope narrowing survives an
// account-list edit: accounts removed from the set are deleted (which CASCADE-removes their selected-brand grants),
// newly added accounts are inserted as ALL_BRANDS (the safe default), and accounts that remain keep their existing
// brand_scope_mode + selected-brand rows untouched. (The old delete-all-then-insert would have silently reset every
// account back to ALL_BRANDS on any edit.)
export async function replaceAccountPermissions(userId, accountIds, { grantedBy = null } = {}) {
  const currentRows = await request(`/rest/v1/account_permissions?${new URLSearchParams({ select: "account_id", user_id: `eq.${userId}` })}`).catch(() => []);
  const currentIds = (Array.isArray(currentRows) ? currentRows : []).map((r) => r.account_id);
  const { normalized, toAdd, toRemove } = computeAccountPermissionDiff(currentIds, accountIds);
  for (const accountId of toRemove) {
    // Delete one account at a time so the FK cascade removes exactly that account's brand grants.
    await request(`/rest/v1/account_permissions?${new URLSearchParams({ user_id: `eq.${userId}`, account_id: `eq.${accountId}` })}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
  }
  if (toAdd.length) {
    await request("/rest/v1/account_permissions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: toAdd.map((accountId) => ({ user_id: userId, account_id: accountId, brand_scope_mode: "ALL_BRANDS", granted_by: grantedBy || null })),
    });
  }
  return normalized;
}

// The current brand-scope grants for one user, for the admin User Access UI: [{ accountId, mode, brandKeys, brandDisplays }].
// Read-only; never a secret. brandKeys/brandDisplays are the STORED selected-brand rows (not yet intersected with live
// membership -- the UI shows what was saved; the resolver enforces live membership at serve time).
export async function getUserAccountBrandScopes(userId) {
  const perms = await request(`/rest/v1/account_permissions?${new URLSearchParams({ select: "account_id,brand_scope_mode", user_id: `eq.${userId}` })}`).catch(() => []);
  const grants = await request(`/rest/v1/account_brand_grant?${new URLSearchParams({ select: "account_id,canonical_brand_key,brand_display", user_id: `eq.${userId}` })}`).catch(() => []);
  const byAccount = new Map();
  for (const g of Array.isArray(grants) ? grants : []) {
    const e = byAccount.get(g.account_id) || { keys: [], displays: [] };
    if (g.canonical_brand_key) { e.keys.push(g.canonical_brand_key); e.displays.push(g.brand_display || g.canonical_brand_key); }
    byAccount.set(g.account_id, e);
  }
  return (Array.isArray(perms) ? perms : []).map((p) => {
    const mode = p.brand_scope_mode === "SELECTED_BRANDS" ? "SELECTED_BRANDS" : "ALL_BRANDS";
    const e = byAccount.get(p.account_id) || { keys: [], displays: [] };
    return { accountId: p.account_id, mode, brandKeys: mode === "SELECTED_BRANDS" ? e.keys : [], brandDisplays: mode === "SELECTED_BRANDS" ? e.displays : [] };
  });
}

// Atomically REPLACE one (user, account) grant's brand scope via the SECURITY DEFINER RPC (the only brand-scope write
// path). The api/ layer authorizes the acting admin + validates the brand keys against the account's trusted
// membership BEFORE calling this. Returns { mode, brandKeys, added, removed }.
export async function replaceAccountBrandScope({ organizationFingerprint = "", userId, accountId, mode, brandKeys = [], brandDisplays = [], actorId = null, actorEmail = "", correlationId = "" }) {
  if (!userId || !accountId) throw new DashboardAccessError("A user and account are required.", 400);
  const m = String(mode || "").toUpperCase();
  if (m !== "ALL_BRANDS" && m !== "SELECTED_BRANDS") throw new DashboardAccessError("Brand scope mode must be ALL_BRANDS or SELECTED_BRANDS.", 400);
  const rows = await request("/rest/v1/rpc/replace_account_brand_scope", {
    method: "POST",
    body: {
      p_organization_fingerprint: String(organizationFingerprint || ""),
      p_user_id: userId,
      p_account_id: String(accountId),
      p_mode: m,
      p_brand_keys: Array.isArray(brandKeys) ? brandKeys : [],
      p_brand_displays: Array.isArray(brandDisplays) ? brandDisplays : [],
      p_actor: actorId,
      p_actor_email: String(actorEmail || ""),
      p_correlation_id: String(correlationId || ""),
    },
  });
  return rows || null;
}

// TRUSTED brand membership for ONE account: the canonical brand keys proven by the account's LATEST validated
// brand-sales snapshot (the SAME membership evidence Brand View uses -- catalogBrands, falling back to joined row
// brands). Returns [{ key, display }] (canonical-key de-duplicated). A selected-brand grant is effective ONLY while
// its key appears here, so a brand removed from the account's trusted membership disappears from the user's scope
// even if a stale grant row remains. Fail-soft: no snapshot / read error -> [] (no brand is trusted, so a
// SELECTED_BRANDS user sees nothing rather than everything). NEVER fabricated from a user request.
export async function getTrustedAccountBrands({ accountId }) {
  const id = String(accountId || "").trim();
  if (!id) return [];
  const snap = await getLatestReportSnapshotForScope({ reportKey: "brand-sales", accountId: id }).catch(() => null);
  if (!snap) return [];
  let payload = snap.payload;
  if (!(payload && (Array.isArray(payload.catalogBrands) || Array.isArray(payload.rows)))) {
    if (snap.payload_storage_path) { try { payload = await getReportSnapshotStoragePayload(snap.payload_storage_path); } catch { /* keep inline */ } }
  }
  const names = new Set();
  for (const b of (payload && payload.catalogBrands) || []) { const s = String(b || "").trim(); if (s) names.add(s); }
  for (const r of (payload && payload.rows) || []) { const b = r && (r.product_brand || r.brand); const s = String(b || "").trim(); if (s) names.add(s); }
  return membershipBrandsForAccount([...names]);
}

export async function updateDashboardUser({ userId, role, accountIds }) {
  if (!userId) throw new DashboardAccessError("User id is required.", 400);
  if (!validManagedRole(role)) throw new DashboardAccessError("Only Viewer or Editor roles can be assigned here.", 400);
  const existingQuery = new URLSearchParams({ select: "role", user_id: `eq.${userId}`, limit: "1" });
  const existing = await request(`/rest/v1/user_profiles?${existingQuery}`);
  if (existing[0]?.role === "admin") {
    throw new DashboardAccessError("Administrator access is protected and cannot be changed from this panel.", 400);
  }
  const rows = await request(`/rest/v1/user_profiles?user_id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: { role },
  });
  if (!rows.length) throw new DashboardAccessError("User was not found.", 404);
  const assignedAccountIds = await replaceAccountPermissions(userId, accountIds);
  return { userId, role, accountIds: assignedAccountIds };
}

export async function inviteDashboardUser({ email, displayName, accountIds }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) throw new DashboardAccessError("Enter a valid email address.", 400);
  const appUrl = String(process.env.DASHBOARD_APP_URL || "https://upriverdashboard.vercel.app").replace(/\/$/, "");
  const invited = await authRequest("/auth/v1/invite", {
    method: "POST",
    body: {
      email: normalizedEmail,
      data: displayName ? { display_name: String(displayName).trim() } : {},
      redirect_to: appUrl,
    },
  });
  const userId = invited.id || invited.user?.id;
  if (!userId) throw new DashboardAccessError("Supabase did not return an invited user id.", 500);
  const assignedAccountIds = await replaceAccountPermissions(userId, accountIds);
  return { userId, email: normalizedEmail, accountIds: assignedAccountIds };
}

export async function getReportSnapshot({ reportKey, accountId, paramsHash }, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: "id,report_key,account_id,params_hash,params,payload,payload_storage_path,payload_bytes,source_refreshed_at,updated_at",
    report_key: `eq.${reportKey}`,
    account_id: `eq.${accountId}`,
    params_hash: `eq.${paramsHash}`,
    limit: "1",
  });
  const rows = await request(`/rest/v1/report_snapshots?${query}`, { signal });
  return rows[0] || null;
}

/**
 * The most recent saved snapshot for a report and account, whatever scope it was
 * saved under.
 *
 * Every insight report's scope includes its as-of date, so at midnight the exact
 * scope key stops matching and the report would otherwise appear to have no
 * saved data at all. This lets the server serve yesterday's saved report,
 * clearly labelled with the date it was saved for, instead of a blank screen.
 */
export async function getLatestReportSnapshot({ reportKey, accountId }) {
  const query = new URLSearchParams({
    select: "id,report_key,account_id,params_hash,params,payload,payload_storage_path,payload_bytes,source_refreshed_at,updated_at",
    report_key: `eq.${reportKey}`,
    account_id: `eq.${accountId}`,
    order: "updated_at.desc",
    limit: "1",
  });
  const rows = await request(`/rest/v1/report_snapshots?${query}`);
  return rows[0] || null;
}

/**
 * The most recent saved snapshot for a report+account whose params match a SCOPE (e.g. { reportVersion, brand }),
 * WHATEVER as-of date it was saved under. This is the stale-across-midnight read narrowed to one scope so a
 * named-brand Daily request can never fall back to (and leak) the ALL-brand snapshot, and vice versa. Scope keys
 * are matched against the JSONB params via `params->>key=eq.value`; the newest matching row (by updated_at) wins.
 */
/**
 * The candidate inventory snapshots the Brand View serve/materializer selects the AUTHORITATIVE compact from
 * (Round-4 Defect 2 / Codex finding 3). The priority run republishes an unavailable placeholder at {to: cycle D-1}
 * every cycle while the zero-export rebuild publishes a real AVAILABLE compact at {to: its real inventory date}; a
 * single latest-by-updated_at read lets the fresh placeholder shadow a lagging available LKG. Instead of an
 * arbitrary recent-N cutoff (which a long run of unavailable placeholders could push a valid available LKG out of),
 * this returns exactly TWO indexed single-row reads, so the authoritative available LKG is ALWAYS found regardless
 * of how many placeholders exist AND regardless of which path wrote it:
 *   - the newest AVAILABLE compact, found by filtering the INLINE payload directly (payload->>inventoryAvailable =
 *     'true'), so it works for a compact written by ANY path (the rebuild, the source-promoted publisher, or a
 *     pre-existing row) with NO marker to stamp and NO backfill -- the compact payload is always inline + small; and
 *   - the newest row overall (may be an unavailable placeholder).
 * The pure selectAuthoritativeInventorySnapshot then prefers the available LKG (keeping its REAL, possibly older
 * inventory date) and falls back to the latest row only when no available compact exists. Deduped by id.
 */
export async function getInventorySnapshotCandidates({ reportKey, accountId, reportVersion }) {
  const availableQuery = new URLSearchParams({
    select: "id,report_key,account_id,params_hash,params,payload,payload_storage_path,payload_bytes,source_refreshed_at,updated_at",
    report_key: `eq.${reportKey}`,
    account_id: `eq.${accountId}`,
    "payload->>inventoryAvailable": "eq.true",
    order: "updated_at.desc",
    limit: "1",
  });
  if (reportVersion != null) availableQuery.append("params->>reportVersion", `eq.${reportVersion}`);
  const [availableRows, latest] = await Promise.all([
    request(`/rest/v1/report_snapshots?${availableQuery}`).catch(() => []),
    getLatestReportSnapshot({ reportKey, accountId }).catch(() => null),
  ]);
  const available = Array.isArray(availableRows) ? (availableRows[0] || null) : null;
  const out = [];
  if (available) out.push(available);
  if (latest && (!available || String(latest.id) !== String(available.id))) out.push(latest);
  return out;
}

export async function getLatestReportSnapshotForScope({ reportKey, accountId, reportVersion = null, scope = {} }) {
  const query = new URLSearchParams({
    select: "id,report_key,account_id,params_hash,params,payload,payload_storage_path,payload_bytes,source_refreshed_at,updated_at",
    report_key: `eq.${reportKey}`,
    account_id: `eq.${accountId}`,
    order: "updated_at.desc",
    limit: "1",
  });
  if (reportVersion != null) query.append("params->>reportVersion", `eq.${reportVersion}`);
  for (const [k, v] of Object.entries(scope || {})) {
    if (v == null) continue;
    query.append(`params->>${k}`, `eq.${v}`);
  }
  const rows = await request(`/rest/v1/report_snapshots?${query}`);
  return rows[0] || null;
}

/**
 * The NEWEST source-provenance timestamp across a set of accounts for one report_key -- a single cheap indexed
 * read used to decide Brand View freshness (is a contributing brand-sales snapshot newer than the assembled
 * Brand View?). Returns the ISO string (source_refreshed_at, falling back to updated_at) or "" when none exist
 * or the id set is empty. Reads only two tiny columns of the single newest row.
 */
export async function getLatestSourceProvenance({ reportKey, accountIds }, { signal = null } = {}) {
  const ids = [...new Set((accountIds || []).map((v) => String(v).trim()).filter(Boolean))];
  if (!ids.length) return "";
  const query = new URLSearchParams({
    select: "source_refreshed_at,updated_at",
    report_key: `eq.${reportKey}`,
    order: "source_refreshed_at.desc.nullslast",
    limit: "1",
  });
  query.append("account_id", `in.(${ids.join(",")})`);
  const rows = await request(`/rest/v1/report_snapshots?${query}`, { signal });
  const r = rows[0];
  return r ? String(r.source_refreshed_at || r.updated_at || "") : "";
}

// The most recent saved snapshot for a report+account, with its payload hydrated STORAGE-FIRST: when the row's
// inline payload is out-of-line (stored in the source-cache bucket -> inline null/partial), the full payload is
// fetched via its payload_storage_path. WITHOUT this, a large brand-sales snapshot (inline null) is invisible to
// the live membership/portfolio path and its account is silently dropped -- the exact reason the offline rebuild
// hydrates storage but the live read did not. `hasPayload` decides whether the inline payload is already usable.
// An inline payload is "usable" for the membership/portfolio read only when it carries actual content -- a
// NON-EMPTY rows or catalogBrands array. A null/partial stub (the shape a stored out-of-line snapshot leaves
// inline) is NOT usable, so the full payload is hydrated from storage instead of the account being dropped.
export function inlinePayloadUsable(p) {
  return !!(p && ((Array.isArray(p.rows) && p.rows.length > 0) || (Array.isArray(p.catalogBrands) && p.catalogBrands.length > 0)));
}
export async function getLatestReportSnapshotHydrated(
  { reportKey, accountId },
  { hasPayload = inlinePayloadUsable, signal = null, readLatest = getLatestReportSnapshot, readStorage = getReportSnapshotStoragePayload } = {},
) {
  const row = await readLatest({ reportKey, accountId });
  if (!row) return null;
  if (hasPayload(row.payload) || !row.payload_storage_path) return row;
  try {
    const hydrated = await readStorage(row.payload_storage_path, { signal });
    if (hydrated) return { ...row, payload: hydrated };
  } catch (_e) { /* fall through to the inline (possibly partial) payload -- never throw a read into a dropout */ }
  return row;
}

// Lightweight metadata (NO payload) for the most recent snapshot of a report+account: used to compute the
// membership PROVENANCE fingerprint cheaply, so the directory self-heal decides whether to rebuild WITHOUT
// hydrating every account's full brand-sales payload. Returns { updated_at, source_refreshed_at, params_hash } or null.
export async function getLatestReportSnapshotMeta({ reportKey, accountId }, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: "params_hash,source_refreshed_at,updated_at",
    report_key: `eq.${reportKey}`,
    account_id: `eq.${accountId}`,
    order: "updated_at.desc",
    limit: "1",
  });
  const rows = await request(`/rest/v1/report_snapshots?${query}`, { signal });
  return rows[0] || null;
}

export async function saveReportSnapshot(snapshot, { signal = null } = {}) {
  const rows = await request("/rest/v1/report_snapshots?on_conflict=report_key,account_id,params_hash", {
    method: "POST",
    signal,
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: {
      report_key: snapshot.reportKey,
      account_id: snapshot.accountId,
      params_hash: snapshot.paramsHash,
      params: snapshot.params || {},
      payload: snapshot.payload || null,
      payload_storage_path: snapshot.payloadStoragePath || null,
      payload_bytes: snapshot.payloadBytes || 0,
      source_refreshed_at: snapshot.sourceRefreshedAt || new Date().toISOString(),
    },
  });
  return rows[0];
}

/**
 * Atomic INSERT-IF-ABSENT of one snapshot row, using the natural-key unique index
 * (report_key, account_id, params_hash). Unlike saveReportSnapshot (merge-upsert), this NEVER
 * merges or overwrites an existing row: it sends `Prefer: resolution=ignore-duplicates`
 * (INSERT ... ON CONFLICT DO NOTHING) with `return=representation`, so the response contains the
 * inserted row when it was absent and is EMPTY on conflict. Returns `true` when a row was
 * inserted, `false` when the row already existed (conflict), and THROWS on transport/HTTP
 * failure. Used for first-manifest creation so a delayed second creator loses the race instead
 * of clobbering an already-advanced action.
 */
export async function insertReportSnapshotIfAbsent(snapshot) {
  const rows = await request("/rest/v1/report_snapshots?on_conflict=report_key,account_id,params_hash", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: {
      report_key: snapshot.reportKey,
      account_id: snapshot.accountId,
      params_hash: snapshot.paramsHash,
      params: snapshot.params || {},
      payload: snapshot.payload || null,
      payload_storage_path: snapshot.payloadStoragePath || null,
      payload_bytes: snapshot.payloadBytes || 0,
      source_refreshed_at: snapshot.sourceRefreshedAt || new Date().toISOString(),
    },
  });
  return Array.isArray(rows) && rows.length > 0;
}

const SOURCE_CACHE_BUCKET = "dashboard-snapshots";

export async function getSourceExportCache(requestHash, { signal = null } = {}) {
  const query = new URLSearchParams({
    // organization_fingerprint + account_scope_hash are returned so a confirmed-exact-match cache reuse
    // can belt-and-suspenders assert scope identity (request_hash already folds them in; kept strict).
    // request_meta is returned so a consumer can surface the TRUE data as-of (request_meta.batchFetchedAt, the batch's
    // real download time) + provenance, distinct from fetched_at (the materialization wall-clock). source_id = source type.
    select: "request_hash,source_id,organization_fingerprint,account_scope_hash,object_path,row_count,payload_bytes,fetched_at,expires_at,request_meta",
    request_hash: `eq.${requestHash}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1",
  });
  const rows = await request(`/rest/v1/source_export_cache?${query}`, { signal });
  const entry = rows[0];
  if (!entry) return null;
  const payload = await getPrivateStorageJson(SOURCE_CACHE_BUCKET, entry.object_path, { signal });
  if (!payload || !Array.isArray(payload.rows)) return null;
  return { ...entry, rows: payload.rows };
}

// Lean metadata-only read of a source_export_cache row (NO storage payload fetch): returns request_meta + timing so a
// caller can decide freshness/overwrite ordering cheaply. Used by the v3 per-account materializer to enforce
// newer-only alias overwrites (request_meta.batchFetchedAt) without hydrating the payload. Unexpired rows only.
export async function getSourceExportCacheMeta(requestHash, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: "request_hash,request_meta,fetched_at,expires_at",
    request_hash: `eq.${requestHash}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1",
  });
  const rows = await request(`/rest/v1/source_export_cache?${query}`, { signal });
  return rows[0] || null;
}

export async function saveSourceExportCache({
  requestHash,
  sourceId,
  organizationFingerprint,
  accountScopeHash,
  requestMeta,
  rows,
  payloadBytes,
  expiresAt,
}) {
  const objectPath = `source-cache/v1/${requestHash.slice(0, 2)}/${requestHash}.json`;
  const serialised = JSON.stringify({ rows });
  await putPrivateStorageObject(SOURCE_CACHE_BUCKET, objectPath, serialised);
  const saved = await request("/rest/v1/source_export_cache?on_conflict=request_hash", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: {
      request_hash: requestHash,
      source_id: sourceId,
      organization_fingerprint: organizationFingerprint,
      account_scope_hash: accountScopeHash,
      request_meta: requestMeta,
      object_path: objectPath,
      row_count: rows.length,
      payload_bytes: payloadBytes,
      fetched_at: new Date().toISOString(),
      expires_at: expiresAt,
    },
  });
  return saved[0] || null;
}

export async function pruneSourceExportCache() {
  const deleted = await request("/rest/v1/rpc/prune_source_export_cache", {
    method: "POST",
    body: { p_max_bytes: 536870912, p_max_entries: 512 },
  });
  const objectPaths = (deleted || []).map((row) => row.object_path).filter(Boolean);
  await deletePrivateStorageObjects(SOURCE_CACHE_BUCKET, objectPaths).catch(() => {});
  return objectPaths.length;
}

export async function publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId }) {
  await request("/rest/v1/dashboard_events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: {
      report_key: reportKey,
      account_id: accountId,
      params_hash: paramsHash,
      snapshot_id: snapshotId,
    },
  });
}

export async function claimRefreshLock({ reportKey, accountId, paramsHash, lockSeconds = 120 }) {
  return request("/rest/v1/rpc/claim_report_refresh_lock", {
    method: "POST",
    body: {
      p_report_key: reportKey,
      p_account_id: accountId,
      p_params_hash: paramsHash,
      p_lock_seconds: lockSeconds,
    },
  });
}

// Releasing the lock as soon as a refresh finishes means a failed export does
// not block the next attempt for the whole lock duration.
export async function releaseRefreshLock({ reportKey, accountId, paramsHash }) {
  const query = new URLSearchParams({
    report_key: `eq.${reportKey}`,
    account_id: `eq.${accountId}`,
    params_hash: `eq.${paramsHash}`,
  });
  await request(`/rest/v1/report_refresh_locks?${query}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

export async function getCogsOverrides(accountId) {
  const query = new URLSearchParams({
    select: "currency,sku,asin,per_unit_cost,updated_at",
    account_id: `eq.${accountId}`,
  });
  return request(`/rest/v1/cogs_overrides?${query}`);
}

// ---- FBA Shipment Plan durable PLANNING config (settings + SKU horizon overrides + seller warehouse). Read via the
//      service role for a single account; ALL writes are service-role-only and audited. These NEVER touch DataDoe or
//      any source-derived table. Missing rows come back empty (the planner applies the system default). ----
export async function getFbaPlanningConfig({ organizationFingerprint, connectionId = "primary", accountId, signal = null } = {}) {
  if (!organizationFingerprint || !accountId) throw new Error("getFbaPlanningConfig requires organizationFingerprint + accountId (fail closed).");
  const base = { organization_fingerprint: `eq.${organizationFingerprint}`, connection_id: `eq.${connectionId}`, account_id: `eq.${accountId}` };
  const q = (extra) => new URLSearchParams({ ...base, ...extra }).toString();
  const safe = async (p) => { try { const r = await request(p, { signal }); return Array.isArray(r) ? r : []; } catch (e) { if (isSchemaMissingError(e)) return []; throw e; } };
  const [settings, overrides, warehouse, wddWeights, leadTimes] = await Promise.all([
    safe(`/rest/v1/fba_planning_settings?${q({ select: "horizon_kind,horizon_months,horizon_days,forecast_method,forecast_weights,safety_days,updated_at" })}`),
    safe(`/rest/v1/fba_sku_horizon_overrides?${q({ select: "sku,horizon_kind,horizon_months,horizon_days,updated_at" })}`),
    safe(`/rest/v1/fba_seller_warehouse?${q({ select: "marketplace,sku,child_asin,qty,note,updated_at,updated_by_email" })}`),
    // ADDITIVE (Migration 22): the per-brand WDD blend weights + the per-ASIN lead-time / countdown inputs. A missing
    // table (schema not yet applied) yields [] via `safe`, so an older deploy degrades to the existing planner cleanly.
    safe(`/rest/v1/fba_wdd_weights?${q({ select: "brand_key,weight_7d,weight_30d,weight_60d,updated_at" })}`),
    safe(`/rest/v1/fba_asin_lead_time?${q({ select: "child_asin,production_days,shipping_days,awd_transfer_days,safety_stock_days,inbound_started_date,inbound_eta,note,updated_at,updated_by_email" })}`),
  ]);
  return { settings: settings[0] || null, overrides, warehouse, wddWeights, leadTimes };
}

// ADDITIVE (Migration 22). One brand's WDD blend (or the account-default when brandKey is '') via the SECURITY DEFINER
// RPC, which upserts (or deletes when action='clear') AND appends the audit row atomically. The 0..100 range + exact-100
// total are enforced by the table CHECKs (a bad total raises -> nothing written).
export async function recordFbaWddWeights({ organizationFingerprint, connectionId = "primary", accountId, brandKey = "", w7, w30, w60, action = "set", updatedBy = null }) {
  const body = await request("/rest/v1/rpc/record_fba_wdd_weights", {
    method: "POST",
    body: {
      p_organization_fingerprint: organizationFingerprint, p_connection_id: connectionId, p_account_id: accountId,
      p_brand_key: brandKey || "", p_w7: w7 == null ? null : Number(w7), p_w30: w30 == null ? null : Number(w30),
      p_w60: w60 == null ? null : Number(w60), p_action: action, p_updated_by: updatedBy,
    },
  });
  return Array.isArray(body) ? body[0] : body;
}

// ADDITIVE (Migration 22). One ASIN's lead-time write via the SECURITY DEFINER RPC. action 'set' preserves any running
// countdown; 'start' recomputes + stores the Inbound ETA (start + production + shipping + awd); 'clear' deletes the row.
export async function recordFbaAsinLeadTime({ organizationFingerprint, connectionId = "primary", accountId, childAsin, production = null, shipping = null, awd = null, safety = null, note = "", action = "set", startedDate = null, updatedBy = null, updatedByEmail = "" }) {
  const n = (v) => (v == null || v === "" ? null : Number(v));
  const body = await request("/rest/v1/rpc/record_fba_asin_lead_time", {
    method: "POST",
    body: {
      p_organization_fingerprint: organizationFingerprint, p_connection_id: connectionId, p_account_id: accountId, p_child_asin: childAsin,
      p_production: n(production), p_shipping: n(shipping), p_awd: n(awd), p_safety: n(safety),
      p_note: note || "", p_action: action, p_started_date: startedDate || null, p_updated_by: updatedBy, p_updated_by_email: updatedByEmail || "",
    },
  });
  return Array.isArray(body) ? body[0] : body;
}

// ADDITIVE (Migration 22). Atomic BULK lead-time import for one account (all-or-nothing) via the SECURITY DEFINER RPC.
// rows: [{ childAsin, production?, shipping?, awd?, safety?, inboundEta? }] -- a null/absent field is written as NULL
// (blank-as-clear). Any invalid/duplicate row aborts the whole transaction.
export async function recordFbaAsinLeadTimeBulk({ organizationFingerprint, connectionId = "primary", accountId, rows, updatedBy = null, updatedByEmail = "" }) {
  const n = (v) => (v == null || v === "" ? null : Number(v));
  const p_rows = (Array.isArray(rows) ? rows : []).map((r) => ({
    child_asin: r.childAsin, production_days: n(r.production), shipping_days: n(r.shipping),
    awd_transfer_days: n(r.awd), safety_stock_days: n(r.safety), inbound_eta: r.inboundEta || null,
    // Note is preserved through the bulk import. Forward-compatible: the pre-migration-23 RPC ignores this key
    // (leaving note unchanged); the migration-23 RPC applies it (blank clears), matching the single-row path.
    note: r.note == null ? "" : String(r.note),
  }));
  const body = await request("/rest/v1/rpc/record_fba_asin_lead_time_bulk", {
    method: "POST",
    body: {
      p_organization_fingerprint: organizationFingerprint, p_connection_id: connectionId, p_account_id: accountId,
      p_rows, p_updated_by: updatedBy, p_updated_by_email: updatedByEmail || "",
    },
  });
  return Array.isArray(body) ? body[0] : body;
}

export async function setFbaPlanningSettings({ organizationFingerprint, connectionId = "primary", accountId, horizonKind, horizonMonths, horizonDays, forecastMethod, forecastWeights, safetyDays, updatedBy }) {
  const rows = await request("/rest/v1/fba_planning_settings?on_conflict=organization_fingerprint,connection_id,account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: {
      organization_fingerprint: organizationFingerprint, connection_id: connectionId, account_id: accountId,
      horizon_kind: horizonKind, horizon_months: horizonMonths ?? null, horizon_days: horizonDays ?? null,
      forecast_method: forecastMethod, forecast_weights: forecastWeights ?? null, safety_days: safetyDays,
      updated_by: updatedBy || null, updated_at: new Date().toISOString(),
    },
  });
  return (Array.isArray(rows) ? rows[0] : rows) || null;
}

export async function setFbaSkuHorizonOverride({ organizationFingerprint, connectionId = "primary", accountId, sku, horizonKind, horizonMonths, horizonDays, updatedBy }) {
  const rows = await request("/rest/v1/fba_sku_horizon_overrides?on_conflict=organization_fingerprint,connection_id,account_id,sku", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: {
      organization_fingerprint: organizationFingerprint, connection_id: connectionId, account_id: accountId, sku,
      horizon_kind: horizonKind, horizon_months: horizonMonths ?? null, horizon_days: horizonDays ?? null,
      updated_by: updatedBy || null, updated_at: new Date().toISOString(),
    },
  });
  return (Array.isArray(rows) ? rows[0] : rows) || null;
}

export async function deleteFbaSkuHorizonOverride({ organizationFingerprint, connectionId = "primary", accountId, sku }) {
  const q = new URLSearchParams({ organization_fingerprint: `eq.${organizationFingerprint}`, connection_id: `eq.${connectionId}`, account_id: `eq.${accountId}`, sku: `eq.${sku}` });
  await request(`/rest/v1/fba_sku_horizon_overrides?${q}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  return { deleted: true };
}

// One warehouse write (upsert, or delete when qty is null) + its audit row, atomically, via the SECURITY DEFINER RPC.
export async function recordFbaSellerWarehouse({ organizationFingerprint, connectionId = "primary", accountId, marketplace, sku, childAsin = "", qty, note = "", updatedBy = null, updatedByEmail = "", action = "set" }) {
  const body = await request("/rest/v1/rpc/record_fba_seller_warehouse", {
    method: "POST",
    body: {
      p_organization_fingerprint: organizationFingerprint, p_connection_id: connectionId, p_account_id: accountId,
      p_marketplace: marketplace, p_sku: sku, p_child_asin: childAsin, p_qty: qty == null ? null : Number(qty),
      p_note: note, p_updated_by: updatedBy, p_updated_by_email: updatedByEmail, p_action: action,
    },
  });
  return Array.isArray(body) ? body[0] : body;
}

// Atomic BULK warehouse apply (many validated rows for one account, all-or-nothing) via the SECURITY DEFINER RPC.
// rows: [{ marketplace, sku, childAsin?, qty, note? }]. Any invalid row aborts the whole transaction.
export async function recordFbaSellerWarehouseBulk({ organizationFingerprint, connectionId = "primary", accountId, rows, updatedBy = null, updatedByEmail = "" }) {
  const p_rows = (Array.isArray(rows) ? rows : []).map((r) => ({
    marketplace: r.marketplace, sku: r.sku, child_asin: r.childAsin || "", qty: r.qty == null ? null : Number(r.qty), note: r.note || "",
  }));
  const body = await request("/rest/v1/rpc/record_fba_seller_warehouse_bulk", {
    method: "POST",
    body: {
      p_organization_fingerprint: organizationFingerprint, p_connection_id: connectionId, p_account_id: accountId,
      p_rows, p_updated_by: updatedBy, p_updated_by_email: updatedByEmail,
    },
  });
  return Array.isArray(body) ? body[0] : body;
}

// Canonical marketplace code (GB==UK), mirrored from lib/server/reports/warehouse-validation.js#canonMkt.
const canonMktCode = (v) => { const m = String(v == null ? "" : v).trim().toUpperCase(); return m === "GB" ? "UK" : m; };

// The account's OWN seller-warehouse rows (durable identity: marketplace/sku/child_asin), for server-side
// identity-immutability validation. Account-scoped. STRICT: any failure (incl. schema-missing) THROWS so the write
// path fails closed -- it must never be conflated with "no stored identity".
export async function getSellerWarehouseRows({ organizationFingerprint, connectionId = "primary", accountId, signal = null } = {}) {
  if (!organizationFingerprint || !accountId) throw new Error("getSellerWarehouseRows requires organizationFingerprint + accountId (fail closed).");
  const q = new URLSearchParams({
    organization_fingerprint: `eq.${organizationFingerprint}`, connection_id: `eq.${connectionId}`, account_id: `eq.${accountId}`,
    select: "marketplace,sku,child_asin",
  });
  const r = await request(`/rest/v1/fba_seller_warehouse?${q}`, { signal });
  return Array.isArray(r) ? r : [];
}

// Cross-account SKU-ownership probe against the durable account-SKU ownership authority (fba_account_sku_ownership,
// populated from every account's validated v2d-5 directory + warehouse identity). `pairs` are {marketplace, sku}
// candidates. Returns a Set of canonical "MKT sku" keys proven under a DIFFERENT account (same canonical marketplace
// only -- the same SKU text in another legitimate marketplace is never a conflict). NEVER exposes which account owns
// them. STRICT: any failure THROWS so the write path fails closed (never treated as "no ownership").
export async function getWarehouseOwnershipConflicts({ organizationFingerprint, accountId, pairs, signal = null } = {}) {
  const list = (Array.isArray(pairs) ? pairs : [])
    .map((p) => ({ marketplace: canonMktCode(p && p.marketplace), sku: String(p && p.sku == null ? "" : p.sku).trim() }))
    .filter((p) => p.marketplace && p.sku).slice(0, 500);
  if (!organizationFingerprint || !accountId || list.length === 0) return new Set();
  const skus = [...new Set(list.map((p) => p.sku))];
  const markets = [...new Set(list.map((p) => p.marketplace))];
  const inStr = (arr) => `(${arr.map((s) => `"${String(s).replace(/"/g, '""')}"`).join(",")})`;
  const q = new URLSearchParams({
    organization_fingerprint: `eq.${organizationFingerprint}`, account_id: `neq.${accountId}`,
    select: "marketplace,sku", limit: "5000",
  });
  q.append("sku", `in.${inStr(skus)}`);
  q.append("marketplace", `in.${inStr(markets)}`);
  const rows = await request(`/rest/v1/fba_account_sku_ownership?${q}`, { signal });
  const want = new Set(list.map((p) => `${p.marketplace} ${p.sku}`));
  const owned = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = `${canonMktCode(r.marketplace)} ${String(r.sku || "").trim()}`;
    if (want.has(k)) owned.add(k);
  }
  return owned;
}

// Distinct account_ids that have a published fba-plan snapshot -- the set to backfill ownership for. Service-role read.
export async function listFbaPlanSnapshotAccountIds({ signal = null } = {}) {
  const rows = await request(`/rest/v1/report_snapshots?report_key=eq.fba-plan&select=account_id`, { signal });
  return [...new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.account_id || "").trim()).filter(Boolean))];
}

// Atomically REPLACE one account's ownership rows from validated directory evidence (delete + insert in one
// transaction) via the SECURITY DEFINER RPC. rows: [{ marketplace, sku, child_asin?, sources? }].
export async function replaceFbaAccountSkuOwnership({ organizationFingerprint, connectionId = "primary", accountId, rows }) {
  const p_rows = (Array.isArray(rows) ? rows : []).map((r) => ({ marketplace: r.marketplace, sku: r.sku, child_asin: r.child_asin || "", sources: r.sources || "" }));
  const body = await request("/rest/v1/rpc/replace_fba_account_sku_ownership", {
    method: "POST",
    body: { p_organization_fingerprint: organizationFingerprint, p_connection_id: connectionId, p_account_id: accountId, p_rows },
  });
  return Array.isArray(body) ? body[0] : body;
}

// Per-user column visibility prefs (hidden column ids) + an additive per-(user, report) `prefs` jsonb (e.g. SKU
// Movement's chosen recent-window N). Absent row => all defaults visible + empty prefs. Reused by BOTH FBA Plan
// (report_key 'fba-plan', hidden_columns only) and SKU Movement (report_key 'sku-movement', + prefs.recentDays).
export async function getFbaPlanColumnPrefs({ userId, reportKey = "fba-plan", signal = null } = {}) {
  if (!userId) throw new Error("getFbaPlanColumnPrefs requires userId (fail closed).");
  const q = new URLSearchParams({ user_id: `eq.${userId}`, report_key: `eq.${reportKey}`, select: "hidden_columns,prefs,updated_at" });
  try {
    const rows = await request(`/rest/v1/fba_plan_column_prefs?${q}`, { signal });
    const row = Array.isArray(rows) ? rows[0] : null;
    return {
      hiddenColumns: Array.isArray(row?.hidden_columns) ? row.hidden_columns.map(String) : [],
      prefs: row && row.prefs && typeof row.prefs === "object" && !Array.isArray(row.prefs) ? row.prefs : {},
      updatedAt: row?.updated_at || null,
    };
  } catch (e) { if (isSchemaMissingError(e)) return { hiddenColumns: [], prefs: {}, updatedAt: null }; throw e; }
}

export async function setFbaPlanColumnPrefs({ userId, reportKey = "fba-plan", hiddenColumns, prefs = undefined }) {
  const hidden = Array.from(new Set((Array.isArray(hiddenColumns) ? hiddenColumns : []).map(String))).slice(0, 200);
  const body = { user_id: userId, report_key: reportKey, hidden_columns: hidden, updated_at: new Date().toISOString() };
  // prefs is OPTIONAL + additive: only written when supplied (FBA callers never pass it, so their row's prefs is untouched).
  if (prefs !== undefined) body.prefs = (prefs && typeof prefs === "object" && !Array.isArray(prefs)) ? prefs : {};
  const rows = await request("/rest/v1/fba_plan_column_prefs?on_conflict=user_id,report_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body,
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return {
    hiddenColumns: Array.isArray(row?.hidden_columns) ? row.hidden_columns.map(String) : hidden,
    prefs: row && row.prefs && typeof row.prefs === "object" && !Array.isArray(row.prefs) ? row.prefs : (prefs || {}),
  };
}

// ACCOUNT-scoped FBA Shipment Plan column visibility. SHARED display layout keyed by the COMPLETE trusted identity
// (organization_fingerprint, connection_id, account_id, report_key) -- NOT the user, and NEVER account_id alone. Any
// authorized dashboard user opening that account sees the same saved hidden set; each account keeps its own layout.
// The api/ layer authenticates + authorizes account access + validates the column ids BEFORE calling these; identity
// is server-bound (org/connection never trusted from the browser). Distinct table from the per-user fba_plan_column_prefs
// (which stays user-scoped and is shared with SKU Movement); this never reads or writes that table.
export async function getFbaPlanAccountColumnPrefs({ organizationFingerprint, connectionId = "primary", accountId, reportKey = "fba-plan", signal = null } = {}) {
  if (!organizationFingerprint || !accountId) throw new Error("getFbaPlanAccountColumnPrefs requires organizationFingerprint + accountId (fail closed).");
  const q = new URLSearchParams({
    organization_fingerprint: `eq.${organizationFingerprint}`, connection_id: `eq.${connectionId}`,
    account_id: `eq.${accountId}`, report_key: `eq.${reportKey}`, select: "hidden_columns,updated_at",
  });
  try {
    const rows = await request(`/rest/v1/fba_plan_account_column_prefs?${q}`, { signal });
    const row = Array.isArray(rows) ? rows[0] : null;
    // updatedAt present === a saved account layout exists (even an empty hidden set = the user chose "Select all").
    // Absent row => null updatedAt => the caller falls back to PLAN_DEFAULT_HIDDEN_COLS. Never another account's set.
    return { hiddenColumns: Array.isArray(row?.hidden_columns) ? row.hidden_columns.map(String) : [], updatedAt: row?.updated_at || null };
  } catch (e) { if (isSchemaMissingError(e)) return { hiddenColumns: [], updatedAt: null }; throw e; }
}

export async function setFbaPlanAccountColumnPrefs({ organizationFingerprint, connectionId = "primary", accountId, reportKey = "fba-plan", hiddenColumns, updatedBy = null, updatedByEmail = "" }) {
  if (!organizationFingerprint || !accountId) throw new Error("setFbaPlanAccountColumnPrefs requires organizationFingerprint + accountId (fail closed).");
  const hidden = Array.from(new Set((Array.isArray(hiddenColumns) ? hiddenColumns : []).map(String)));
  const body = {
    organization_fingerprint: organizationFingerprint, connection_id: connectionId, account_id: accountId, report_key: reportKey,
    hidden_columns: hidden, updated_by: updatedBy || null, updated_by_email: updatedByEmail || "", updated_at: new Date().toISOString(),
  };
  // Atomic, idempotent upsert on the natural key; last successful save wins for simultaneous edits. return=representation
  // gives the canonical stored row back to the caller.
  const rows = await request("/rest/v1/fba_plan_account_column_prefs?on_conflict=organization_fingerprint,connection_id,account_id,report_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body,
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { hiddenColumns: Array.isArray(row?.hidden_columns) ? row.hidden_columns.map(String) : hidden, updatedAt: row?.updated_at || body.updated_at };
}

// ---- SKU MOVEMENT identifier (manual per-(org, account, marketplace, ASIN) metadata) --------------------------
// Read the account's saved identifiers -> a map { CHILD_ASIN(upper): identifier }. Account-scoped (the caller
// authorizes account access). Fail-soft: schema-missing / read error => {} (the report renders without identifiers).
export async function getSkuMovementIdentifiers({ organizationFingerprint, connectionId = "primary", accountId, signal = null } = {}) {
  if (!organizationFingerprint || !accountId) throw new Error("getSkuMovementIdentifiers requires organizationFingerprint + accountId (fail closed).");
  const q = new URLSearchParams({
    organization_fingerprint: `eq.${organizationFingerprint}`, connection_id: `eq.${connectionId}`, account_id: `eq.${accountId}`,
    select: "child_asin,marketplace,identifier,updated_at",
  });
  try {
    const rows = await request(`/rest/v1/sku_movement_identifier?${q}`, { signal });
    const map = {};
    for (const r of Array.isArray(rows) ? rows : []) { const a = String(r.child_asin || "").trim().toUpperCase(); if (a) map[a] = String(r.identifier || ""); }
    return map;
  } catch (e) { if (isSchemaMissingError(e)) return {}; throw e; }
}

// Single-row identifier upsert-or-clear (blank identifier CLEARS) via the SECURITY DEFINER RPC. Atomic + audited.
export async function recordSkuMovementIdentifier({ organizationFingerprint, connectionId = "primary", accountId, marketplace, childAsin, identifier, updatedBy = null, updatedByEmail = "" }) {
  const body = await request("/rest/v1/rpc/record_sku_movement_identifier", {
    method: "POST",
    body: {
      p_organization_fingerprint: organizationFingerprint, p_connection_id: connectionId, p_account_id: accountId,
      p_marketplace: marketplace, p_child_asin: childAsin, p_identifier: identifier == null ? "" : String(identifier),
      p_updated_by: updatedBy, p_updated_by_email: updatedByEmail,
    },
  });
  return Array.isArray(body) ? body[0] : body;
}

// Atomic BULK identifier apply for ONE account (single canonical marketplace), all-or-nothing, via the RPC.
// rows: [{ childAsin, identifier }] -- a blank identifier CLEARS that ASIN.
export async function recordSkuMovementIdentifierBulk({ organizationFingerprint, connectionId = "primary", accountId, marketplace, rows, updatedBy = null, updatedByEmail = "" }) {
  const p_rows = (Array.isArray(rows) ? rows : []).map((r) => ({ child_asin: r.childAsin ?? r.child_asin, identifier: r.identifier == null ? "" : String(r.identifier) }));
  const body = await request("/rest/v1/rpc/record_sku_movement_identifier_bulk", {
    method: "POST",
    body: {
      p_organization_fingerprint: organizationFingerprint, p_connection_id: connectionId, p_account_id: accountId,
      p_marketplace: marketplace, p_rows, p_updated_by: updatedBy, p_updated_by_email: updatedByEmail,
    },
  });
  return Array.isArray(body) ? body[0] : body;
}

// ---- CAMPAIGN -> BRAND mapping (user-managed; dormant foundation) --------------------------------------------
// The campaign directory's source of truth: the account's EXISTING durable campaign-performance rows
// (ads_daily_source_rows, source_key 'campaign-performance-v1'). Account-scoped. Fail-soft: schema-missing / read
// error => [] (an empty directory; a campaign is NEVER fabricated). Reads only; never a DataDoe call.
export async function getCampaignPerformanceRows({ accountId, signal = null } = {}) {
  const id = String(accountId || "").trim();
  if (!id) throw new Error("getCampaignPerformanceRows requires accountId (fail closed).");
  const q = new URLSearchParams({
    source_key: "eq.campaign-performance-v1", account_id: `eq.${id}`,
    // `metrics` MUST be selected: the Campaign Ads view + directory sum the per-campaign spend/sales/clicks/orders/
    // units/impressions from this JSONB. Omitting it made buildCampaignAdsView read undefined metrics and show ZEROS
    // even though the durable history carried the real values. `updated_at` lets consumers dedupe by natural grain.
    select: "marketplace_country_code,campaign_id,campaign_type,currency,metric_date,dimension_key,account_id,dimensions,metrics,updated_at",
  });
  try { const rows = await request(`/rest/v1/ads_daily_source_rows?${q}`, { signal }); return Array.isArray(rows) ? rows : []; }
  catch (e) { if (isSchemaMissingError(e)) return []; throw e; }
}

// Current campaign->brand mappings for ONE account. Account-scoped. Fail-soft => [].
export async function getCampaignBrandMappings({ organizationFingerprint, connectionId = "primary", accountId, signal = null } = {}) {
  if (!organizationFingerprint || !accountId) throw new Error("getCampaignBrandMappings requires organizationFingerprint + accountId (fail closed).");
  const q = new URLSearchParams({
    organization_fingerprint: `eq.${organizationFingerprint}`, connection_id: `eq.${connectionId}`, account_id: `eq.${accountId}`,
    select: "marketplace,ads_profile_id,ad_campaign_id,canonical_brand_key,brand_display_name,mapping_source,updated_at",
  });
  try { const rows = await request(`/rest/v1/campaign_brand_mapping?${q}`, { signal }); return Array.isArray(rows) ? rows : []; }
  catch (e) { if (isSchemaMissingError(e)) return []; throw e; }
}

// Whether a user EXPLICITLY holds the campaign-mapping capability for one account. Fail-soft => false (fail closed).
export async function getCampaignMappingCapability({ organizationFingerprint, connectionId = "primary", accountId, userId, signal = null } = {}) {
  if (!organizationFingerprint || !accountId || !userId) return false;
  const q = new URLSearchParams({
    organization_fingerprint: `eq.${organizationFingerprint}`, connection_id: `eq.${connectionId}`,
    account_id: `eq.${accountId}`, user_id: `eq.${userId}`, select: "can_manage_campaign_brand_mapping", limit: "1",
  });
  try {
    const rows = await request(`/rest/v1/account_campaign_map_grant?${q}`, { signal });
    return Boolean(Array.isArray(rows) && rows[0] && rows[0].can_manage_campaign_brand_mapping === true);
  } catch (e) { if (isSchemaMissingError(e)) return false; throw e; }
}

// Single-row campaign mapping assign/change/clear via the SECURITY DEFINER RPC (atomic + audited). Blank brandKey = clear.
export async function recordCampaignBrandMapping({ organizationFingerprint, connectionId = "primary", accountId, marketplace, adsProfileId = "", campaignId, brandKey = "", brandDisplay = "", source = "MANUAL", note = "", actor = null, actorEmail = "" }) {
  const body = await request("/rest/v1/rpc/record_campaign_brand_mapping", {
    method: "POST",
    body: {
      p_organization_fingerprint: organizationFingerprint, p_connection_id: connectionId, p_account_id: accountId,
      p_marketplace: marketplace, p_ads_profile_id: adsProfileId == null ? "" : String(adsProfileId), p_ad_campaign_id: campaignId,
      p_brand_key: brandKey == null ? "" : String(brandKey), p_brand_display: brandDisplay == null ? "" : String(brandDisplay),
      p_source: source, p_note: note == null ? "" : String(note), p_actor: actor, p_actor_email: actorEmail,
    },
  });
  return Array.isArray(body) ? body[0] : body;
}

// Atomic BULK campaign mapping apply for ONE account, all-or-nothing. rows:[{marketplace, adsProfileId, campaignId,
// brandKey, brandDisplay, note}] -- a blank brandKey CLEARS that campaign.
export async function recordCampaignBrandMappingBulk({ organizationFingerprint, connectionId = "primary", accountId, rows, actor = null, actorEmail = "" }) {
  const p_rows = (Array.isArray(rows) ? rows : []).map((r) => ({
    marketplace: String(r.marketplace ?? ""), ads_profile_id: String(r.adsProfileId ?? r.ads_profile_id ?? ""),
    ad_campaign_id: String(r.campaignId ?? r.ad_campaign_id ?? ""), brand_key: String(r.brandKey ?? r.brand_key ?? ""),
    brand_display: String(r.brandDisplay ?? r.brand_display ?? ""), note: String(r.note ?? ""),
  }));
  const body = await request("/rest/v1/rpc/record_campaign_brand_mapping_bulk", {
    method: "POST",
    body: { p_organization_fingerprint: organizationFingerprint, p_connection_id: connectionId, p_account_id: accountId, p_rows, p_actor: actor, p_actor_email: actorEmail },
  });
  return Array.isArray(body) ? body[0] : body;
}

// List ONE user's campaign-mapping capability grants (admin view). Returns [{accountId, canManage, updatedAt}].
// Account-scope-agnostic read of the user's own grant rows. Fail-soft: schema-missing => [].
export async function getUserCampaignMappingCapabilities({ userId, organizationFingerprint = null, connectionId = null, signal = null } = {}) {
  if (!userId) return [];
  const params = { user_id: `eq.${userId}`, can_manage_campaign_brand_mapping: "eq.true", select: "account_id,can_manage_campaign_brand_mapping,updated_at", order: "account_id.asc" };
  if (organizationFingerprint) params.organization_fingerprint = `eq.${organizationFingerprint}`;
  if (connectionId) params.connection_id = `eq.${connectionId}`;
  try {
    const rows = await request(`/rest/v1/account_campaign_map_grant?${new URLSearchParams(params)}`, { signal });
    return (Array.isArray(rows) ? rows : []).map((r) => ({ accountId: r.account_id, canManage: r.can_manage_campaign_brand_mapping === true, updatedAt: r.updated_at }));
  } catch (e) { if (isSchemaMissingError(e)) return []; throw e; }
}

// Admin GRANT (enabled=true) / REVOKE (enabled=false) of ONE (user, account) campaign-mapping capability via the
// SECURITY DEFINER RPC (atomic + audited). The admin api/ layer authorizes the caller + proves the target user's
// account access BEFORE calling this; the RPC never creates account or brand access. Idempotent both ways.
export async function setCampaignMappingCapability({ organizationFingerprint, connectionId = "primary", accountId, userId, enabled, actor = null, actorEmail = "", correlationId = "" }) {
  if (!userId || !accountId) throw new DashboardAccessError("A user and account are required.", 400);
  const body = await request("/rest/v1/rpc/set_campaign_map_capability", {
    method: "POST",
    body: {
      p_organization_fingerprint: String(organizationFingerprint || ""), p_connection_id: connectionId, p_account_id: String(accountId),
      p_user_id: userId, p_enabled: Boolean(enabled), p_actor: actor, p_actor_email: String(actorEmail || ""), p_correlation_id: String(correlationId || ""),
    },
  });
  return Array.isArray(body) ? body[0] : body;
}

const ADS_ROW_CONFLICT_KEY = "source_key,account_id,marketplace_country_code,metric_date,dimension_key";

export async function getAdsSyncStates(accountIds) {
  if (!accountIds.length) return [];
  const query = new URLSearchParams({
    select: "account_id,source_key,initial_seeded_at,last_daily_sync_at,last_monthly_sync_at,latest_metric_date,last_status,last_error",
    account_id: `in.(${accountIds.join(",")})`,
  });
  return request(`/rest/v1/ads_sync_state?${query}`);
}

export async function upsertAdsDailyRows(rows) {
  // Keep PostgREST request bodies bounded for large ASIN/targeting exports.
  for (let start = 0; start < rows.length; start += 500) {
    await request(`/rest/v1/ads_daily_source_rows?on_conflict=${ADS_ROW_CONFLICT_KEY}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: rows.slice(start, start + 500),
    });
  }
}

// Delete ONE account's durable rows for a source over [from,to] so a fresh export cleanly REPLACES that window.
// Needed when the export's natural grain changes (e.g. asin-performance-v1 moving from campaign grain to the
// aggregated ASIN grain): stale rows of the old grain have different dimension_keys, so an upsert would leave them
// in place and the per-date fold would DOUBLE COUNT. Scoped to exactly (source_key, account_id, metric_date range)
// -- other windows and accounts are untouched. Returns a typed ack; a schema-missing table is a safe no-op.
export async function deleteAdsDailySourceRows({ accountId, sourceKey, from, to, signal = null }) {
  const query = new URLSearchParams({ source_key: `eq.${sourceKey}`, account_id: `eq.${accountId}`, metric_date: `gte.${from}` });
  query.append("metric_date", `lte.${to}`);
  try {
    await request(`/rest/v1/ads_daily_source_rows?${query}`, { method: "DELETE", headers: { Prefer: "return=minimal" }, signal });
    return { write: "ok", error: null };
  } catch (writeError) {
    if (isSchemaMissingError(writeError)) return { write: "schema-missing", error: "ADS_ROWS_SCHEMA_MISSING" };
    return { write: "write-failed", error: "ADS_ROWS_DELETE_FAILED" };
  }
}

export async function upsertAdDailyMetrics(rows) {
  if (!rows.length) return;
  await request("/rest/v1/ad_daily_metrics?on_conflict=account_id,metric_date,campaign_id,campaign_type,currency", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: rows,
  });
}

/* ===================== SCHEDULED SYNC (foundation) =====================
 * Thin wrappers over the private service-role `request()`. All of these run
 * server-side only; the browser never calls them. Tables are created by
 * supabase/migrations/20260805_scheduled_sync.sql. sync_targets / sync internals
 * are RLS-no-policy (service-role only); users see status via the account-scoped
 * endpoint in api/sync.js. */

/**
 * Upsert the discovered account directory. `first_seen_at` is intentionally NOT
 * in the payload, so a conflict update keeps the original discovery time (the DB
 * default fills it only on first insert).
 */
export async function upsertAccountDirectory(rows) {
  if (!rows.length) return;
  const nowIso = new Date().toISOString();
  const body = rows.map((r) => ({
    account_id: r.accountId,
    connection_id: r.connectionId || "primary",
    marketplace_country_code: r.country || "",
    currency: r.currency || "",
    name: r.name || "",
    sync_bucket: r.bucket || "unknown",
    last_seen_at: nowIso,
  }));
  await request("/rest/v1/account_directory?on_conflict=account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body,
  });
}

export async function getAccountDirectoryRows(accountIds) {
  const params = new URLSearchParams({
    select: "account_id,connection_id,marketplace_country_code,currency,name,sync_bucket,last_seen_at",
  });
  if (accountIds && accountIds.length) params.set("account_id", `in.(${accountIds.map((id) => `"${id}"`).join(",")})`);
  return request(`/rest/v1/account_directory?${params}`);
}

/* ===================== ACCOUNT ONBOARDING (Primary DataDoe automatic onboarding) =====================
 * Durable onboarding state for every PRIMARY account (supabase/migrations/20260919_account_onboarding.sql).
 * Service-role only writes; the atomic bootstrap claim goes through the SECURITY DEFINER RPC. All readers
 * FAIL SOFT to null so the export-eligibility gate can degrade to its readiness-only mode (loading accounts
 * stay excluded; existing ready accounts keep publishing) while the migration is pending or a read fails. */

// All onboarding rows, or NULL when the table is unreadable/absent (fail-soft -- caller degrades).
export async function getAccountOnboardingRows() {
  try {
    const params = new URLSearchParams({
      select: "account_id,connection_id,name,marketplace_country_code,marketplace_id,region,status,"
        + "datadoe_ready,datadoe_row_count,seller_central_row_count,ads_connected,ads_ready,ads_row_count,"
        + "sources,failure_code,operation_id,first_discovered_at,last_seen_at,ready_at,bootstrap_started_at,"
        + "bootstrap_completed_at,last_attempt_at,next_retry_at,updated_at",
      order: "account_id.asc",
    });
    const rows = await request(`/rest/v1/account_onboarding?${params}`);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

// Idempotent upsert of onboarding rows (merge-duplicates on account_id). `first_discovered_at` is
// intentionally NOT in the payload so a conflict update preserves the original discovery time, and
// `operation_id`/`bootstrap_started_at` are NEVER written here -- only the claim RPC owns them.
//
// PostgREST rejects a bulk-upsert array whose objects have DIFFERENT key sets with HTTP 400 "All object keys must
// match". Discovery rows legitimately OMIT optional columns per status (e.g. ready_at, bootstrap_completed_at), and
// omission is load-bearing: a merge-duplicates upsert that OMITS a column preserves its durable value, whereas
// sending it as null would ERASE it. So we GROUP rows by their exact key signature and send ONE upsert per group --
// every object in a request has identical keys (no 400), and omitted columns stay untouched. Any group failure
// throws (the caller must treat the whole pass as failed, never partially succeeded); each row is idempotent, so a
// retry re-applies cleanly and never erases ready_at / bootstrap_completed_at / operation_id / failure evidence.
export async function upsertAccountOnboardingRows(rows) {
  if (!rows || !rows.length) return;
  const groups = new Map(); // sorted-key signature -> [owned rows]
  for (const r of rows) {
    const { first_discovered_at: _fd, operation_id: _op, bootstrap_started_at: _bs, ...owned } = r;
    const signature = Object.keys(owned).sort().join(","); // comma-separated so distinct key sets can never collide
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(owned);
  }
  for (const body of groups.values()) {
    await request("/rest/v1/account_onboarding?on_conflict=account_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body,
    });
  }
}

// P0-D: the CONCURRENCY-SAFE discovery reconciliation (SECURITY DEFINER RPC reconcile_account_onboarding_discovery,
// migration 20260922). Per row, under a row lock: refresh discovery-owned fields, apply the proposed status ONLY as a
// valid FORWARD transition (claim-owned bootstrapping/partially_ready/ready never regress), preserve claim-owned
// evidence (operation_id / bootstrap_started_at / first_discovered_at) and set-once timestamps. Atomic + idempotent.
// Throws a typed ONBOARDING_RECONCILE_RPC_ABSENT when the function is not applied yet (migration pending) so the
// caller can fall back to the grouped merge-upsert -- the code is therefore safe to deploy BEFORE the migration.
export async function reconcileAccountOnboardingDiscovery(rows) {
  if (!rows || !rows.length) return { disposition: "reconciled", inserted: 0, updated: 0 };
  try {
    const res = await request("/rest/v1/rpc/reconcile_account_onboarding_discovery", {
      method: "POST",
      body: { p_rows: rows },
    });
    return res || null;
  } catch (e) {
    const msg = String((e && e.message) || e);
    // PostgREST answers 404 / PGRST202 when the function is absent (migration pending). Signal typed for fallback.
    if (/PGRST202|Could not find the function|does not exist|not\s+found|\b404\b/i.test(msg)) {
      const err = new Error("ONBOARDING_RECONCILE_RPC_ABSENT: reconcile_account_onboarding_discovery is not applied yet");
      err.code = "ONBOARDING_RECONCILE_RPC_ABSENT";
      throw err;
    }
    throw e;
  }
}

// The ATOMIC bootstrap claim (SECURITY DEFINER RPC): transitions ready_for_bootstrap -> bootstrapping
// exactly once per account; the same operation id is idempotent ('already-claimed'), a different one is
// refused ('held'). Returns the RPC's typed jsonb disposition.
export async function claimAccountBootstrap({ accountId, operationId }) {
  const rows = await request("/rest/v1/rpc/claim_account_bootstrap", {
    method: "POST",
    body: { p_account_id: accountId, p_operation_id: operationId },
  });
  return rows || null;
}

// The ATOMIC per-region-wave dispatch LEASE (SECURITY DEFINER RPC): APPEND-ONLY by (region, dispatch_id);
// at most ONE active execution per region; bounded backoff prevents dispatch spam; 'completed' is
// terminal for the wave; the stored wave scope (wave_key/account_ids/operation_ids) is IMMUTABLE. Typed
// jsonb dispositions: leased | not-due | completed | region-busy | refused(WAVE_IDENTITY_MISMATCH).
export async function leaseOnboardingDispatch({ region, dispatchId, waveKey, accountIds, operationIds }) {
  const rows = await request("/rest/v1/rpc/lease_onboarding_dispatch", {
    method: "POST",
    body: { p_region: region, p_dispatch_id: dispatchId, p_wave_key: waveKey, p_account_ids: accountIds || [], p_operation_ids: operationIds || [] },
  });
  return rows || null;
}

// Durable, idempotent AWAITING-BUDGET hold (SECURITY DEFINER RPC): a claimed wave with no authorized
// budget is recorded (append-only by (region, dispatch_id)) and NEVER dispatched; an existing row for
// the same identity in a later state is left untouched; OTHER waves' rows are never modified. Typed
// jsonb dispositions: awaiting-budget | unchanged.
export async function markOnboardingDispatchAwaitingBudget({ region, dispatchId, waveKey, accountIds, operationIds }) {
  const rows = await request("/rest/v1/rpc/mark_onboarding_dispatch_awaiting_budget", {
    method: "POST",
    body: { p_region: region, p_dispatch_id: dispatchId, p_wave_key: waveKey, p_account_ids: accountIds || [], p_operation_ids: operationIds || [] },
  });
  return rows || null;
}

// The bootstrap RUN's durable acknowledgement (SECURITY DEFINER RPC), keyed by its dispatch identity:
// phase 'running' (extends the lease horizon), 'completed' (terminal; only after successful scoped
// source processing) or 'failed' (retryable after bounded backoff). Typed jsonb dispositions:
// acked | already-completed | not-found.
export async function ackOnboardingDispatch({ region, dispatchId, phase, note, runToken }) {
  const rows = await request("/rest/v1/rpc/ack_onboarding_dispatch", {
    method: "POST",
    body: { p_region: region, p_dispatch_id: dispatchId, p_phase: phase, p_note: note ?? null, p_run_token: runToken },
  });
  return rows || null;
}

// (Round-7 blocker 3) recordOnboardingUnavailable / getOnboardingUnavailable were REMOVED with the
// account_onboarding_unavailable table -- fba-plan never self-declares "source unavailable" (an empty
// validated D-1 inventory is a VALID published snapshot; a missing/failed source blocks and preserves LKG),
// so completion is proven ONLY by the publication manifest.

export async function recordOnboardingDispatchError({ region, dispatchId, error }) {
  const rows = await request("/rest/v1/rpc/record_onboarding_dispatch_error", {
    method: "POST",
    body: { p_region: region, p_dispatch_id: dispatchId, p_error: error },
  });
  return rows || null;
}

export async function completeOnboardingDispatch({ region, dispatchId }) {
  const rows = await request("/rest/v1/rpc/complete_onboarding_dispatch", {
    method: "POST",
    body: { p_region: region, p_dispatch_id: dispatchId },
  });
  return rows || null;
}

// Record ONE durable publication-manifest row: the EXACT live identity (params_hash + coversAsOf) + the
// PROVENANCE (real durable cycle_id + operation_key + the ACTIVE run_token) the wave produced for a (report,
// account). The RPC rejects blank provenance, a bucket-label cycle_id, an unknown dispatch, an out-of-membership
// account, and a run_token that is not the dispatch's active attempt (returns 'stale-run-token'). The
// completion proof re-reads by this exact identity (never the newest) and compares the run_token.
export async function recordOnboardingPublication({ region, dispatchId, accountId, reportKey, paramsHash, coversAsOf, cycleId, cycleBucket, operationKey, runToken }) {
  const rows = await request("/rest/v1/rpc/record_onboarding_publication", {
    method: "POST",
    body: { p_region: region, p_dispatch_id: dispatchId, p_account_id: accountId, p_report_key: reportKey, p_params_hash: paramsHash, p_covers_asof: coversAsOf, p_cycle_id: cycleId ?? "", p_cycle_bucket: cycleBucket ?? "", p_operation_key: operationKey ?? "", p_run_token: runToken ?? "" },
  });
  return rows || null;
}

// The publication-manifest rows for an EXACT (region, dispatch_id) -- read by the completion verifier.
// STRICT read: a transport failure throws (fail closed). Returns
// [{ account_id, report_key, params_hash, covers_asof, cycle_id, operation_key, run_token }].
export async function getOnboardingPublication({ region, dispatchId }) {
  const params = new URLSearchParams({
    select: "account_id,report_key,params_hash,covers_asof,cycle_id,operation_key,run_token",
    region: `eq.${region}`,
    dispatch_id: `eq.${dispatchId}`,
  });
  const rows = await request(`/rest/v1/account_onboarding_publication?${params}`);
  return Array.isArray(rows) ? rows : [];
}

// Round-8/11 blocker 1: standalone (non-transactional) control-plane lease HEARTBEAT helpers over the SECURITY
// DEFINER RPCs -- used by the publish-phase fence (outside the control transaction). renew extends the EXACT
// immutable fence (returns 'renewed' or 'lost'); read reconciles. Round-11 P0-A: there is DELIBERATELY NO
// standalone acquire wrapper -- a publication path must NEVER re-acquire the control-plane lease (it would
// mint a NEW generation and could publish under controls another generation opened). The ONLY place a lease is
// ACQUIRED is INSIDE the guarded control transaction (runControlPackageTransaction apply/reclaim, via the pg
// store's acquireControlLease); publication renews the generation the matching --apply emitted.
export async function renewControlPlaneLease({ ownerToken, generation, ttlSeconds }) {
  return await request("/rest/v1/rpc/renew_control_plane_lease", {
    method: "POST", body: { p_owner_token: ownerToken, p_generation: generation == null ? null : Number(generation), p_ttl_seconds: Number(ttlSeconds) || 900 },
  });
}
export async function readControlPlaneLease() {
  return await request("/rest/v1/rpc/read_control_plane_lease", { method: "POST", body: {} });
}

// The dispatch-wave rows (read-only; every write goes through the lease/mark/ack/error/complete RPCs).
// Fail-soft: null when unreadable -- the worker then skips completion detection for the pass.
export async function getOnboardingDispatchRows() {
  try {
    const params = new URLSearchParams({
      select: "region,dispatch_id,wave_key,status,attempts,last_attempt_at,last_error,next_retry_at,account_ids,operation_ids,updated_at",
      order: "region.asc,updated_at.desc",
    });
    const rows = await request(`/rest/v1/account_onboarding_dispatch?${params}`);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

// The ONE durable dispatch wave row for an EXACT (region, dispatch_id) -- the authoritative, IMMUTABLE
// scope the bootstrap workflow step resolves its account/operation set from. STRICT read: a transport
// failure throws (fail closed; a bootstrap step must never widen scope on an unreadable row). Returns
// the row or null when the wave does not exist.
export async function getOnboardingDispatchRow({ region, dispatchId }) {
  const params = new URLSearchParams({
    select: "region,dispatch_id,wave_key,status,attempts,last_error,next_retry_at,active_run_token,account_ids,operation_ids,updated_at",
    region: `eq.${region}`,
    dispatch_id: `eq.${dispatchId}`,
    limit: "1",
  });
  const rows = await request(`/rest/v1/account_onboarding_dispatch?${params}`);
  return Array.isArray(rows) ? (rows[0] || null) : null;
}

// The durable onboarding-wave BUDGET (the ENFORCED paid ceiling). Fail-soft read: null when the table is
// unreadable/absent -- every bootstrap-scoped paid operator treats null/absent as NOT AUTHORIZED (refuse
// before any create POST).
export async function getOnboardingBudget(budgetKey) {
  try {
    const params = new URLSearchParams({
      select: "budget_key,authorized_tokens,plan_fingerprint,status,reserved_tokens,spent_tokens,reservations,approved_plan,wave_accounts,wave_operations,wave_regions,updated_at",
      budget_key: `eq.${budgetKey}`,
      limit: "1",
    });
    const rows = await request(`/rest/v1/account_onboarding_budget?${params}`);
    return Array.isArray(rows) ? (rows[0] || null) : null;
  } catch {
    return null;
  }
}

// The ATOMIC, DRIFT-VALIDATED, RETRY-SAFE pre-POST reservation against the wave budget (SECURITY
// DEFINER RPC). Every reservation carries the step type, region, exact account-set hash, plan
// fingerprint AND the per-step plan hash (which binds dates/windows/sources/batches/membership); the
// RPC validates all of them against the wave's APPROVED plan, reserves the approved CEILING, and tracks
// CUMULATIVE actuals so a retry reuses the one reservation. tokens/creates = THIS attempt's plan.
// Typed dispositions: reserved | already-reserved (retry reuses; fits remaining headroom) | refused
// (PLAN_DRIFT / BUDGET_NOT_AUTHORIZED / BUDGET_CLOSED / BUDGET_EXCEEDED -- refuse BEFORE any create).
export async function reserveOnboardingSpend({ budgetKey, ref, stepType, region, accountSetHash, planFingerprint, stepPlanHash, tokens, creates }) {
  const rows = await request("/rest/v1/rpc/reserve_onboarding_spend", {
    method: "POST",
    body: {
      p_budget_key: budgetKey, p_ref: ref, p_step_type: stepType, p_region: region,
      p_account_set_hash: accountSetHash, p_plan_fingerprint: planFingerprint, p_step_plan_hash: stepPlanHash,
      p_tokens: tokens, p_creates: creates,
    },
  });
  return rows || null;
}

export async function recordOnboardingSpendActual({ budgetKey, ref, actualTokens, actualCreates }) {
  const rows = await request("/rest/v1/rpc/record_onboarding_spend_actual", {
    method: "POST",
    body: { p_budget_key: budgetKey, p_ref: ref, p_actual_tokens: actualTokens, p_actual_creates: actualCreates },
  });
  return rows || null;
}

// Distinct (account_id, report_key) presence pairs for the given accounts/keys -- the onboarding
// worker's zero-cost durable-evidence probe (grading bootstrapping -> partially_ready -> ready).
// EXACT per-pair existence reads (limit=1): a bulk read of the raw snapshot rows can exceed the
// PostgREST row cap and silently truncate pairs (proven on the 34-account seed rehearsal), which
// would falsely grade a fully-serving account as partial. Steady state probes only a handful of
// accounts, so the pair fan-out stays tiny; the one-time seed pass is bounded (accounts x keys).
export async function getReportSnapshotPresence({ accountIds, reportKeys }) {
  if (!accountIds?.length || !reportKeys?.length) return [];
  const pairs = [];
  for (const accountId of accountIds) {
    for (const reportKey of reportKeys) {
      const params = new URLSearchParams({
        select: "id",
        account_id: `eq.${accountId}`,
        report_key: `eq.${reportKey}`,
        limit: "1",
      });
      const rows = await request(`/rest/v1/report_snapshots?${params}`);
      if (Array.isArray(rows) && rows.length) pairs.push({ accountId, reportKey });
    }
  }
  return pairs;
}

/**
 * The latest org-wide ACCOUNT-DIRECTORY snapshot accounts (report_snapshots, report_key 'account-directory').
 * This is the COMPLETE, authoritative directory (every primary account with its marketplace country + currency)
 * that the FBA Shipment Plan operator + the Data Sync Center FBA sync resolve their account scope + go-live as-of
 * from. The account_directory TABLE (getAccountDirectoryRows) is populated INCREMENTALLY by bucket syncs and can
 * lag (proven: 22/30 while this snapshot holds 30/30), so it must NEVER seed FBA scope resolution. Returns an
 * array of { accountId, country, currency, name } (best-effort field aliasing); [] when the snapshot is absent.
 */
export async function getAccountDirectorySnapshotAccounts() {
  const query = new URLSearchParams({
    select: "payload,updated_at",
    report_key: "eq.account-directory",
    order: "updated_at.desc",
    limit: "1",
  });
  const rows = await request(`/rest/v1/report_snapshots?${query}`);
  const payload = rows && rows[0] ? rows[0].payload : null;
  const accounts = Array.isArray(payload && payload.accounts) ? payload.accounts : (Array.isArray(payload) ? payload : []);
  return accounts
    // A "Setting up" entry (merged by the onboarding discovery worker before the account is export-
    // eligible) is VISIBLE to admins in the selector but must NEVER seed an operator/scheduler scope:
    // it has no durable evidence yet and a paid export for it would be premature (or, while DataDoe is
    // still loading it, hard-rejected with HTTP 400). Legacy entries have no settingUp field and are
    // included unchanged.
    .filter((a) => !(a && a.settingUp === true))
    .map((a) => ({
      accountId: String((a && (a.accountId || a.id || a.account_id)) || "").trim(),
      country: String((a && (a.country || a.marketCountry || a.marketplace)) || "").trim(),
      currency: (a && a.currency) || null,
      name: (a && a.name) || null,
    })).filter((a) => a.accountId);
}

export async function insertSyncRun({ bucket, trigger, createdBy = null }) {
  const rows = await request("/rest/v1/sync_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: { bucket, trigger, status: "running", created_by: createdBy },
  });
  return rows[0];
}

export async function updateSyncRun(id, { status, finishedAt, counts }) {
  const body = {};
  if (status !== undefined) body.status = status;
  if (finishedAt !== undefined) body.finished_at = finishedAt;
  if (counts !== undefined) body.counts = counts;
  await request(`/rest/v1/sync_runs?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body,
  });
}

export async function getSyncTargets({ reportKeys, accountIds } = {}) {
  const params = new URLSearchParams({
    select: "report_key,account_id,last_status,last_attempt_at,last_success_at,source_refreshed_at,latest_data_date,cycle_date,attempts,next_eligible_at,last_error",
  });
  if (reportKeys && reportKeys.length) params.set("report_key", `in.(${reportKeys.map((k) => `"${k}"`).join(",")})`);
  if (accountIds && accountIds.length) params.set("account_id", `in.(${accountIds.map((id) => `"${id}"`).join(",")})`);
  return request(`/rest/v1/sync_targets?${params}`);
}

export async function upsertSyncTarget(target) {
  const body = {
    report_key: target.reportKey,
    account_id: target.accountId,
    last_status: target.lastStatus,
  };
  if (target.lastRunId !== undefined) body.last_run_id = target.lastRunId;
  if (target.lastAttemptAt !== undefined) body.last_attempt_at = target.lastAttemptAt;
  if (target.attempts !== undefined) body.attempts = target.attempts;
  if (target.nextEligibleAt !== undefined) body.next_eligible_at = target.nextEligibleAt;
  if (target.cycleDate !== undefined) body.cycle_date = target.cycleDate;
  // Only advance success markers on an actual success, so a later failure never
  // erases the last-known-good timestamps.
  if (target.lastStatus === "succeeded") {
    body.last_success_at = target.lastSuccessAt || new Date().toISOString();
    if (target.sourceRefreshedAt) body.source_refreshed_at = target.sourceRefreshedAt;
    if (target.latestDataDate) body.latest_data_date = target.latestDataDate;
    body.last_error = null;
  } else if (target.lastError !== undefined) {
    body.last_error = target.lastError ? String(target.lastError).slice(0, 1000) : null;
  }
  await request("/rest/v1/sync_targets?on_conflict=report_key,account_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body,
  });
}

export async function pruneScheduledReportSnapshots({ reportKey, accountId, keepParamsHash }) {
  return request("/rest/v1/rpc/prune_scheduled_report_snapshots", {
    method: "POST",
    body: {
      p_report_key: reportKey,
      p_account_id: accountId,
      p_keep_params_hash: keepParamsHash,
    },
  });
}

export async function insertSyncError({ runId, reportKey = "", accountId = "", phase, message }) {
  await request("/rest/v1/sync_errors", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: {
      run_id: runId || null,
      report_key: reportKey,
      account_id: accountId,
      phase,
      message: String(message || "").slice(0, 2000),
    },
  }).catch(() => {});
}

export async function insertAuditLog({ actorUserId = null, action, target = {} }, { signal = null } = {}) {
  await request("/rest/v1/audit_log", {
    method: "POST",
    signal,
    headers: { Prefer: "return=minimal" },
    body: { actor_user_id: actorUserId, action, target },
  }).catch(() => {});
}

export async function getReportSyncSettings({ signal = null } = {}) {
  return request("/rest/v1/report_sync_settings?select=report_key,schedule_enabled,updated_at&order=report_key.asc", { signal });
}

export async function setReportSyncSetting({ reportKey, scheduleEnabled, updatedBy }) {
  const rows = await request("/rest/v1/report_sync_settings?on_conflict=report_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: {
      report_key: reportKey,
      schedule_enabled: scheduleEnabled === true,
      updated_by: updatedBy || null,
      updated_at: new Date().toISOString(),
    },
  });
  return rows[0] || null;
}

/* Round-6 blocker 2 -- SOURCE-PROMOTED publication controls (20260821_source_promoted_publish_controls.sql,
 * PREPARED-UNAPPLIED). A source-promoted report (brand-inventory) is PRODUCED by the source-first durable
 * runtime and PROMOTED to live ONLY through the reviewed publisher, gated by its OWN durable enable flag --
 * SEPARATE from report_sync_settings (the 13-report DISPATCH control). Default OFF (seeded publish_enabled
 * = false), fail-closed: a schema-missing (unapplied migration) or read failure reads as [] so the publisher
 * gate resolves to report-disabled. This control NEVER feeds dispatcher selection (brand-inventory is not in
 * CONTROLLED_REPORT_KEYS), so enabling publication can never dispatch a DataDoe export. */
export async function getSourcePromotedPublishSettings({ signal = null } = {}) {
  try {
    const rows = await request("/rest/v1/source_promoted_publish_settings?select=report_key,publish_enabled,updated_at&order=report_key.asc", { signal });
    return Array.isArray(rows) ? rows : [];
  } catch (readError) {
    // schema-missing (migration unapplied) OR any read failure => zero enabled rows (fail closed).
    return [];
  }
}

export async function setSourcePromotedPublishControl({ reportKey, publishEnabled, updatedBy, signal = null }) {
  // Round-7 finding 2: the command requires a STRICT boolean and a VALIDATED single-row durable
  // acknowledgement -- exact canonical report_key, publish_enabled EXACTLY equal to the requested boolean,
  // and a valid updated_at. A null/empty/multi-row/malformed/wrong-key/wrong-state acknowledgement throws a
  // typed safe error so the caller NEVER records a success audit or returns 200 on an unproven write.
  const key = String(reportKey || "").trim();
  if (!key) {
    const err = new Error("PROMOTED_PUBLISH_CONTROL_INVALID: a nonblank canonical reportKey is required (fail closed).");
    err.code = "PROMOTED_PUBLISH_CONTROL_INVALID"; err.status = 400; throw err;
  }
  if (typeof publishEnabled !== "boolean") {
    const err = new Error("PROMOTED_PUBLISH_CONTROL_INVALID: publishEnabled must be a boolean (fail closed).");
    err.code = "PROMOTED_PUBLISH_CONTROL_INVALID"; err.status = 400; throw err;
  }
  const rows = await request("/rest/v1/source_promoted_publish_settings?on_conflict=report_key", {
    method: "POST",
    signal,
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: {
      report_key: key,
      publish_enabled: publishEnabled,
      updated_by: updatedBy || null,
      updated_at: new Date().toISOString(),
    },
  });
  const bad = (reason) => {
    const err = new Error(`PROMOTED_PUBLISH_CONTROL_ACK_INVALID: ${reason}; the control write is unacknowledged (fail closed).`);
    err.code = "PROMOTED_PUBLISH_CONTROL_ACK_INVALID"; err.status = 502; throw err;
  };
  if (!Array.isArray(rows) || rows.length !== 1) bad(`expected exactly one returned row (got ${Array.isArray(rows) ? rows.length : typeof rows})`);
  const row = rows[0];
  if (!row || typeof row !== "object") bad("the acknowledgement row is not an object");
  if (String(row.report_key) !== key) bad(`the acknowledgement report_key ${JSON.stringify(row.report_key)} does not equal the requested ${JSON.stringify(key)}`);
  if (row.publish_enabled !== publishEnabled) bad(`the acknowledgement publish_enabled ${JSON.stringify(row.publish_enabled)} does not equal the requested ${publishEnabled}`);
  if (typeof row.updated_at !== "string" || Number.isNaN(Date.parse(row.updated_at))) bad("the acknowledgement has no valid updated_at");
  return { reportKey: key, publishEnabled, updatedAt: row.updated_at };
}

/* ===================== Scheduler v2 (Phase 1c) — source-first cycle =====================
   Thin wrappers over the three additive tables + three RPCs in
   20260807_scheduler_v2.sql. Service-role only (RLS bypassed for writes). These power
   the SHADOW-MODE source worker; they never store an API key or a raw DataDoe error. */

// open_sync_cycle: idempotent kickoff. Returns the single cycle id for (bucket, date).
export async function openSyncCycle({ bucket, cycleDate, scheduledAt = null, trigger = "manual" }, { signal = null } = {}) {
  return request("/rest/v1/rpc/open_sync_cycle", {
    method: "POST",
    signal,
    body: { p_bucket: bucket, p_cycle_date: cycleDate, p_scheduled_at: scheduledAt, p_trigger: trigger },
  });
}

// open_superseding_sync_cycle (20260830): create-or-resume a durable SUPERSEDING attempt on the same
// (bucket, cycle_date) as a stale terminal cycle, WITHOUT mutating the terminal one. Idempotent by operation_key.
export async function openSupersedingSyncCycle({ bucket, cycleDate, operationKey, supersedesCycleId, attemptKind, scheduledAt = null, trigger = "manual" }, { signal = null } = {}) {
  return request("/rest/v1/rpc/open_superseding_sync_cycle", {
    method: "POST",
    signal,
    body: { p_bucket: bucket, p_cycle_date: cycleDate, p_operation_key: operationKey, p_supersedes_cycle_id: supersedesCycleId, p_attempt_kind: attemptKind, p_scheduled_at: scheduledAt, p_trigger: trigger },
  });
}

// claim_sync_cycle: pending -> running; true only for the worker that won the start.
export async function claimSyncCycle(cycleId, { signal = null } = {}) {
  return request("/rest/v1/rpc/claim_sync_cycle", { method: "POST", signal, body: { p_cycle_id: cycleId } });
}

export async function getSyncCycle(cycleId, { signal = null } = {}) {
  const query = new URLSearchParams({
    // Round-10 blocker 1: created_at is the DATABASE-authoritative, retry-stable freshness authority for this
    // cycle's derived shadow snapshots (never the caller/route wall clock).
    select: "id,bucket,cycle_date,status,created_at,started_at,finished_at,source_total,source_succeeded,source_failed",
    id: `eq.${cycleId}`,
    limit: "1",
  });
  const rows = await request(`/rest/v1/sync_cycles?${query}`, { signal });
  return rows[0] || null;
}

// Read-only lookup of the ACTIVE cycle attempt for (bucket, cycle_date). With the superseding-attempt model
// (20260830) a stale terminal cycle may be SUPERSEDED by a new running attempt on the same slot; this resolves the
// ACTIVE, non-superseded HEAD of the supersession chain -- the cycle that no other cycle supersedes. Exactly one
// head is expected; zero rows -> null; a fork (more than one head) or a headless chain FAILS CLOSED. Selects
// operation_key/supersedes_cycle_id/attempt_kind + trigger so callers can prove identity + a reviewed manual run.
// Recent sync-cycle ids for one bucket at/after `sinceDate` (adaptive FBA-inventory overflow evidence: scan recent
// region-fba cycles for terminal TRUNCATED inventory jobs). Read-only; returns [cycleId] newest-first, bounded.
export async function getRecentSyncCycleIds(bucket, sinceDate, { signal = null, limit = 60 } = {}) {
  const query = new URLSearchParams({
    select: "id,cycle_date,created_at",
    bucket: `eq.${bucket}`,
    cycle_date: `gte.${sinceDate}`,
    // created_at is the intra-date tiebreak so the returned ids are STRICTLY newest-first even when a base cycle and
    // its superseding attempt(s) share one cycle_date. The readiness-isolation reader relies on this ordering for its
    // first-seen-wins recency (a newer rejection must never be masked by a stale same-date success); the truncated-
    // overflow readers are order-independent, so this is a safe refinement.
    order: "cycle_date.desc,created_at.desc",
    limit: String(limit),
  });
  const rows = await request(`/rest/v1/sync_cycles?${query}`, { signal });
  return Array.isArray(rows) ? rows.map((r) => r.id).filter(Boolean) : [];
}

export async function getSyncCycleByBucketDate(bucket, cycleDate, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: "id,bucket,cycle_date,status,trigger,operation_key,supersedes_cycle_id,attempt_kind,created_at,started_at,finished_at",
    bucket: `eq.${bucket}`,
    cycle_date: `eq.${cycleDate}`,
    limit: "100",
  });
  const rows = await request(`/rest/v1/sync_cycles?${query}`, { signal });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // The head is the cycle NOT referenced by any other cycle's supersedes_cycle_id (resolveActiveCycleHead): a
  // well-formed slot has exactly one head; a fork or headless chain fails closed.
  return resolveActiveCycleHead(rows);
}

// The BASE cycle for a (bucket, cycle_date): the one with supersedes_cycle_id IS NULL. The OLI operator supersedes a
// stale terminal cycle with an OLI-ONLY attempt (no Product Catalog job), so the ACTIVE HEAD can be an OLI-only
// superseding attempt. The PRIORITY RELEASE finalize verifies a cycle carrying the shared Catalog job (+ OLI jobs) --
// that job lives on the BASE cycle, so the release resolves the BASE, not the head. Exactly one base per slot (the
// partial-unique index guarantees it); >1 base fails closed; none returns null.
export async function getBaseSyncCycleByBucketDate(bucket, cycleDate, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: "id,bucket,cycle_date,status,trigger,operation_key,supersedes_cycle_id,attempt_kind,created_at,started_at,finished_at",
    bucket: `eq.${bucket}`,
    cycle_date: `eq.${cycleDate}`,
    supersedes_cycle_id: "is.null",
    limit: "10",
  });
  const rows = await request(`/rest/v1/sync_cycles?${query}`, { signal });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (rows.length > 1) throw new Error(`getBaseSyncCycleByBucketDate: ${rows.length} BASE cycles for (${bucket}, ${cycleDate}); fail closed.`);
  return rows[0];
}

// Read-only: the superseded target the ACTIVE head points at (or null). Used by the classifier/operators to prove
// they are superseding the exact terminal cycle they observed.
export async function getActiveSyncCycleChain(bucket, cycleDate, { signal = null } = {}) {
  const head = await getSyncCycleByBucketDate(bucket, cycleDate, { signal });
  return head ? { head, supersedesCycleId: head.supersedes_cycle_id ?? null } : null;
}

export async function updateSyncCycleCounts(cycleId, { sourceTotal, sourceSucceeded, sourceFailed, reportTotal, reportSucceeded, reportFailed, status } = {}, { signal = null } = {}) {
  const body = {};
  if (sourceTotal != null) body.source_total = sourceTotal;
  if (sourceSucceeded != null) body.source_succeeded = sourceSucceeded;
  if (sourceFailed != null) body.source_failed = sourceFailed;
  // Phase 1d report counters (columns already exist in 20260807_scheduler_v2.sql).
  if (reportTotal != null) body.report_total = reportTotal;
  if (reportSucceeded != null) body.report_succeeded = reportSucceeded;
  if (reportFailed != null) body.report_failed = reportFailed;
  if (status) body.status = status;
  if (!Object.keys(body).length) return;
  await request(`/rest/v1/sync_cycles?id=eq.${cycleId}`, {
    method: "PATCH",
    signal,
    headers: { Prefer: "return=minimal" },
    body,
  });
}

// finalize_sync_cycle: the GUARDED cycle finalization RPC (20260815_sync_cycle_finalize.sql). It returns a
// TOTAL, TYPED disposition -- never an ambiguous null -- so the dispatcher can act on each case distinctly:
//   'finalized'        -> this call flipped running -> terminal (cycle carries the terminal status + counters);
//   'already-terminal' -> the cycle was already terminal (idempotent, complete);
//   'open-work'        -> still running with open source/report work (continuation required);
//   'not-found'        -> unknown cycle id;
//   'invalid-status'   -> the cycle is neither running nor terminal (e.g. pending) -- fail closed.
// The RPC takes ONLY p_cycle_id (there is NO expect-status parameter to smuggle). A transport/HTTP failure
// throws inside request() (safe message; never a raw body). The response is STRICTLY validated below and any
// contradictory / malformed shape throws, so a caller can never treat a broken acknowledgement as success.
const FINALIZE_TERMINAL_STATUSES = new Set(["succeeded", "partial", "failed"]);
const isSafeNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// STRICT RFC3339 timestamptz (the PostgREST/Postgres to_jsonb representation): a string ONLY, with a full date +
// 'T' + time + a timezone that is EXACTLY 'Z'/'z' OR a numeric offset in strict '+HH:MM'/'-HH:MM' form (the
// colon and both offset digits are REQUIRED -- '+0530', '+05' and the like are rejected), a REAL calendar date +
// valid time/offset components, AND a finite parsed instant. Rejects "0"/"1", date-only, timezone-less,
// 2026-02-30T00:00:00Z, out-of-range hours/minutes/seconds/offsets, blanks, numbers, arrays, and objects.
// (Accepts optional fractional seconds so the real Postgres output is accepted.)
function isValidTimestamp(v) {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(v);
  if (!m) return false;
  const year = +m[1], month = +m[2], day = +m[3], hour = +m[4], min = +m[5], sec = +m[6];
  if (month < 1 || month > 12) return false;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dim = month === 2 && isLeap ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > dim) return false;                 // real calendar date (rejects 2026-02-30)
  if (hour > 23 || min > 59 || sec > 59) return false;    // valid time components
  if (m[7]) { if (+m[8] > 23 || +m[9] > 59) return false; } // valid +HH:MM / -HH:MM offset
  return Number.isFinite(Date.parse(v));                  // finite parsed instant
}
const countersCoherent = (c) => {
  const fields = ["source_total", "source_succeeded", "source_failed", "report_total", "report_succeeded", "report_failed"];
  if (!fields.every((f) => isSafeNonNegInt(c[f]))) return false;              // reject missing/string/fractional/negative/unsafe
  if (c.source_succeeded + c.source_failed > c.source_total) return false;    // succeeded+failed cannot exceed total
  if (c.report_succeeded + c.report_failed > c.report_total) return false;
  return true;
};
const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

// The ONE strict validator every finalize response passes through. Returns { disposition, cycle } only when the
// shape is fully coherent for its disposition; otherwise throws a safe error (fail closed). Unknown EXTRA fields
// are ignored; unknown dispositions and contradictory combinations throw.
function validateFinalizeResponse(result, cycleId) {
  if (!isPlainObject(result)) throw new Error("finalizeSyncCycle: malformed finalize response; failing closed.");
  const disposition = typeof result.disposition === "string" ? result.disposition : null;
  const cycle = result.cycle;
  if (disposition === "finalized" || disposition === "already-terminal") {
    if (!isPlainObject(cycle)) throw new Error(`finalizeSyncCycle: '${disposition}' without a cycle object; failing closed.`);
    if (cycle.id !== cycleId) throw new Error("finalizeSyncCycle: finalize acknowledgement for a different cycle id; failing closed.");
    if (!FINALIZE_TERMINAL_STATUSES.has(cycle.status)) throw new Error(`finalizeSyncCycle: '${disposition}' cycle status "${cycle.status}" is not terminal; failing closed.`);
    if (!isValidTimestamp(cycle.finished_at)) throw new Error("finalizeSyncCycle: terminal cycle is missing a valid finished_at; failing closed.");
    if (!countersCoherent(cycle)) throw new Error("finalizeSyncCycle: terminal cycle counters are missing/unsafe/incoherent; failing closed.");
    return { disposition, cycle };
  }
  if (disposition === "open-work") {
    if (!isPlainObject(cycle)) throw new Error("finalizeSyncCycle: 'open-work' without a cycle object; failing closed.");
    if (cycle.id !== cycleId) throw new Error("finalizeSyncCycle: open-work acknowledgement for a different cycle id; failing closed.");
    if (cycle.status !== "running") throw new Error(`finalizeSyncCycle: 'open-work' cycle status "${cycle.status}" is not running; failing closed.`);
    if (cycle.finished_at != null) throw new Error("finalizeSyncCycle: 'open-work' cycle has a finished_at; failing closed.");
    if (!countersCoherent(cycle)) throw new Error("finalizeSyncCycle: open-work cycle counters are missing/unsafe/incoherent; failing closed.");
    return { disposition, cycle };
  }
  if (disposition === "not-found" || disposition === "invalid-status") {
    if (cycle != null) throw new Error(`finalizeSyncCycle: '${disposition}' must not carry a cycle; failing closed.`);
    return { disposition, cycle: null };
  }
  throw new Error("finalizeSyncCycle: unknown finalize disposition; failing closed.");
}

export async function finalizeSyncCycle(cycleId, { signal = null } = {}) {
  const body = await request("/rest/v1/rpc/finalize_sync_cycle", { method: "POST", signal, body: { p_cycle_id: cycleId } });
  const result = Array.isArray(body) ? body[0] : body;
  return validateFinalizeResponse(result, cycleId);
}

// DURABLE operation-wide one-Catalog-export / two-token reservation for the Daily Reporting + Brand View
// priority release (Migration 9 -- 20260825_priority_catalog_reservation.sql -- PREPARED, UNAPPLIED). The two
// SECURITY DEFINER RPCs are the ONLY write path; service_role may only SELECT. EVERY acknowledgement is
// validated STRICTLY here (fail closed BEFORE any DataDoe POST or later write): exactly one plain object, a
// known disposition, the exact operation_key + catalog_request_hash echoes, and the disposition-dependent
// fields (created/already-recorded => the exact export_id + tokens_spent=2; reserved => no export_id + 0 tokens;
// hash-mismatch/conflict authorize no create/adoption). A loosely-accepted response can never authorize a POST.
const PRIORITY_RESERVE_DISPOSITIONS = new Set(["reserved", "exists", "hash-mismatch"]);
const PRIORITY_RECORD_DISPOSITIONS = new Set(["recorded", "already-recorded", "conflict", "hash-mismatch", "not-reserved"]);
const isPlainObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const nbStr = (v) => typeof v === "string" && v.trim() !== "";
// Exactly ONE plain-object acknowledgement: a scalar-jsonb RPC returns the object; a set-returning shape a
// 1-element array. Reject null, arrays with 0 or >1 rows, and primitives.
function priorityOneAck(body, label) {
  let ack = body;
  if (Array.isArray(body)) {
    if (body.length !== 1) throw new Error(`${label}: expected exactly one acknowledgement row (got ${body.length}); failing closed.`);
    ack = body[0];
  }
  if (!isPlainObj(ack)) throw new Error(`${label}: malformed (non-object) acknowledgement; failing closed.`);
  return ack;
}

export async function reservePriorityCatalogCreate(operationKey, catalogRequestHash, { signal = null } = {}) {
  const body = await request("/rest/v1/rpc/reserve_priority_catalog_create", {
    method: "POST", signal, body: { p_operation_key: operationKey, p_catalog_request_hash: catalogRequestHash },
  });
  const ack = priorityOneAck(body, "priority reserve");
  const d = ack.disposition;
  if (!PRIORITY_RESERVE_DISPOSITIONS.has(d)) throw new Error(`priority reserve: unknown disposition "${d}"; failing closed.`);
  if (ack.operation_key !== operationKey) throw new Error("priority reserve: operation_key echo mismatch; failing closed.");
  if (d === "hash-mismatch") {
    if (!nbStr(ack.catalog_request_hash) || ack.catalog_request_hash === catalogRequestHash) throw new Error("priority reserve: malformed hash-mismatch (reserved hash); failing closed.");
    if (ack.requested_hash !== catalogRequestHash) throw new Error("priority reserve: hash-mismatch requested_hash echo mismatch; failing closed.");
    return { disposition: "hash-mismatch", reservedHash: ack.catalog_request_hash, requestedHash: catalogRequestHash, exportId: null, tokensSpent: 0 };
  }
  if (ack.catalog_request_hash !== catalogRequestHash) throw new Error("priority reserve: catalog_request_hash echo mismatch; failing closed.");
  if (d === "reserved") {
    if (ack.export_id != null || Number(ack.tokens_spent) !== 0 || ack.status !== "reserved") throw new Error("priority reserve: malformed 'reserved' ack; failing closed.");
    return { disposition: "reserved", exportId: null, status: "reserved", tokensSpent: 0, catalogRequestHash };
  }
  if (ack.status !== "reserved" && ack.status !== "created") throw new Error("priority reserve: malformed 'exists' status; failing closed.");
  if (ack.status === "created") {
    if (!nbStr(ack.export_id) || Number(ack.tokens_spent) !== 2) throw new Error("priority reserve: 'exists'+created requires export_id + 2 tokens; failing closed.");
    return { disposition: "exists", exportId: ack.export_id, status: "created", tokensSpent: 2, catalogRequestHash };
  }
  if (ack.export_id != null || Number(ack.tokens_spent) !== 0) throw new Error("priority reserve: 'exists'+reserved requires no export_id + 0 tokens; failing closed.");
  return { disposition: "exists", exportId: null, status: "reserved", tokensSpent: 0, catalogRequestHash };
}

export async function recordPriorityCatalogExport(operationKey, catalogRequestHash, exportId, tokens, { signal = null } = {}) {
  const body = await request("/rest/v1/rpc/record_priority_catalog_export", {
    method: "POST", signal, body: { p_operation_key: operationKey, p_catalog_request_hash: catalogRequestHash, p_export_id: exportId, p_tokens: tokens },
  });
  const ack = priorityOneAck(body, "priority record");
  const d = ack.disposition;
  if (!PRIORITY_RECORD_DISPOSITIONS.has(d)) throw new Error(`priority record: unknown disposition "${d}"; failing closed.`);
  if (ack.operation_key !== operationKey) throw new Error("priority record: operation_key echo mismatch; failing closed.");
  if (d === "not-reserved") return { disposition: "not-reserved", exportId: null, tokensSpent: 0 };
  if (d === "hash-mismatch") {
    if (!nbStr(ack.catalog_request_hash) || ack.catalog_request_hash === catalogRequestHash) throw new Error("priority record: malformed hash-mismatch; failing closed.");
    if (ack.requested_hash !== catalogRequestHash) throw new Error("priority record: hash-mismatch requested_hash echo mismatch; failing closed.");
    return { disposition: "hash-mismatch", reservedHash: ack.catalog_request_hash, exportId: null, tokensSpent: 0 };
  }
  if (ack.catalog_request_hash !== catalogRequestHash) throw new Error("priority record: catalog_request_hash echo mismatch; failing closed.");
  if (d === "recorded" || d === "already-recorded") {
    if (ack.export_id !== exportId || Number(ack.tokens_spent) !== 2 || ack.status !== "created") throw new Error(`priority record: '${d}' requires the exact export_id + 2 tokens + created; failing closed.`);
    return { disposition: d, exportId, tokensSpent: 2, status: "created" };
  }
  if (!nbStr(ack.export_id) || ack.export_id === exportId) throw new Error("priority record: 'conflict' requires a DIFFERENT existing export_id; failing closed.");
  return { disposition: "conflict", exportId: ack.export_id, tokensSpent: Number(ack.tokens_spent) || 0, status: ack.status };
}

export async function getPriorityCatalogReservation(operationKey, catalogRequestHash, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: "operation_key,catalog_request_hash,export_id,tokens_spent,status,created_at,updated_at",
    operation_key: `eq.${operationKey}`, limit: "1",
  });
  const rows = await request(`/rest/v1/source_priority_catalog_reservation?${query}`, { signal });
  if (!Array.isArray(rows)) throw new Error("priority reservation read: malformed (non-array) response; failing closed.");
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("priority reservation read: expected at most one row; failing closed.");
  const r = rows[0];
  if (!isPlainObj(r)) throw new Error("priority reservation read: malformed row; failing closed.");
  if (r.operation_key !== operationKey) throw new Error("priority reservation read: operation_key mismatch; failing closed.");
  if (!nbStr(r.catalog_request_hash)) throw new Error("priority reservation read: blank catalog_request_hash; failing closed.");
  if (catalogRequestHash != null && r.catalog_request_hash !== catalogRequestHash) throw new Error("priority reservation read: catalog_request_hash mismatch; failing closed.");
  if (r.status !== "reserved" && r.status !== "created") throw new Error("priority reservation read: bad status; failing closed.");
  const coherent = (r.status === "reserved" && r.export_id == null && Number(r.tokens_spent) === 0)
    || (r.status === "created" && nbStr(r.export_id) && Number(r.tokens_spent) === 2);
  if (!coherent) throw new Error("priority reservation read: status/state incoherent; failing closed.");
  return { operationKey, catalogRequestHash: r.catalog_request_hash, exportId: r.export_id ?? null, tokensSpent: Number(r.tokens_spent), status: r.status };
}

// ---------------------------------------------------------------------------
// OLI freshness-attempt reservation wrappers (20260829_source_oli_freshness_attempt.sql). The durable
// per-(operation_key, request_hash) guard for the "force latest" fresh-fetch: one forced OLI create per
// (operation, batch hash). Every ack is validated STRICTLY (echo + coherent state) and normalized.
// ---------------------------------------------------------------------------
const OLI_FRESHNESS_RESERVE_DISPOSITIONS = new Set(["reserved", "exists"]);
const OLI_FRESHNESS_RECORD_DISPOSITIONS = new Set(["recorded", "already-recorded", "conflict", "not-reserved"]);

export async function reserveOliFreshnessCreate(operationKey, requestHash, { signal = null } = {}) {
  const body = await request("/rest/v1/rpc/reserve_oli_freshness_create", {
    method: "POST", signal, body: { p_operation_key: operationKey, p_request_hash: requestHash },
  });
  const ack = priorityOneAck(body, "oli-freshness reserve");
  const d = ack.disposition;
  if (!OLI_FRESHNESS_RESERVE_DISPOSITIONS.has(d)) throw new Error(`oli-freshness reserve: unknown disposition "${d}"; failing closed.`);
  if (ack.operation_key !== operationKey) throw new Error("oli-freshness reserve: operation_key echo mismatch; failing closed.");
  if (ack.request_hash !== requestHash) throw new Error("oli-freshness reserve: request_hash echo mismatch; failing closed.");
  if (d === "reserved") {
    if (ack.export_id != null || Number(ack.tokens_spent) !== 0 || ack.status !== "reserved") throw new Error("oli-freshness reserve: malformed 'reserved' ack; failing closed.");
    return { disposition: "reserved", exportId: null, status: "reserved", tokensSpent: 0, requestHash };
  }
  if (ack.status !== "reserved" && ack.status !== "created") throw new Error("oli-freshness reserve: malformed 'exists' status; failing closed.");
  if (ack.status === "created") {
    if (!nbStr(ack.export_id) || Number(ack.tokens_spent) !== 2) throw new Error("oli-freshness reserve: 'exists'+created requires export_id + 2 tokens; failing closed.");
    return { disposition: "exists", exportId: ack.export_id, status: "created", tokensSpent: 2, requestHash };
  }
  if (ack.export_id != null || Number(ack.tokens_spent) !== 0) throw new Error("oli-freshness reserve: 'exists'+reserved requires no export_id + 0 tokens; failing closed.");
  return { disposition: "exists", exportId: null, status: "reserved", tokensSpent: 0, requestHash };
}

export async function recordOliFreshnessExport(operationKey, requestHash, exportId, tokens, { signal = null } = {}) {
  const body = await request("/rest/v1/rpc/record_oli_freshness_export", {
    method: "POST", signal, body: { p_operation_key: operationKey, p_request_hash: requestHash, p_export_id: exportId, p_tokens: tokens },
  });
  const ack = priorityOneAck(body, "oli-freshness record");
  const d = ack.disposition;
  if (!OLI_FRESHNESS_RECORD_DISPOSITIONS.has(d)) throw new Error(`oli-freshness record: unknown disposition "${d}"; failing closed.`);
  if (ack.operation_key !== operationKey) throw new Error("oli-freshness record: operation_key echo mismatch; failing closed.");
  if (d === "not-reserved") return { disposition: "not-reserved", exportId: null, tokensSpent: 0 };
  if (ack.request_hash !== requestHash) throw new Error("oli-freshness record: request_hash echo mismatch; failing closed.");
  if (d === "recorded" || d === "already-recorded") {
    if (ack.export_id !== exportId || Number(ack.tokens_spent) !== 2 || ack.status !== "created") throw new Error(`oli-freshness record: '${d}' requires the exact export_id + 2 tokens + created; failing closed.`);
    return { disposition: d, exportId, tokensSpent: 2, status: "created" };
  }
  if (!nbStr(ack.export_id) || ack.export_id === exportId) throw new Error("oli-freshness record: 'conflict' requires a DIFFERENT existing export_id; failing closed.");
  return { disposition: "conflict", exportId: ack.export_id, tokensSpent: Number(ack.tokens_spent) || 0, status: ack.status };
}

// The provenance-checked CAS write of ONE (account, sale_date) completeness record (record_oli_completeness).
// The RPC decides the disposition (inserted | updated | promoted | final-preserved | final-refreshed |
// already-final | stale-ignored) and never regresses a FINAL nor clobbers newer evidence. Returns the disposition
// + the resulting completeness_status; a malformed / unknown response fails closed.
const OLI_COMPLETENESS_DISPOSITIONS = new Set(["inserted", "updated", "promoted", "final-preserved", "final-refreshed", "already-final", "stale-ignored"]);
export async function recordOliCompleteness(rec, { signal = null } = {}) {
  const r = rec || {};
  const body = await request("/rest/v1/rpc/record_oli_completeness", {
    method: "POST", signal, body: {
      p_organization_fingerprint: r.organizationFingerprint, p_connection_id: r.connectionId, p_account_id: r.accountId,
      p_bucket: r.bucket, p_sale_date: r.saleDate, p_status: r.status,
      p_itemized_order_count: Math.trunc(Number(r.itemizedOrderCount) || 0), p_pending_order_count: Math.trunc(Number(r.pendingOrderCount) || 0),
      p_itemized_unit_count: Number(r.itemizedUnitCount) || 0, p_pending_unit_count: Number(r.pendingUnitCount) || 0,
      p_defect_count: Math.trunc(Number(r.defectCount) || 0), p_itemization_percent: Number(r.itemizationPercent) || 0,
      p_requested_as_of: r.requestedAsOf || null, p_proven_export_through: r.provenExportThrough || null,
      p_source_request_hashes: Array.isArray(r.sourceRequestHashes) ? r.sourceRequestHashes : [],
      p_source_export_ids: Array.isArray(r.sourceExportIds) ? r.sourceExportIds : [],
      p_refreshed_at: r.refreshedAt || new Date().toISOString(),
    },
  });
  const ack = priorityOneAck(body, "oli-completeness record");
  const d = ack.disposition;
  if (!OLI_COMPLETENESS_DISPOSITIONS.has(d)) throw new Error(`oli-completeness record: unknown disposition "${d}"; failing closed.`);
  return { disposition: d, completenessStatus: ack.completeness_status || null };
}

// Read completeness rows for a set of accounts over [from,to] (the report derivation + admin escalation read this).
// SELECT-only; returns the rows verbatim (fail closed on a malformed response).
export async function getOliCompleteness({ organizationFingerprint, connectionId, accountIds, from, to }, { signal = null } = {}) {
  const ids = (Array.isArray(accountIds) ? accountIds : []).map((x) => String(x)).filter(Boolean);
  if (!organizationFingerprint || !connectionId || ids.length === 0) return [];
  const query = new URLSearchParams({
    select: "account_id,bucket,sale_date,completeness_status,itemized_order_count,pending_order_count,itemized_unit_count,pending_unit_count,defect_count,itemization_percent,requested_as_of,proven_export_through,refreshed_at",
    organization_fingerprint: `eq.${organizationFingerprint}`, connection_id: `eq.${connectionId}`,
    account_id: `in.(${ids.map((x) => `"${x.replace(/"/g, '""')}"`).join(",")})`,
  });
  if (from) query.set("sale_date", `gte.${from}`);
  if (to) query.append("sale_date", `lte.${to}`);
  const rows = await request(`/rest/v1/source_oli_completeness?${query}`, { signal });
  if (!Array.isArray(rows)) throw new Error("oli-completeness read: malformed (non-array) response; failing closed.");
  return rows;
}

export async function getOliFreshnessAttempt(operationKey, requestHash, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: "operation_key,request_hash,export_id,tokens_spent,status,created_at,updated_at",
    operation_key: `eq.${operationKey}`, request_hash: `eq.${requestHash}`, limit: "1",
  });
  const rows = await request(`/rest/v1/source_oli_freshness_attempt?${query}`, { signal });
  if (!Array.isArray(rows)) throw new Error("oli-freshness read: malformed (non-array) response; failing closed.");
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("oli-freshness read: expected at most one row; failing closed.");
  const r = rows[0];
  if (!isPlainObj(r)) throw new Error("oli-freshness read: malformed row; failing closed.");
  if (r.operation_key !== operationKey || r.request_hash !== requestHash) throw new Error("oli-freshness read: identity mismatch; failing closed.");
  if (r.status !== "reserved" && r.status !== "created") throw new Error("oli-freshness read: bad status; failing closed.");
  const coherent = (r.status === "reserved" && r.export_id == null && Number(r.tokens_spent) === 0)
    || (r.status === "created" && nbStr(r.export_id) && Number(r.tokens_spent) === 2);
  if (!coherent) throw new Error("oli-freshness read: status/state incoherent; failing closed.");
  return { operationKey, requestHash, exportId: r.export_id ?? null, tokensSpent: Number(r.tokens_spent), status: r.status };
}

// claim_source_export_attempt: the durable one-attempt guard. TRUE only for the caller
// that made the first (and only) create-export POST for this (cycle, request_hash).
export async function claimSourceExportAttempt(cycleId, requestHash, { signal = null } = {}) {
  return request("/rest/v1/rpc/claim_source_export_attempt", {
    method: "POST",
    signal,
    body: { p_cycle_id: cycleId, p_request_hash: requestHash },
  });
}

// adopt_source_export_cache (Blocker 2 + senior review): the ATOMIC, cache-validated
// compare-and-set. The caller's identity/integrity fields are EXPECTATIONS; the RPC
// re-reads and LOCKS the actual current source_export_cache row and validates it
// before adopting the source job with the DB row's OWN values. Returns a TYPED
// acknowledgement string — 'adopted' | 'not-adopted' | 'cache-changed' | 'cache-expired'
// — or null if the response is not a string (the worker treats a null/unknown value
// as a malformed acknowledgement and fails closed with zero create POSTs).
export async function adoptSourceExportCache({ cycleId, requestHash, sourceId, organizationFingerprint, accountScopeHash, objectPath, rowCount, payloadBytes }, { signal = null } = {}) {
  const body = await request("/rest/v1/rpc/adopt_source_export_cache", {
    method: "POST",
    signal,
    body: {
      p_cycle_id: cycleId,
      p_request_hash: requestHash,
      p_expected_source_id: sourceId,
      p_expected_organization_fingerprint: organizationFingerprint,
      p_expected_account_scope_hash: accountScopeHash,
      p_expected_object_path: objectPath,
      p_expected_row_count: rowCount,
      p_expected_payload_bytes: payloadBytes,
    },
  });
  const value = Array.isArray(body) ? body[0] : body;
  return typeof value === "string" ? value : null;
}

// DR1 durable Catalog evidence adoption: the ATOMIC, snapshot-validated adoption CAS (adopt_durable_catalog_snapshot).
// Lets a noExport reconciler's org Catalog source job be satisfied by a VALIDATED durable source_snapshots snapshot that
// PROVES exact equivalence to the job's canonical request (never a fake success). Typed ack: 'adopted' | 'not-adopted'
// | 'snapshot-missing' | 'snapshot-mismatch' | 'snapshot-stale'. Zero DataDoe. Fails closed on any schema/read error.
export async function adoptDurableCatalogSnapshot({ cycleId, requestHash, organizationFingerprint, connectionId = "primary", sourceKey = "product-catalog", scopeKey, objectPath, payloadSha, minValidatedAt = null }, { signal = null } = {}) {
  const body = await request("/rest/v1/rpc/adopt_durable_catalog_snapshot", {
    method: "POST",
    signal,
    body: {
      p_cycle_id: cycleId,
      p_request_hash: requestHash,
      p_expected_organization_fingerprint: organizationFingerprint,
      p_expected_connection_id: connectionId,
      p_expected_source_key: sourceKey,
      p_expected_scope_key: scopeKey,
      p_expected_object_path: objectPath,
      p_expected_payload_sha: payloadSha,
      p_min_validated_at: minValidatedAt,
    },
  });
  const value = Array.isArray(body) ? body[0] : body;
  return typeof value === "string" ? value : null;
}

// assign_source_account_batch (Blocker 4): STABLE, transactional <=5 batch assignment. Returns the
// (existing or newly assigned) batch_index for (family, account). An already-assigned account keeps its
// index (never reshuffled); a new account is placed into a non-full or fresh batch under the 5-cap.
export async function assignSourceAccountBatch({ batchFamily, accountId, connectionId, organizationFingerprint, max = 5, signal = null }) {
  const body = await request("/rest/v1/rpc/assign_source_account_batch", {
    method: "POST",
    signal,
    body: {
      p_batch_family: batchFamily,
      p_account_id: accountId,
      p_connection_id: connectionId,
      p_organization_fingerprint: organizationFingerprint,
      p_max: max,
    },
  });
  const value = Array.isArray(body) ? body[0] : body;
  return typeof value === "number" ? value : Number(value);
}

// Read the durable batch membership for one family (admin/service-role only). Returns rows
// { account_id, batch_index, connection_id, organization_fingerprint }.
export async function listSourceBatchMembership(batchFamily, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: "account_id,batch_index,connection_id,organization_fingerprint",
    batch_family: `eq.${batchFamily}`,
    order: "batch_index.asc,account_id.asc",
  });
  const rows = await request(`/rest/v1/source_batch_membership?${query}`, { signal });
  return Array.isArray(rows) ? rows : [];
}

// persist_source_tranche_budget (Blocker 4d): freeze the create/token budget for (cycle, tranche) ONCE.
// Idempotent; a continuation with a drifted plan raises PLAN_BUDGET_MISMATCH. Returns 'created' | 'exists'.
export async function persistSourceTrancheBudget({ cycleId, trancheKey, planFingerprint, maxCreates, maxTokens, hashes }, { signal = null } = {}) {
  const body = await request("/rest/v1/rpc/persist_source_tranche_budget", {
    method: "POST",
    signal,
    body: {
      p_cycle_id: cycleId,
      p_tranche_key: trancheKey,
      p_plan_fingerprint: planFingerprint,
      p_max_creates: maxCreates,
      p_max_tokens: maxTokens,
      p_hashes: (hashes || []).map((h) => ({ request_hash: h.requestHash ?? h.request_hash, token_cost: h.tokenCost ?? h.token_cost })),
    },
  });
  const value = Array.isArray(body) ? body[0] : body;
  return typeof value === "string" ? value : String(value);
}

// reserve_source_export_create (Blocker 4d): the ATOMIC pre-POST reservation. ONLY a 'reserved' result may
// POST a create-export. Returns 'reserved' | 'not-pending' | 'plan-mismatch' | 'budget-exceeded'.
export async function reserveSourceExportCreate({ cycleId, trancheKey, requestHash, planFingerprint }, { signal = null } = {}) {
  const body = await request("/rest/v1/rpc/reserve_source_export_create", {
    method: "POST",
    signal,
    body: {
      p_cycle_id: cycleId,
      p_tranche_key: trancheKey,
      p_request_hash: requestHash,
      p_plan_fingerprint: planFingerprint,
    },
  });
  const value = Array.isArray(body) ? body[0] : body;
  return typeof value === "string" ? value : String(value);
}

// Read the frozen tranche budget row (admin/service-role only): the plan fingerprint + create/token ceilings
// and the durable spent counters for (cycle, tranche), or null.
export async function getSourceTrancheBudget({ cycleId, trancheKey }, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: "cycle_id,tranche_key,plan_fingerprint,max_creates,max_tokens,spent_creates,spent_tokens",
    cycle_id: `eq.${cycleId}`,
    tranche_key: `eq.${trancheKey}`,
  });
  const rows = await request(`/rest/v1/source_tranche_budget?${query}`, { signal });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Read the frozen per-hash costs for (cycle, tranche): rows { request_hash, token_cost }.
export async function getSourceTrancheBudgetHashes({ cycleId, trancheKey }, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: "request_hash,token_cost",
    cycle_id: `eq.${cycleId}`,
    tranche_key: `eq.${trancheKey}`,
    order: "request_hash.asc",
  });
  const rows = await request(`/rest/v1/source_tranche_budget_hash?${query}`, { signal });
  return Array.isArray(rows) ? rows : [];
}

/* ---- DURABLE SOURCE MODEL wrappers (20260820_source_durable_model.sql -- PREPARED, UNAPPLIED) ----------
 * The 24h source_export_cache is a per-cycle reuse cache, NOT history. These wrappers are the ONLY write
 * path to the durable model: canonical OLI history (idempotent PK upsert so late Amazon corrections REPLACE
 * matching rows), proven coverage windows (succeeded-only; completed coverage is never exported again),
 * source-level controls (pause stops NEW exports only; schedule defaults OFF), the per-(source, bucket)
 * operator status card, and the latest-VALIDATED snapshot pointer (a failed refresh never replaces a
 * validated one). Typed outcomes distinguish schema-missing (unapplied migration) from operational
 * failures; only SAFE codes are returned -- never a raw DB response or a secret. */

// The scope_key / account_id sentinel for organization-wide sources (Product Catalog).
export const SOURCE_SCOPE_ORGANIZATION = "__organization";

const OLI_HISTORY_CONFLICT = "organization_fingerprint,connection_id,account_id,sale_date,sku,child_asin,currency";

// Idempotent canonical-grain upsert: merge-duplicates on the FULL grain PK, so a re-export of an already
// covered window (rolling refresh) or a late Amazon correction REPLACES the matching row -- never a
// duplicate. Every row must carry the complete grain; a malformed row rejects the whole batch BEFORE any
// HTTP so a partial batch can never be half-written by this wrapper.
export async function upsertSourceOliHistoryRows(rows) {
  const payload = [];
  for (const r of rows || []) {
    const rec = {
      organization_fingerprint: r.organizationFingerprint,
      connection_id: r.connectionId || "primary",
      account_id: r.accountId,
      seller_or_vendor_id: r.sellerOrVendorId,
      sale_date: r.saleDate,
      sku: String(r.sku ?? ""),
      child_asin: String(r.childAsin ?? ""),
      currency: r.currency,
      sales_amount: r.salesAmount,
      units: r.units,
      source_request_hash: r.sourceRequestHash,
    };
    if (!rec.organization_fingerprint || !rec.account_id || !rec.seller_or_vendor_id || !rec.sale_date
      || !rec.currency || !rec.source_request_hash
      || typeof rec.sales_amount !== "number" || !Number.isFinite(rec.sales_amount)
      || typeof rec.units !== "number" || !Number.isFinite(rec.units)) {
      throw new Error("upsertSourceOliHistoryRows: a row is missing its canonical grain/values; rejecting the whole batch (fail closed).");
    }
    if (rec.connection_id !== "primary" && rec.connection_id !== "dd-secondary") {
      throw new Error("upsertSourceOliHistoryRows: invalid connection_id; rejecting the whole batch (fail closed).");
    }
    payload.push(rec);
  }
  if (!payload.length) return { write: "ok", recorded: 0, error: null };
  try {
    await request(`/rest/v1/source_oli_daily_history?on_conflict=${OLI_HISTORY_CONFLICT}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: payload,
    });
    return { write: "ok", recorded: payload.length, error: null };
  } catch (writeError) {
    if (isSchemaMissingError(writeError)) return { write: "schema-missing", recorded: 0, error: "OLI_HISTORY_SCHEMA_MISSING" };
    return { write: "write-failed", recorded: 0, error: "OLI_HISTORY_WRITE_FAILED" };
  }
}

/**
 * ATOMIC rolling-window replacement + coverage acknowledgement (replace_oli_history_window RPC,
 * senior-review finding 5): deletes the account's history rows inside the window, inserts the corrected
 * rows, and upserts the proven coverage window in ONE transaction -- a grain that disappeared from the
 * corrected export cannot survive, and coverage can never acknowledge a window whose rows were not
 * written. An empty rows array is valid zero-sales evidence. Returns a typed outcome (never throws for a
 * schema-missing/unapplied migration -- the caller fails closed on write !== "ok").
 */
export async function replaceOliHistoryWindow({ organizationFingerprint, connectionId = "primary", accountId, coveredFrom, coveredTo, rows, sourceRefreshedAt = null, signal = null }) {
  if (!organizationFingerprint || !accountId || !coveredFrom || !coveredTo || !Array.isArray(rows)) {
    throw new Error("replaceOliHistoryWindow requires organizationFingerprint/accountId/coveredFrom/coveredTo and a rows array (fail closed).");
  }
  try {
    const body = await request("/rest/v1/rpc/replace_oli_history_window", {
      method: "POST",
      signal,
      body: {
        p_organization_fingerprint: organizationFingerprint,
        p_connection_id: connectionId,
        p_account_id: accountId,
        p_covered_from: coveredFrom,
        p_covered_to: coveredTo,
        p_rows: rows.map((r) => ({
          seller_or_vendor_id: r.sellerOrVendorId ?? r.seller_or_vendor_id,
          sale_date: r.saleDate ?? r.sale_date,
          sku: String(r.sku ?? ""),
          child_asin: String(r.childAsin ?? r.child_asin ?? ""),
          currency: r.currency,
          sales_amount: r.salesAmount ?? r.sales_amount,
          units: r.units,
          source_request_hash: r.sourceRequestHash ?? r.source_request_hash,
        })),
        p_source_refreshed_at: sourceRefreshedAt || new Date().toISOString(),
      },
    });
    const value = Array.isArray(body) ? body[0] : body;
    return { write: "ok", replaced: value?.replaced ?? 0, inserted: value?.inserted ?? 0, error: null };
  } catch (writeError) {
    if (isSchemaMissingError(writeError)) return { write: "schema-missing", replaced: 0, inserted: 0, error: "OLI_HISTORY_SCHEMA_MISSING" };
    return { write: "write-failed", replaced: 0, inserted: 0, error: "OLI_HISTORY_REPLACE_FAILED" };
  }
}

// The DIMENSIONAL OLI window replacement (order-status / fulfillment / state / city). Calls the atomic
// replace_oli_dimensional_window RPC, which -- in ONE transaction -- replaces the account's dimensional rows,
// replaces the NON-cancelled daily rollup in source_oli_daily_history, and upserts the coverage acknowledgement.
// A row that violates the authoritative order rules raises fail-closed inside the RPC (the whole window rolls
// back, LKG preserved); this wrapper surfaces those as TYPED write outcomes so the caller can report the affected
// account/window separately and never marks its coverage successful.
export async function replaceOliDimensionalWindow({ organizationFingerprint, connectionId = "primary", accountId, coveredFrom, coveredTo, rows, orderRows = [], unitRows = null, sourceRefreshedAt = null, signal = null }) {
  if (!organizationFingerprint || !accountId || !coveredFrom || !coveredTo || !Array.isArray(rows)) {
    throw new Error("replaceOliDimensionalWindow requires organizationFingerprint/accountId/coveredFrom/coveredTo and a rows array (fail closed).");
  }
  if (!Array.isArray(orderRows)) {
    throw new Error("replaceOliDimensionalWindow orderRows must be an array (fail closed).");
  }
  // unitRows is OPTIONAL: null/undefined => p_unit_rows NULL (the RPC SKIPS the operational-unit block, preserving
  // any existing rows -- for legacy callers). A supplied array (even []) => the operational units are REPLACED.
  if (unitRows != null && !Array.isArray(unitRows)) {
    throw new Error("replaceOliDimensionalWindow unitRows must be an array or null (fail closed).");
  }
  // The 8-arg body (dimensional + rollup + order-audit + coverage). p_unit_rows is added ONLY for the 9-arg call.
  const baseBody = {
    p_organization_fingerprint: organizationFingerprint,
    p_connection_id: connectionId,
    p_account_id: accountId,
    p_covered_from: coveredFrom,
    p_covered_to: coveredTo,
    p_rows: rows.map((r) => ({
      seller_or_vendor_id: r.sellerOrVendorId ?? r.seller_or_vendor_id,
      sale_date: r.saleDate ?? r.sale_date,
      sku: String(r.sku ?? ""),
      child_asin: String(r.childAsin ?? r.child_asin ?? ""),
      currency: r.currency,
      amazon_order_status: r.amazonOrderStatus ?? r.amazon_order_status,
      fulfillment_channel: r.fulfillmentChannel ?? r.fulfillment_channel ?? "",
      address_state: r.addressState ?? r.address_state ?? "",
      address_city: r.addressCity ?? r.address_city ?? "",
      // total_sales_sum is passed AS-IS (null when absent) -- never coerced to 0 before the RPC's validation.
      total_sales_sum: (r.totalSalesSum ?? r.total_sales_sum) ?? null,
      total_units_sum: r.totalUnitsSum ?? r.total_units_sum,
      source_request_hash: r.sourceRequestHash ?? r.source_request_hash,
    })),
    p_source_refreshed_at: sourceRefreshedAt || new Date().toISOString(),
    // The SAME validated export ALSO feeds the order-level audit (amazon_order_id folded IN here only). Persisted
    // atomically with the dimensional/rollup replace, so an OLI window can never commit without its Order IDs.
    p_order_rows: orderRows.map((r) => ({
      seller_or_vendor_id: r.sellerOrVendorId ?? r.seller_or_vendor_id,
      sale_date: r.saleDate ?? r.sale_date,
      sku: String(r.sku ?? ""),
      child_asin: String(r.childAsin ?? r.child_asin ?? ""),
      currency: r.currency,
      amazon_order_status: r.amazonOrderStatus ?? r.amazon_order_status,
      fulfillment_channel: r.fulfillmentChannel ?? r.fulfillment_channel ?? "",
      address_state: r.addressState ?? r.address_state ?? "",
      address_city: r.addressCity ?? r.address_city ?? "",
      // amazon_order_id is passed AS-IS (already canonicalized; '' when the source had none -- never fabricated).
      amazon_order_id: r.amazonOrderId ?? r.amazon_order_id ?? "",
      total_sales_sum: (r.totalSalesSum ?? r.total_sales_sum) ?? null,
      total_units_sum: r.totalUnitsSum ?? r.total_units_sum,
      source_request_hash: r.sourceRequestHash ?? r.source_request_hash,
    })),
  };
  // The SAME validated export ALSO feeds the operational-unit classes (priced / explicit-zero / pending / cancelled),
  // persisted atomically with the dimensional/rollup/audit replace. Included ONLY when unitRows is supplied.
  const includeUnits = unitRows != null;
  const fullBody = includeUnits
    ? { ...baseBody, p_unit_rows: unitRows.map((r) => ({
        seller_or_vendor_id: r.sellerOrVendorId ?? r.seller_or_vendor_id,
        sale_date: r.saleDate ?? r.sale_date,
        sku: String(r.sku ?? ""),
        child_asin: String(r.childAsin ?? r.child_asin ?? ""),
        currency: r.currency,
        priced_units: r.pricedUnits ?? r.priced_units ?? 0,
        // priced_sales is passed AS-IS (null when the grain carries no priced units -- never coerced to 0).
        priced_sales: (r.pricedSales ?? r.priced_sales) ?? null,
        explicit_zero_units: r.explicitZeroUnits ?? r.explicit_zero_units ?? 0,
        pending_units: r.pendingUnits ?? r.pending_units ?? 0,
        cancelled_units: r.cancelledUnits ?? r.cancelled_units ?? 0,
        source_request_hash: r.sourceRequestHash ?? r.source_request_hash,
      })) }
    : baseBody;
  try {
    let body;
    try {
      body = await request("/rest/v1/rpc/replace_oli_dimensional_window", { method: "POST", signal, body: fullBody });
    } catch (attemptError) {
      // DEPLOY SAFETY: if the 9-arg signature (p_unit_rows) is not deployed yet (the migration has not been applied),
      // fall back to the 8-arg call so the priced rollup + dimensional + order-audit STILL persist. Operational units
      // simply wait for the migration; a re-sync backfills them. This makes the code deploy safe in ANY order.
      if (includeUnits && isFunctionSignatureMissingError(attemptError)) {
        body = await request("/rest/v1/rpc/replace_oli_dimensional_window", { method: "POST", signal, body: baseBody });
      } else {
        throw attemptError;
      }
    }
    const value = Array.isArray(body) ? body[0] : body;
    return { write: "ok", dimensionalInserted: value?.dimensionalInserted ?? 0, rollupInserted: value?.rollupInserted ?? 0, orderAuditInserted: value?.orderAuditInserted ?? 0, operationalUnitsInserted: value?.operationalUnitsInserted ?? 0, error: null };
  } catch (writeError) {
    if (isSchemaMissingError(writeError)) return { write: "schema-missing", dimensionalInserted: 0, rollupInserted: 0, orderAuditInserted: 0, error: "OLI_DIM_SCHEMA_MISSING" };
    const msg = String(writeError && writeError.message ? writeError.message : writeError);
    if (msg.includes("OLI_NON_CANCELLED_VALUE_MISSING")) return { write: "value-missing", dimensionalInserted: 0, rollupInserted: 0, orderAuditInserted: 0, error: "OLI_NON_CANCELLED_VALUE_MISSING" };
    if (msg.includes("OLI_ORDER_STATUS_MISSING")) return { write: "status-missing", dimensionalInserted: 0, rollupInserted: 0, orderAuditInserted: 0, error: "OLI_ORDER_STATUS_MISSING" };
    return { write: "write-failed", dimensionalInserted: 0, rollupInserted: 0, orderAuditInserted: 0, error: "OLI_DIM_REPLACE_FAILED" };
  }
}

// GENUINELY DURABLE snapshot payload storage (senior-review findings 5 + 6): the latest-validated catalog /
// FBA payloads are COPIED to the source-snapshots/* namespace, which prune_source_export_cache can never
// touch (the prune RPC deletes only object paths recorded in source_export_cache rows) -- so a snapshot
// pointer survives ordinary cache pruning. The object path is ORGANIZATION/CONNECTION-scoped and
// CONTENT-ADDRESSED (the name embeds payload_sha = sha256 of the canonical {rows} JSON), so objects are
// IMMUTABLE: a concurrent save with different content writes a DIFFERENT object, and hydration proves the
// metadata and the payload belong to the same save by re-deriving the content hash from the bytes.
export const SOURCE_SNAPSHOT_OBJECT_PREFIX = "source-snapshots/v2";

export function sourceSnapshotPayloadSha(rows) {
  if (!Array.isArray(rows)) throw new Error("sourceSnapshotPayloadSha requires a rows array (fail closed).");
  return createHash("sha256").update(JSON.stringify({ rows })).digest("hex").slice(0, 32);
}

export function sourceSnapshotObjectPath({ organizationFingerprint, connectionId = "primary", sourceKey, scopeKey, payloadSha }) {
  const clean = (v) => String(v || "").trim().replaceAll("/", "_");
  if (!clean(organizationFingerprint) || !clean(sourceKey) || !clean(scopeKey) || !clean(payloadSha)) {
    throw new Error("sourceSnapshotObjectPath requires nonblank organizationFingerprint/sourceKey/scopeKey/payloadSha (fail closed).");
  }
  if (connectionId !== "primary" && connectionId !== "dd-secondary") {
    throw new Error("sourceSnapshotObjectPath requires a valid connectionId (fail closed).");
  }
  return `${SOURCE_SNAPSHOT_OBJECT_PREFIX}/${clean(organizationFingerprint)}/${connectionId}/${clean(sourceKey)}/${clean(scopeKey)}/${clean(payloadSha)}.json`;
}

export async function saveSourceSnapshotPayload({ organizationFingerprint, connectionId = "primary", sourceKey, scopeKey, rows, signal = null }) {
  if (!Array.isArray(rows)) throw new Error("saveSourceSnapshotPayload requires a rows array (fail closed).");
  const payloadSha = sourceSnapshotPayloadSha(rows);
  const objectPath = sourceSnapshotObjectPath({ organizationFingerprint, connectionId, sourceKey, scopeKey, payloadSha });
  const body = JSON.stringify({ rows });
  await putPrivateStorageObject(SOURCE_CACHE_BUCKET, objectPath, body, "application/json", { signal });
  return { objectPath, payloadSha, payloadBytes: Buffer.byteLength(body) };
}

// Hydrate + PROVE: the payload must be a rows array whose content hash matches the hash embedded in the
// object name -- a truncated/foreign/mutated object can never masquerade as the recorded save.
export async function getSourceSnapshotPayload(objectPath, { signal = null } = {}) {
  const path = String(objectPath || "");
  if (!path.startsWith(`${SOURCE_SNAPSHOT_OBJECT_PREFIX}/`)) {
    throw new Error("getSourceSnapshotPayload only hydrates durable source-snapshot objects (fail closed).");
  }
  const payload = await getPrivateStorageJson(SOURCE_CACHE_BUCKET, path, { signal });
  if (!payload || !Array.isArray(payload.rows)) {
    const err = new Error("SOURCE_SNAPSHOT_PAYLOAD_MALFORMED: the hydrated snapshot payload has no rows array (fail closed).");
    err.code = "SOURCE_SNAPSHOT_PAYLOAD_MALFORMED";
    throw err;
  }
  const embedded = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, "");
  if (sourceSnapshotPayloadSha(payload.rows) !== embedded) {
    const err = new Error("SOURCE_SNAPSHOT_PAYLOAD_MISMATCH: the hydrated payload does not match its content-addressed object name (fail closed).");
    err.code = "SOURCE_SNAPSHOT_PAYLOAD_MISMATCH";
    throw err;
  }
  return payload;
}

export const SOURCE_OLI_HISTORY_MAX_ROWS = 200000;
// PostgREST caps a single response at its `max-rows` setting (Supabase default 1000) REGARDLESS of a larger
// `?limit`, so a single-request read is silently truncated. The canonical-history read PAGINATES at this size
// (offset pages, a TOTAL order) to return the COMPLETE series, then hard-caps the accumulated total.
export const SOURCE_OLI_HISTORY_PAGE_ROWS = 1000;

// Bounded canonical-history read. PAGINATED so the FULL series is returned (never silently truncated to the
// PostgREST page cap, which would understate sales and drop whole accounts). STRICT total cap: over the limit
// the read is refused with a typed error rather than truncated.
export async function getSourceOliHistoryRows({ organizationFingerprint, connectionId = "primary", accountIds = null, from, to, maxRows = SOURCE_OLI_HISTORY_MAX_ROWS, pageRows = SOURCE_OLI_HISTORY_PAGE_ROWS, signal = null } = {}) {
  if (!organizationFingerprint || !from || !to) {
    throw new Error("getSourceOliHistoryRows requires organizationFingerprint + from + to (fail closed).");
  }
  const PAGE = Math.max(1, Number(pageRows) || SOURCE_OLI_HISTORY_PAGE_ROWS);
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const query = new URLSearchParams({
      select: "account_id,seller_or_vendor_id,sale_date,sku,child_asin,currency,sales_amount,units,source_request_hash",
      organization_fingerprint: `eq.${organizationFingerprint}`,
      connection_id: `eq.${connectionId}`,
      sale_date: `gte.${from}`,
      // a TOTAL order over the durable grain (account, date, sku, child_asin, currency) so offset pagination
      // never skips or duplicates a row at a page boundary.
      order: "sale_date.asc,account_id.asc,sku.asc,child_asin.asc,currency.asc",
      limit: String(PAGE),
      offset: String(offset),
    });
    query.append("sale_date", `lte.${to}`);
    // ENFORCE the rollup contract at the single read boundary: only a non-cancelled, present, strictly-POSITIVE
    // order value is business Sales/Units. The dimensional RPC already writes only such rows, but LEGACY
    // pre-dimensional backfill remnants (in windows the dimensional replacement could not take over) can carry
    // sales_amount 0 -- present-zero promotional/replacement units OR NULL-coerced-to-0 -- whose units must NOT be
    // counted (oli-order-rules policy). Excluding them here corrects Daily + Brand Sales + Brand View + scheduler
    // uniformly; the present-zero/missing rows remain in source_oli_dimensional_history for audit.
    query.append("sales_amount", "gt.0");
    if (Array.isArray(accountIds) && accountIds.length) {
      query.append("account_id", `in.(${accountIds.map((a) => `"${String(a).replaceAll('"', "")}"`).join(",")})`);
    }
    const rows = await request(`/rest/v1/source_oli_daily_history?${query}`, { signal });
    const list = Array.isArray(rows) ? rows : [];
    out.push(...list);
    if (out.length > maxRows) {
      const err = new Error("OLI_HISTORY_ROW_LIMIT_EXCEEDED: durable OLI history read exceeded its row cap; refusing a truncated series (fail closed).");
      err.code = "OLI_HISTORY_ROW_LIMIT_EXCEEDED";
      throw err;
    }
    if (list.length < PAGE) break; // a short page is the last page
  }
  return out;
}

// Bounded OPERATIONAL-UNIT read (source_oli_operational_units): the per-(account, sale_date, sku, child_asin,
// currency) observed-unit class sums (priced / explicit-zero / pending / cancelled). PAGINATED like the history read.
// This is the durable home for explicit-zero + pending units (which the priced rollup deliberately excludes) so
// SKU Movement + the transparent breakdown can count EVERY non-cancelled unit. Revenue never reads this table.
export async function getSourceOliOperationalUnitRows({ organizationFingerprint, connectionId = "primary", accountIds = null, from, to, additiveOnly = false, maxRows = SOURCE_OLI_HISTORY_MAX_ROWS, pageRows = SOURCE_OLI_HISTORY_PAGE_ROWS, signal = null } = {}) {
  if (!organizationFingerprint || !from || !to) {
    throw new Error("getSourceOliOperationalUnitRows requires organizationFingerprint + from + to (fail closed).");
  }
  const PAGE = Math.max(1, Number(pageRows) || SOURCE_OLI_HISTORY_PAGE_ROWS);
  const out = [];
  try {
    for (let offset = 0; ; offset += PAGE) {
      const query = new URLSearchParams({
        select: "account_id,seller_or_vendor_id,sale_date,sku,child_asin,currency,priced_units,priced_sales,explicit_zero_units,pending_units,cancelled_units,source_request_hash",
        organization_fingerprint: `eq.${organizationFingerprint}`,
        connection_id: `eq.${connectionId}`,
        sale_date: `gte.${from}`,
        order: "sale_date.asc,account_id.asc,sku.asc,child_asin.asc,currency.asc",
        limit: String(PAGE),
        offset: String(offset),
      });
      query.append("sale_date", `lte.${to}`);
      // additiveOnly narrows to grains that carry ADDITIVE operational units (explicit-zero OR pending) -- the only
      // rows SKU Movement adds beyond the priced daily rollup. It keeps the read small; the priced rollup is unaffected.
      if (additiveOnly) query.append("or", "(explicit_zero_units.gt.0,pending_units.gt.0)");
      if (Array.isArray(accountIds) && accountIds.length) {
        query.append("account_id", `in.(${accountIds.map((a) => `"${String(a).replaceAll('"', "")}"`).join(",")})`);
      }
      const rows = await request(`/rest/v1/source_oli_operational_units?${query}`, { signal });
      const list = Array.isArray(rows) ? rows : [];
      out.push(...list);
      if (out.length > maxRows) {
        const err = new Error("OLI_OPUNITS_ROW_LIMIT_EXCEEDED: durable operational-unit read exceeded its row cap; refusing a truncated series (fail closed).");
        err.code = "OLI_OPUNITS_ROW_LIMIT_EXCEEDED";
        throw err;
      }
      if (list.length < PAGE) break;
    }
  } catch (readError) {
    // Advisory: the operational-unit table is ADDITIVE. If it is not yet present (pre-migration) treat it as empty
    // so SKU Movement + the breakdown degrade gracefully to the priced evidence (never a broken read). A row-cap
    // breach is a real fail-closed error and is re-raised.
    if (readError && readError.code === "OLI_OPUNITS_ROW_LIMIT_EXCEEDED") throw readError;
    if (isSchemaMissingError(readError)) return [];
    throw readError;
  }
  return out;
}

// STANDALONE atomic replace of ONLY the operational-unit window (used by the zero-export backfill that recomputes
// operational units from dimensional history WITHOUT touching the priced rollup / dimensional / audit / coverage).
export async function replaceOliOperationalUnitsWindow({ organizationFingerprint, connectionId = "primary", accountId, coveredFrom, coveredTo, unitRows, signal = null }) {
  if (!organizationFingerprint || !accountId || !coveredFrom || !coveredTo || !Array.isArray(unitRows)) {
    throw new Error("replaceOliOperationalUnitsWindow requires organizationFingerprint/accountId/coveredFrom/coveredTo and a unitRows array (fail closed).");
  }
  try {
    const body = await request("/rest/v1/rpc/replace_oli_operational_units_window", {
      method: "POST",
      signal,
      body: {
        p_organization_fingerprint: organizationFingerprint,
        p_connection_id: connectionId,
        p_account_id: accountId,
        p_covered_from: coveredFrom,
        p_covered_to: coveredTo,
        p_unit_rows: unitRows.map((r) => ({
          seller_or_vendor_id: r.sellerOrVendorId ?? r.seller_or_vendor_id,
          sale_date: r.saleDate ?? r.sale_date,
          sku: String(r.sku ?? ""),
          child_asin: String(r.childAsin ?? r.child_asin ?? ""),
          currency: r.currency,
          priced_units: r.pricedUnits ?? r.priced_units ?? 0,
          priced_sales: (r.pricedSales ?? r.priced_sales) ?? null,
          explicit_zero_units: r.explicitZeroUnits ?? r.explicit_zero_units ?? 0,
          pending_units: r.pendingUnits ?? r.pending_units ?? 0,
          cancelled_units: r.cancelledUnits ?? r.cancelled_units ?? 0,
          source_request_hash: r.sourceRequestHash ?? r.source_request_hash,
        })),
      },
    });
    const value = Array.isArray(body) ? body[0] : body;
    return { write: "ok", replaced: value?.operationalUnitsReplaced ?? 0, inserted: value?.operationalUnitsInserted ?? 0, error: null };
  } catch (writeError) {
    if (isSchemaMissingError(writeError)) return { write: "schema-missing", replaced: 0, inserted: 0, error: "OLI_OPUNITS_SCHEMA_MISSING" };
    return { write: "write-failed", replaced: 0, inserted: 0, error: "OLI_OPUNITS_REPLACE_FAILED" };
  }
}

// Bounded SALES-ESTIMATE read (source_oli_sales_estimates): the per-(account, sale_date, sku, child_asin, currency)
// internal estimate of missing/zero-price sales, computed from same-product historical prices. PAGINATED + fail-soft
// like the operational-unit read (pre-migration => [] so every consumer degrades to the priced evidence).
export async function getSourceOliSalesEstimateRows({ organizationFingerprint, connectionId = "primary", accountIds = null, from, to, maxRows = SOURCE_OLI_HISTORY_MAX_ROWS, pageRows = SOURCE_OLI_HISTORY_PAGE_ROWS, signal = null } = {}) {
  if (!organizationFingerprint || !from || !to) {
    throw new Error("getSourceOliSalesEstimateRows requires organizationFingerprint + from + to (fail closed).");
  }
  const PAGE = Math.max(1, Number(pageRows) || SOURCE_OLI_HISTORY_PAGE_ROWS);
  const outRows = [];
  try {
    for (let offset = 0; ; offset += PAGE) {
      const query = new URLSearchParams({
        select: "account_id,seller_or_vendor_id,marketplace_country_code,sale_date,sku,child_asin,currency,target_quantity,estimated_sales,reference_date,reference_unit_price,matching_method,reference_source_request_hash,target_source_request_hash,calculated_at",
        organization_fingerprint: `eq.${organizationFingerprint}`,
        connection_id: `eq.${connectionId}`,
        sale_date: `gte.${from}`,
        order: "sale_date.asc,account_id.asc,sku.asc,child_asin.asc,currency.asc",
        limit: String(PAGE),
        offset: String(offset),
      });
      query.append("sale_date", `lte.${to}`);
      if (Array.isArray(accountIds) && accountIds.length) {
        query.append("account_id", `in.(${accountIds.map((a) => `"${String(a).replaceAll('"', "")}"`).join(",")})`);
      }
      const rows = await request(`/rest/v1/source_oli_sales_estimates?${query}`, { signal });
      const list = Array.isArray(rows) ? rows : [];
      outRows.push(...list);
      if (outRows.length > maxRows) {
        const err = new Error("OLI_ESTIMATE_ROW_LIMIT_EXCEEDED: durable sales-estimate read exceeded its row cap; refusing a truncated series (fail closed).");
        err.code = "OLI_ESTIMATE_ROW_LIMIT_EXCEEDED";
        throw err;
      }
      if (list.length < PAGE) break;
    }
  } catch (readError) {
    if (readError && readError.code === "OLI_ESTIMATE_ROW_LIMIT_EXCEEDED") throw readError;
    if (isSchemaMissingError(readError)) return []; // additive layer not yet applied -> degrade to priced-only
    throw readError;
  }
  return outRows;
}

// Server-side SKU -> child_asin RESOLUTION for ONE account (resolve_oli_sku_asin RPC). Returns the compact per-
// account (seller_or_vendor_id, currency, sku, asin_count, child_asin) resolution set aggregated in the database
// over ALL non-cancelled dimensional history under the exact isolation boundary (org + connection + account +
// seller + currency + sku). asin_count is the number of DISTINCT non-blank ASINs the SKU has ever mapped to;
// child_asin is meaningful ONLY when asin_count === 1 (the caller resolves a missing ASIN only when it is unique,
// and leaves an ambiguous SKU unresolved -- fail closed). Fail-soft: pre-migration (function absent) returns [] so
// the estimator degrades to blank-ASIN-targets-unresolved, never breaking the priced read. Reads only already-
// fetched durable evidence -- ZERO DataDoe.
export async function getOliSkuAsinResolutionRows({ organizationFingerprint, connectionId = "primary", accountId, signal = null } = {}) {
  if (!organizationFingerprint || !accountId) {
    throw new Error("getOliSkuAsinResolutionRows requires organizationFingerprint + accountId (fail closed).");
  }
  try {
    const body = await request("/rest/v1/rpc/resolve_oli_sku_asin", {
      method: "POST",
      signal,
      body: {
        p_organization_fingerprint: organizationFingerprint,
        p_connection_id: connectionId,
        p_account_id: accountId,
      },
    });
    return Array.isArray(body) ? body : [];
  } catch (readError) {
    if (isSchemaMissingError(readError)) return []; // additive RPC not yet applied -> degrade (no ASIN resolution)
    throw readError;
  }
}

// STANDALONE atomic replace of ONLY the sales-estimate window for one account (delete + insert by exact
// account/window). Recomputed from durable truth (operational units + dimensional references) after every OLI
// persist and by the zero-token backfill -- NEVER a DataDoe export. An EMPTY estimateRows clears the window.
export async function replaceOliSalesEstimatesWindow({ organizationFingerprint, connectionId = "primary", accountId, coveredFrom, coveredTo, estimateRows, signal = null }) {
  if (!organizationFingerprint || !accountId || !coveredFrom || !coveredTo || !Array.isArray(estimateRows)) {
    throw new Error("replaceOliSalesEstimatesWindow requires organizationFingerprint/accountId/coveredFrom/coveredTo and an estimateRows array (fail closed).");
  }
  try {
    const body = await request("/rest/v1/rpc/replace_oli_sales_estimates_window", {
      method: "POST",
      signal,
      body: {
        p_organization_fingerprint: organizationFingerprint,
        p_connection_id: connectionId,
        p_account_id: accountId,
        p_covered_from: coveredFrom,
        p_covered_to: coveredTo,
        p_estimate_rows: estimateRows.map((r) => ({
          seller_or_vendor_id: r.sellerOrVendorId ?? r.seller_or_vendor_id,
          marketplace_country_code: r.marketplaceCountryCode ?? r.marketplace_country_code,
          sale_date: r.saleDate ?? r.sale_date,
          sku: String(r.sku ?? ""),
          child_asin: String(r.childAsin ?? r.child_asin ?? ""),
          currency: r.currency,
          target_quantity: r.targetQuantity ?? r.target_quantity,
          estimated_sales: r.estimatedSales ?? r.estimated_sales,
          reference_date: r.referenceDate ?? r.reference_date,
          reference_unit_price: r.referenceUnitPrice ?? r.reference_unit_price,
          matching_method: r.matchingMethod ?? r.matching_method,
          reference_source_request_hash: r.referenceSourceRequestHash ?? r.reference_source_request_hash ?? "",
          target_source_request_hash: r.targetSourceRequestHash ?? r.target_source_request_hash ?? "",
          calculated_at: r.calculatedAt ?? r.calculated_at ?? null,
        })),
      },
    });
    const value = Array.isArray(body) ? body[0] : body;
    return { write: "ok", replaced: value?.estimatesReplaced ?? 0, inserted: value?.estimatesInserted ?? 0, error: null };
  } catch (writeError) {
    if (isSchemaMissingError(writeError)) return { write: "schema-missing", replaced: 0, inserted: 0, error: "OLI_ESTIMATE_SCHEMA_MISSING" };
    return { write: "write-failed", replaced: 0, inserted: 0, error: "OLI_ESTIMATE_REPLACE_FAILED" };
  }
}

/* ===================== Returns & Refund Leakage -- durable Returns + Settlement history ===================== */
// Read the durable per-account Returns history (source_returns_history) over a [from,to] return_date window. Paginated
// + hard-capped; pre-migration (schema absent) returns [] so the dedicated returns publisher degrades to
// last-known-good rather than throwing. ZERO DataDoe -- reads already-fetched durable evidence.
export async function getReturnsHistoryRows({ organizationFingerprint, connectionId = "primary", accountIds = null, from, to, maxRows = SOURCE_OLI_HISTORY_MAX_ROWS, pageRows = SOURCE_OLI_HISTORY_PAGE_ROWS, signal = null } = {}) {
  if (!organizationFingerprint || !from || !to) {
    throw new Error("getReturnsHistoryRows requires organizationFingerprint + from + to (fail closed).");
  }
  const PAGE = Math.max(1, Number(pageRows) || SOURCE_OLI_HISTORY_PAGE_ROWS);
  const outRows = [];
  try {
    for (let offset = 0; ; offset += PAGE) {
      const query = new URLSearchParams({
        select: "account_id,seller_or_vendor_id,marketplace_country_code,return_date,sku,child_asin,amazon_return_reason,fulfillment_channel,request_status,label_payer,detailed_disposition,return_count,fbm_refunded_amount,fbm_seller_label_cost,cogs_total_value,source_request_hash,refreshed_at",
        organization_fingerprint: `eq.${organizationFingerprint}`,
        connection_id: `eq.${connectionId}`,
        return_date: `gte.${from}`,
        order: "return_date.asc,account_id.asc,child_asin.asc,sku.asc",
        limit: String(PAGE),
        offset: String(offset),
      });
      query.append("return_date", `lte.${to}`);
      if (Array.isArray(accountIds) && accountIds.length) {
        query.append("account_id", `in.(${accountIds.map((a) => `"${String(a).replaceAll('"', "")}"`).join(",")})`);
      }
      const rows = await request(`/rest/v1/source_returns_history?${query}`, { signal });
      const list = Array.isArray(rows) ? rows : [];
      outRows.push(...list);
      if (outRows.length > maxRows) {
        const err = new Error("RETURNS_HISTORY_ROW_LIMIT_EXCEEDED: durable returns read exceeded its row cap; refusing a truncated series (fail closed).");
        err.code = "RETURNS_HISTORY_ROW_LIMIT_EXCEEDED";
        throw err;
      }
      if (list.length < PAGE) break;
    }
  } catch (readError) {
    if (readError && readError.code === "RETURNS_HISTORY_ROW_LIMIT_EXCEEDED") throw readError;
    if (isSchemaMissingError(readError)) return []; // durable returns table not yet applied -> LKG
    throw readError;
  }
  return outRows;
}

// STANDALONE atomic replace of ONLY the returns window for one account (delete + insert by exact account/return_date
// window). p_return_rows is REQUIRED (a non-null array; an EMPTY [] legitimately clears the window). Returns a typed
// outcome; schema-missing is non-fatal (pre-migration) so a write hiccup never regresses last-known-good.
export async function replaceReturnsHistoryWindow({ organizationFingerprint, connectionId = "primary", accountId, coveredFrom, coveredTo, returnRows, signal = null }) {
  if (!organizationFingerprint || !accountId || !coveredFrom || !coveredTo || !Array.isArray(returnRows)) {
    throw new Error("replaceReturnsHistoryWindow requires organizationFingerprint/accountId/coveredFrom/coveredTo and a returnRows array (fail closed).");
  }
  try {
    const body = await request("/rest/v1/rpc/replace_returns_history_window", {
      method: "POST",
      signal,
      body: {
        p_organization_fingerprint: organizationFingerprint,
        p_connection_id: connectionId,
        p_account_id: accountId,
        p_covered_from: coveredFrom,
        p_covered_to: coveredTo,
        p_return_rows: returnRows.map((r) => ({
          seller_or_vendor_id: r.sellerOrVendorId ?? r.seller_or_vendor_id,
          marketplace_country_code: r.marketplaceCountryCode ?? r.marketplace_country_code ?? "",
          return_date: r.returnDate ?? r.return_date,
          sku: String(r.sku ?? ""),
          child_asin: String(r.childAsin ?? r.child_asin ?? ""),
          amazon_return_reason: String(r.amazonReturnReason ?? r.amazon_return_reason ?? ""),
          fulfillment_channel: String(r.fulfillmentChannel ?? r.fulfillment_channel ?? ""),
          request_status: String(r.requestStatus ?? r.request_status ?? ""),
          label_payer: String(r.labelPayer ?? r.label_payer ?? ""),
          detailed_disposition: String(r.detailedDisposition ?? r.detailed_disposition ?? ""),
          return_count: r.returnCount ?? r.return_count,
          fbm_refunded_amount: r.fbmRefundedAmount ?? r.fbm_refunded_amount ?? 0,
          fbm_seller_label_cost: r.fbmSellerLabelCost ?? r.fbm_seller_label_cost ?? 0,
          cogs_total_value: r.cogsTotalValue ?? r.cogs_total_value ?? 0,
          source_request_hash: r.sourceRequestHash ?? r.source_request_hash ?? "",
          refreshed_at: r.refreshedAt ?? r.refreshed_at ?? null,
          calculated_at: r.calculatedAt ?? r.calculated_at ?? null,
        })),
      },
    });
    const value = Array.isArray(body) ? body[0] : body;
    return { write: "ok", replaced: value?.returnsReplaced ?? 0, inserted: value?.returnsInserted ?? 0, error: null };
  } catch (writeError) {
    if (isSchemaMissingError(writeError)) return { write: "schema-missing", replaced: 0, inserted: 0, error: "RETURNS_HISTORY_SCHEMA_MISSING" };
    return { write: "write-failed", replaced: 0, inserted: 0, error: "RETURNS_HISTORY_REPLACE_FAILED" };
  }
}

// Read the durable per-account Settlement history (source_settlement_history) over a [from,to] settlement_date window.
export async function getSettlementHistoryRows({ organizationFingerprint, connectionId = "primary", accountIds = null, from, to, maxRows = SOURCE_OLI_HISTORY_MAX_ROWS, pageRows = SOURCE_OLI_HISTORY_PAGE_ROWS, signal = null } = {}) {
  if (!organizationFingerprint || !from || !to) {
    throw new Error("getSettlementHistoryRows requires organizationFingerprint + from + to (fail closed).");
  }
  const PAGE = Math.max(1, Number(pageRows) || SOURCE_OLI_HISTORY_PAGE_ROWS);
  const outRows = [];
  try {
    for (let offset = 0; ; offset += PAGE) {
      const query = new URLSearchParams({
        select: "account_id,seller_or_vendor_id,marketplace_country_code,settlement_date,sku,child_asin,currency,settlement_type,quantity,item_price,refunded_amount,refund_tax,refunded_referral_fee,refund_commission,refund_restocking_fee,fba_customer_return_per_unit_fee,fba_customer_return_fee,customer_return_hrr_unit_fee,cogs_total_value,refund_event_count,source_request_hash,refreshed_at",
        organization_fingerprint: `eq.${organizationFingerprint}`,
        connection_id: `eq.${connectionId}`,
        settlement_date: `gte.${from}`,
        order: "settlement_date.asc,account_id.asc,child_asin.asc,sku.asc",
        limit: String(PAGE),
        offset: String(offset),
      });
      query.append("settlement_date", `lte.${to}`);
      if (Array.isArray(accountIds) && accountIds.length) {
        query.append("account_id", `in.(${accountIds.map((a) => `"${String(a).replaceAll('"', "")}"`).join(",")})`);
      }
      const rows = await request(`/rest/v1/source_settlement_history?${query}`, { signal });
      const list = Array.isArray(rows) ? rows : [];
      outRows.push(...list);
      if (outRows.length > maxRows) {
        const err = new Error("SETTLEMENT_HISTORY_ROW_LIMIT_EXCEEDED: durable settlement read exceeded its row cap; refusing a truncated series (fail closed).");
        err.code = "SETTLEMENT_HISTORY_ROW_LIMIT_EXCEEDED";
        throw err;
      }
      if (list.length < PAGE) break;
    }
  } catch (readError) {
    if (readError && readError.code === "SETTLEMENT_HISTORY_ROW_LIMIT_EXCEEDED") throw readError;
    if (isSchemaMissingError(readError)) return []; // durable settlement table not yet applied -> LKG
    throw readError;
  }
  return outRows;
}

// STANDALONE atomic replace of ONLY the settlement window for one account (delete + insert by exact account/
// settlement_date window). Blank/invalid-currency rows are rejected fail-closed by the RPC (no money without a
// currency). An EMPTY [] clears the window.
export async function replaceSettlementHistoryWindow({ organizationFingerprint, connectionId = "primary", accountId, coveredFrom, coveredTo, settlementRows, signal = null }) {
  if (!organizationFingerprint || !accountId || !coveredFrom || !coveredTo || !Array.isArray(settlementRows)) {
    throw new Error("replaceSettlementHistoryWindow requires organizationFingerprint/accountId/coveredFrom/coveredTo and a settlementRows array (fail closed).");
  }
  try {
    const body = await request("/rest/v1/rpc/replace_settlement_history_window", {
      method: "POST",
      signal,
      body: {
        p_organization_fingerprint: organizationFingerprint,
        p_connection_id: connectionId,
        p_account_id: accountId,
        p_covered_from: coveredFrom,
        p_covered_to: coveredTo,
        p_settlement_rows: settlementRows.map((r) => ({
          seller_or_vendor_id: r.sellerOrVendorId ?? r.seller_or_vendor_id,
          marketplace_country_code: r.marketplaceCountryCode ?? r.marketplace_country_code ?? "",
          settlement_date: r.settlementDate ?? r.settlement_date,
          sku: String(r.sku ?? ""),
          child_asin: String(r.childAsin ?? r.child_asin ?? ""),
          currency: r.currency,
          settlement_type: r.settlementType ?? r.settlement_type,
          quantity: r.quantity ?? 0,
          item_price: r.itemPrice ?? r.item_price ?? 0,
          refunded_amount: r.refundedAmount ?? r.refunded_amount ?? 0,
          refund_tax: r.refundTax ?? r.refund_tax ?? 0,
          refunded_referral_fee: r.refundedReferralFee ?? r.refunded_referral_fee ?? 0,
          refund_commission: r.refundCommission ?? r.refund_commission ?? 0,
          refund_restocking_fee: r.refundRestockingFee ?? r.refund_restocking_fee ?? 0,
          fba_customer_return_per_unit_fee: r.fbaCustomerReturnPerUnitFee ?? r.fba_customer_return_per_unit_fee ?? 0,
          fba_customer_return_fee: r.fbaCustomerReturnFee ?? r.fba_customer_return_fee ?? 0,
          customer_return_hrr_unit_fee: r.customerReturnHrrUnitFee ?? r.customer_return_hrr_unit_fee ?? 0,
          cogs_total_value: r.cogsTotalValue ?? r.cogs_total_value ?? 0,
          refund_event_count: r.refundEventCount ?? r.refund_event_count ?? 0,
          source_request_hash: r.sourceRequestHash ?? r.source_request_hash ?? "",
          refreshed_at: r.refreshedAt ?? r.refreshed_at ?? null,
          calculated_at: r.calculatedAt ?? r.calculated_at ?? null,
        })),
      },
    });
    const value = Array.isArray(body) ? body[0] : body;
    return { write: "ok", replaced: value?.settlementsReplaced ?? 0, inserted: value?.settlementsInserted ?? 0, error: null };
  } catch (writeError) {
    if (isSchemaMissingError(writeError)) return { write: "schema-missing", replaced: 0, inserted: 0, error: "SETTLEMENT_HISTORY_SCHEMA_MISSING" };
    return { write: "write-failed", replaced: 0, inserted: 0, error: "SETTLEMENT_HISTORY_REPLACE_FAILED" };
  }
}

// Durable read helper for future fulfillment / state / city contribution slices WITHOUT another historical
// DataDoe export: reads the NON-CANCELLED dimensional OLI rows over a window for a set of accounts, aggregated by
// the requested dimension keys. `dimensions` is a subset of ['fulfillment_channel','address_state','address_city']
// (a blank value is returned as '' -- unavailable, never invented). Cancelled rows are excluded (they contribute
// zero to any dashboard contribution). Paginated + hard-capped like getSourceOliHistoryRows.
export async function getSourceOliDimensionalContribution({ organizationFingerprint, connectionId = "primary", accountIds = null, from, to, dimensions = ["fulfillment_channel"], includeCancelled = false, maxRows = SOURCE_OLI_HISTORY_MAX_ROWS, pageRows = SOURCE_OLI_HISTORY_PAGE_ROWS, signal = null } = {}) {
  if (!organizationFingerprint || !from || !to) {
    throw new Error("getSourceOliDimensionalContribution requires organizationFingerprint + from + to (fail closed).");
  }
  const ALLOWED = new Set(["fulfillment_channel", "address_state", "address_city", "amazon_order_status"]);
  const dims = [...new Set((Array.isArray(dimensions) ? dimensions : []).map(String))].filter((d) => ALLOWED.has(d));
  if (!dims.length) throw new Error("getSourceOliDimensionalContribution requires at least one supported dimension (fail closed).");
  const PAGE = Math.max(1, Number(pageRows) || SOURCE_OLI_HISTORY_PAGE_ROWS);
  const select = ["account_id", "sale_date", "currency", ...dims, "total_sales_sum", "total_units_sum", "is_cancelled"].join(",");
  const raw = [];
  for (let offset = 0; ; offset += PAGE) {
    const query = new URLSearchParams({
      select,
      organization_fingerprint: `eq.${organizationFingerprint}`,
      connection_id: `eq.${connectionId}`,
      sale_date: `gte.${from}`,
      order: "sale_date.asc,account_id.asc",
      limit: String(PAGE),
      offset: String(offset),
    });
    query.append("sale_date", `lte.${to}`);
    if (!includeCancelled) query.append("is_cancelled", "eq.false");
    if (Array.isArray(accountIds) && accountIds.length) {
      query.append("account_id", `in.(${accountIds.map((a) => `"${String(a).replaceAll('"', "")}"`).join(",")})`);
    }
    const rows = await request(`/rest/v1/source_oli_dimensional_history?${query}`, { signal });
    const list = Array.isArray(rows) ? rows : [];
    // Additive canonical fulfillment category (raw fulfillment_channel preserved): folds Amazon/AFN and
    // Merchant/MFN synonyms into ONE bucket each so a contribution aggregation grouping on fulfillment_category can
    // never split a total into four separate categories. Only attached when fulfillment_channel was selected.
    if (dims.includes("fulfillment_channel")) {
      for (const r of list) r.fulfillment_category = normalizeFulfillmentChannel(r.fulfillment_channel);
    }
    raw.push(...list);
    if (raw.length > maxRows) {
      const err = new Error("OLI_DIM_ROW_LIMIT_EXCEEDED: durable OLI dimensional read exceeded its row cap; refusing a truncated series (fail closed).");
      err.code = "OLI_DIM_ROW_LIMIT_EXCEEDED";
      throw err;
    }
    if (list.length < PAGE) break;
  }
  return raw;
}

// Read the durable EXPLICIT-ZERO OLI grain rows for ONE account over a date range: NON-cancelled, order value
// PRESENT and numerically == 0, positive units. These are the audit-only present-zero units (promotional /
// replacement / free / incomplete) the data-quality indicator surfaces -- NEVER business Sales/Units, and NEVER
// the NULL/missing class (the dimensional table cannot hold a NULL-value row; that window is refused + LKG-kept).
// ZERO DataDoe. Paginated + hard-capped like getSourceOliDimensionalContribution. Only safe, already-stored fields
// are selected (never amazon_order_id / address_country).
export async function getExplicitZeroOliUnits({ organizationFingerprint, connectionId = "primary", accountId, from, to, maxRows = SOURCE_OLI_HISTORY_MAX_ROWS, pageRows = SOURCE_OLI_HISTORY_PAGE_ROWS, signal = null } = {}) {
  if (!organizationFingerprint || !accountId || !from || !to) {
    throw new Error("getExplicitZeroOliUnits requires organizationFingerprint + accountId + from + to (fail closed).");
  }
  const PAGE = Math.max(1, Number(pageRows) || SOURCE_OLI_HISTORY_PAGE_ROWS);
  const raw = [];
  for (let offset = 0; ; offset += PAGE) {
    const query = new URLSearchParams({
      select: "sale_date,sku,child_asin,currency,amazon_order_status,fulfillment_channel,address_state,address_city,total_units_sum",
      organization_fingerprint: `eq.${organizationFingerprint}`,
      connection_id: `eq.${connectionId}`,
      account_id: `eq.${accountId}`,
      sale_date: `gte.${from}`,
      is_cancelled: "eq.false",
      total_sales_sum: "eq.0",       // PRESENT and exactly zero (a NULL/missing value is is.null -> never matched here)
      total_units_sum: "gt.0",       // positive units only
      order: "sale_date.desc,sku.asc",
      limit: String(PAGE),
      offset: String(offset),
    });
    query.append("sale_date", `lte.${to}`);
    const rows = await request(`/rest/v1/source_oli_dimensional_history?${query}`, { signal });
    const list = Array.isArray(rows) ? rows : [];
    raw.push(...list);
    if (raw.length > maxRows) {
      const err = new Error("OLI_EXPLICIT_ZERO_ROW_LIMIT_EXCEEDED: explicit-zero OLI read exceeded its row cap; refusing a truncated series (fail closed).");
      err.code = "OLI_EXPLICIT_ZERO_ROW_LIMIT_EXCEEDED";
      throw err;
    }
    if (list.length < PAGE) break;
  }
  return raw;
}

// Raw dimensional rows (ALL classes, cancelled included) for ONE account over a window -- the zero-export input the
// operational-units BACKFILL classifies into per-class unit sums. Selects only already-stored safe fields. Note:
// PENDING (null-price) rows are NOT in the dimensional table (they were never persisted at grain), so a backfill
// reconstructs priced + explicit-zero + cancelled units only; pending units flow forward from the next OLI sync.
export async function getSourceOliDimensionalUnitRows({ organizationFingerprint, connectionId = "primary", accountId, from, to, maxRows = SOURCE_OLI_HISTORY_MAX_ROWS, pageRows = SOURCE_OLI_HISTORY_PAGE_ROWS, signal = null } = {}) {
  if (!organizationFingerprint || !accountId || !from || !to) {
    throw new Error("getSourceOliDimensionalUnitRows requires organizationFingerprint + accountId + from + to (fail closed).");
  }
  const PAGE = Math.max(1, Number(pageRows) || SOURCE_OLI_HISTORY_PAGE_ROWS);
  const raw = [];
  for (let offset = 0; ; offset += PAGE) {
    const query = new URLSearchParams({
      select: "seller_or_vendor_id,sale_date,sku,child_asin,currency,is_cancelled,total_sales_sum,total_units_sum,source_request_hash",
      organization_fingerprint: `eq.${organizationFingerprint}`,
      connection_id: `eq.${connectionId}`,
      account_id: `eq.${accountId}`,
      sale_date: `gte.${from}`,
      order: "sale_date.asc,sku.asc,child_asin.asc,currency.asc",
      limit: String(PAGE),
      offset: String(offset),
    });
    query.append("sale_date", `lte.${to}`);
    const rows = await request(`/rest/v1/source_oli_dimensional_history?${query}`, { signal });
    const list = Array.isArray(rows) ? rows : [];
    raw.push(...list);
    if (raw.length > maxRows) {
      const err = new Error("OLI_DIM_UNIT_ROW_LIMIT_EXCEEDED: dimensional unit read exceeded its row cap; refusing a truncated series (fail closed).");
      err.code = "OLI_DIM_UNIT_ROW_LIMIT_EXCEEDED";
      throw err;
    }
    if (list.length < PAGE) break;
  }
  return raw;
}

// The ORDER-LEVEL explicit-zero audit for ONE account over a date range, from source_oli_order_audit: the SAME
// present-zero class as getExplicitZeroOliUnits (NON-cancelled, value present == 0, positive units) but at order
// grain WITH the captured amazon_order_id and its order_id_available flag. ZERO DataDoe (Supabase-only). Strictly
// account-scoped (never crosses accounts). Rows captured BEFORE this feature simply do not exist here (the audit
// table is future-only); rows whose source had no Order ID come back with amazon_order_id '' + order_id_available
// false. Paginated + hard-capped like the dimensional reads (never a silently truncated series).
export async function getExplicitZeroOliOrderAudit({ organizationFingerprint, connectionId = "primary", accountId, from, to, maxRows = SOURCE_OLI_HISTORY_MAX_ROWS, pageRows = SOURCE_OLI_HISTORY_PAGE_ROWS, signal = null } = {}) {
  if (!organizationFingerprint || !accountId || !from || !to) {
    throw new Error("getExplicitZeroOliOrderAudit requires organizationFingerprint + accountId + from + to (fail closed).");
  }
  const PAGE = Math.max(1, Number(pageRows) || SOURCE_OLI_HISTORY_PAGE_ROWS);
  const raw = [];
  for (let offset = 0; ; offset += PAGE) {
    const query = new URLSearchParams({
      select: "sale_date,sku,child_asin,currency,amazon_order_status,fulfillment_channel,address_state,address_city,amazon_order_id,order_id_available,total_units_sum",
      organization_fingerprint: `eq.${organizationFingerprint}`,
      connection_id: `eq.${connectionId}`,
      account_id: `eq.${accountId}`,
      sale_date: `gte.${from}`,
      is_cancelled: "eq.false",
      total_sales_sum: "eq.0",       // PRESENT and exactly zero (NULL/missing is never stored here)
      total_units_sum: "gt.0",       // positive units only
      order: "sale_date.desc,sku.asc",
      limit: String(PAGE),
      offset: String(offset),
    });
    query.append("sale_date", `lte.${to}`);
    const rows = await request(`/rest/v1/source_oli_order_audit?${query}`, { signal });
    const list = Array.isArray(rows) ? rows : [];
    raw.push(...list);
    if (raw.length > maxRows) {
      const err = new Error("OLI_ORDER_AUDIT_ROW_LIMIT_EXCEEDED: order-audit read exceeded its row cap; refusing a truncated series (fail closed).");
      err.code = "OLI_ORDER_AUDIT_ROW_LIMIT_EXCEEDED";
      throw err;
    }
    if (list.length < PAGE) break;
  }
  return raw;
}

// Compact per-account OLI data-quality counts for the Data Sync Center (read-only, ZERO DataDoe): explicit-zero
// non-cancelled units, cancelled audit units, and the latest dimensional coverage date. The NULL/missing class is
// not stored durably (refused windows preserve LKG), so it is surfaced as blocked-window evidence elsewhere.
export async function getAccountOliQualityCounts({ organizationFingerprint, connectionId = "primary", accountId, signal = null } = {}) {
  if (!organizationFingerprint || !accountId) throw new Error("getAccountOliQualityCounts requires organizationFingerprint + accountId (fail closed).");
  const base = {
    organization_fingerprint: `eq.${organizationFingerprint}`,
    connection_id: `eq.${connectionId}`,
    account_id: `eq.${accountId}`,
  };
  // Bounded reads that sum units in JS -- explicit-zero + cancelled rows are few per account, so a small paginated
  // read is cheap and needs no aggregate RPC/view. ZERO DataDoe.
  const readUnits = async (extra) => {
    let units = 0; let rows = 0; const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const q = new URLSearchParams({ ...base, select: "total_units_sum", limit: String(PAGE), offset: String(offset), ...extra });
      const list = await request(`/rest/v1/source_oli_dimensional_history?${q}`, { signal });
      const arr = Array.isArray(list) ? list : [];
      for (const r of arr) { units += Number(r.total_units_sum) || 0; rows += 1; }
      if (arr.length < PAGE || rows > 200000) break;
    }
    return { units, rows };
  };
  const explicitZero = await readUnits({ is_cancelled: "eq.false", total_sales_sum: "eq.0", total_units_sum: "gt.0" });
  const cancelled = await readUnits({ is_cancelled: "eq.true" });
  const latest = await request(`/rest/v1/source_oli_dimensional_history?${new URLSearchParams({ ...base, select: "sale_date", order: "sale_date.desc", limit: "1" })}`, { signal }).catch(() => []);
  return {
    explicitZeroUnits: explicitZero.units, explicitZeroRows: explicitZero.rows,
    cancelledUnits: cancelled.units, cancelledRows: cancelled.rows,
    latestDimensionalDate: Array.isArray(latest) && latest[0] ? String(latest[0].sale_date) : null,
  };
}

// Proven successful coverage windows for one (account|__organization, source). Typed like getDailyAdsCoverage.
export async function getSourceCoverageWindows({ organizationFingerprint, connectionId = "primary", accountId, sourceKey, signal = null }) {
  try {
    const query = new URLSearchParams({
      select: "covered_from,covered_to",
      organization_fingerprint: `eq.${organizationFingerprint}`,
      connection_id: `eq.${connectionId}`,
      account_id: `eq.${accountId}`,
      source_key: `eq.${sourceKey}`,
      status: "eq.succeeded",
      order: "covered_from.asc",
    });
    const rows = await request(`/rest/v1/source_coverage?${query}`, { signal });
    return { windows: (rows || []).map((r) => ({ from: r.covered_from, to: r.covered_to })), read: "ok", error: null };
  } catch (readError) {
    if (isSchemaMissingError(readError)) return { windows: [], read: "schema-missing", error: "SOURCE_COVERAGE_SCHEMA_MISSING" };
    return { windows: [], read: "read-failed", error: "SOURCE_COVERAGE_READ_FAILED" };
  }
}

// Narrow, READ-ONLY durable ZERO-ROW OLI proof reader for the shared resolveOliLineageProvenance() proven-empty
// path. For each requested account it returns the SUCCEEDED, bounded, row_count=0 OLI exports that account is an
// ACTIVE owner of, as { requestHash, from, to } (windows read from the source job's request_meta). It joins the
// durable ownership (sync_source_job_owners: the exact account <-> request_hash membership) with the durable source
// jobs (sync_source_jobs: fetch_status + row_count + request_meta) -- a request_hash is content-addressed, so the
// same bounded export is stable across cycles. It NEVER returns a positive-row, failed, unbounded, cross-org,
// cross-connection, non-OLI, or non-owned export. FAIL CLOSED: a schema-missing / read-failed / row-cap read
// returns read != 'ok' with an EMPTY map, so the resolver yields 'missing' (never a fabricated proven-empty).
export async function getSourceOliZeroRowProof({
  organizationFingerprint, connectionId = "primary", accountIds, sourceKey = "order-line-items",
  ownerRequestKey = "source-oli:slice-v1", maxRows = 5000, pageRows = 1000, signal = null,
} = {}) {
  const byAccount = new Map();
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : []).map((a) => String(a || "").trim()).filter(Boolean))];
  if (!organizationFingerprint || ids.length === 0) return { read: "ok", byAccount, error: null };
  const inList = (vals) => `in.(${vals.map((v) => `"${String(v).replaceAll('"', "")}"`).join(",")})`;
  try {
    // 1) ACTIVE OLI owner memberships for these accounts -> the exact account <-> request_hash edges (across cycles).
    const hashesByAccount = new Map(); // accountId -> Set(request_hash)
    const allHashes = new Set();
    for (let offset = 0; ; offset += pageRows) {
      const q = new URLSearchParams({
        select: "account_id,request_hash",
        organization_fingerprint: `eq.${organizationFingerprint}`,
        connection_id: `eq.${connectionId}`,
        owner_status: "eq.active",
        request_key: `eq.${ownerRequestKey}`,
        order: "request_hash.asc,account_id.asc",
        limit: String(pageRows), offset: String(offset),
      });
      q.append("account_id", inList(ids));
      const rows = await request(`/rest/v1/sync_source_job_owners?${q}`, { signal });
      const list = Array.isArray(rows) ? rows : [];
      for (const r of list) {
        const aid = String(r.account_id || "").trim();
        const h = String(r.request_hash || "").trim();
        if (!aid || !h) continue;
        if (!hashesByAccount.has(aid)) hashesByAccount.set(aid, new Set());
        hashesByAccount.get(aid).add(h);
        allHashes.add(h);
      }
      if (allHashes.size > maxRows) return { read: "read-failed", byAccount: new Map(), error: "OLI_ZERO_ROW_OWNER_LIMIT_EXCEEDED" };
      if (list.length < pageRows) break;
    }
    if (allHashes.size === 0) return { read: "ok", byAccount, error: null };
    // 2) The SUCCEEDED, bounded, row_count=0 OLI source jobs for those hashes -> requestHash -> { from, to }.
    const metaByHash = new Map();
    const hashArr = [...allHashes];
    for (let i = 0; i < hashArr.length; i += 100) {
      const q = new URLSearchParams({
        select: "request_hash,request_meta",
        organization_fingerprint: `eq.${organizationFingerprint}`,
        connection_id: `eq.${connectionId}`,
        source_key: `eq.${sourceKey}`,
        fetch_status: "eq.succeeded",
        row_count: "eq.0",
      });
      q.append("request_hash", inList(hashArr.slice(i, i + 100)));
      const rows = await request(`/rest/v1/sync_source_jobs?${q}`, { signal });
      for (const r of (Array.isArray(rows) ? rows : [])) {
        const h = String(r.request_hash || "").trim();
        const m = r.request_meta && typeof r.request_meta === "object" ? r.request_meta : null;
        const from = m ? String(m.from || "").trim() : "";
        const to = m ? String(m.to || "").trim() : "";
        if (h && from && to && !metaByHash.has(h)) metaByHash.set(h, { from, to });
      }
    }
    // 3) Per account: exactly the succeeded row_count=0 exports it owns, with their bounded windows + real hash.
    for (const [aid, hs] of hashesByAccount) {
      const exps = [];
      for (const h of hs) { const m = metaByHash.get(h); if (m) exps.push({ requestHash: h, from: m.from, to: m.to }); }
      if (exps.length) byAccount.set(aid, exps.sort((a, b) => (a.requestHash < b.requestHash ? -1 : 1)));
    }
    return { read: "ok", byAccount, error: null };
  } catch (readError) {
    if (isSchemaMissingError(readError)) return { read: "schema-missing", byAccount: new Map(), error: "OLI_ZERO_ROW_PROOF_SCHEMA_MISSING" };
    return { read: "read-failed", byAccount: new Map(), error: "OLI_ZERO_ROW_PROOF_READ_FAILED" };
  }
}

export async function recordSourceCoverageWindows(rows) {
  const payload = (rows || [])
    .filter((r) => r && r.organizationFingerprint && r.accountId && r.sourceKey && r.coveredFrom && r.coveredTo)
    .map((r) => ({
      organization_fingerprint: r.organizationFingerprint,
      connection_id: r.connectionId || "primary",
      account_id: r.accountId,
      source_key: r.sourceKey,
      covered_from: r.coveredFrom,
      covered_to: r.coveredTo,
      status: "succeeded",
      source_refreshed_at: r.sourceRefreshedAt || new Date().toISOString(),
    }));
  if (payload.length !== (rows || []).length) {
    throw new Error("recordSourceCoverageWindows: a window is missing its identity; rejecting the whole batch (fail closed).");
  }
  if (!payload.length) return { write: "ok", recorded: 0, error: null };
  try {
    await request("/rest/v1/source_coverage?on_conflict=organization_fingerprint,connection_id,account_id,source_key,covered_from,covered_to", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: payload,
    });
    return { write: "ok", recorded: payload.length, error: null };
  } catch (writeError) {
    if (isSchemaMissingError(writeError)) return { write: "schema-missing", recorded: 0, error: "SOURCE_COVERAGE_SCHEMA_MISSING" };
    return { write: "write-failed", recorded: 0, error: "SOURCE_COVERAGE_WRITE_FAILED" };
  }
}

// SOURCE-level controls (Data Sync Center). Reads return every row; a missing schema reads as [] with a
// typed marker so the UI can say "not migrated" rather than "everything running".
export async function getSourceControls({ signal = null } = {}) {
  try {
    const rows = await request("/rest/v1/source_controls?select=source_key,paused,schedule_enabled,updated_at&order=source_key.asc", { signal });
    return { rows: Array.isArray(rows) ? rows : [], read: "ok", error: null };
  } catch (readError) {
    if (isSchemaMissingError(readError)) return { rows: [], read: "schema-missing", error: "SOURCE_CONTROLS_SCHEMA_MISSING" };
    return { rows: [], read: "read-failed", error: "SOURCE_CONTROLS_READ_FAILED" };
  }
}

// Sets ONLY the supplied control fields. Pause stops NEW source exports; it never deletes durable
// history/coverage/snapshots (nothing here can -- this wrapper only writes the control row).
export async function setSourceControl({ sourceKey, paused, scheduleEnabled, updatedBy = null }) {
  const key = String(sourceKey || "").trim();
  if (!key) throw new Error("setSourceControl requires a nonblank sourceKey (fail closed).");
  const body = { source_key: key };
  if (paused !== undefined) body.paused = paused === true;
  if (scheduleEnabled !== undefined) body.schedule_enabled = scheduleEnabled === true;
  if (updatedBy) body.updated_by = updatedBy;
  await request("/rest/v1/source_controls?on_conflict=source_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: [body],
  });
  return { write: "ok" };
}

export async function getSourceRunStatuses() {
  try {
    const rows = await request("/rest/v1/source_run_status?select=source_key,bucket,last_status,last_attempt_at,last_success_at,safe_error_code,safe_error_stage,covered_from,covered_to,accounts_completed,accounts_failed,accounts_total,batch_count,creates_spent,tokens_spent,creates_ceiling,tokens_ceiling,updated_at&order=source_key.asc,bucket.asc");
    return { rows: Array.isArray(rows) ? rows : [], read: "ok", error: null };
  } catch (readError) {
    if (isSchemaMissingError(readError)) return { rows: [], read: "schema-missing", error: "SOURCE_RUN_STATUS_SCHEMA_MISSING" };
    return { rows: [], read: "read-failed", error: "SOURCE_RUN_STATUS_READ_FAILED" };
  }
}

const SAFE_ERROR_MAX = 200;

export async function upsertSourceRunStatus(entry, { signal = null } = {}) {
  const key = String(entry && entry.sourceKey || "").trim();
  const bucket = entry && entry.bucket;
  if (!key || !isRoutingScope(bucket)) {
    throw new Error("upsertSourceRunStatus requires a nonblank sourceKey and a routing-scope bucket (india|europe-au|us-ca|us|non-us; fail closed).");
  }
  const body = { source_key: key, bucket };
  const setIf = (name, value) => { if (value !== undefined) body[name] = value; };
  setIf("last_status", entry.lastStatus);
  setIf("last_attempt_at", entry.lastAttemptAt);
  setIf("last_success_at", entry.lastSuccessAt);
  setIf("safe_error_code", entry.safeErrorCode == null ? entry.safeErrorCode : String(entry.safeErrorCode).slice(0, SAFE_ERROR_MAX));
  setIf("safe_error_stage", entry.safeErrorStage == null ? entry.safeErrorStage : String(entry.safeErrorStage).slice(0, SAFE_ERROR_MAX));
  setIf("covered_from", entry.coveredFrom);
  setIf("covered_to", entry.coveredTo);
  setIf("accounts_completed", entry.accountsCompleted);
  setIf("accounts_failed", entry.accountsFailed);
  setIf("accounts_total", entry.accountsTotal);
  setIf("batch_count", entry.batchCount);
  setIf("creates_spent", entry.createsSpent);
  setIf("tokens_spent", entry.tokensSpent);
  setIf("creates_ceiling", entry.createsCeiling);
  setIf("tokens_ceiling", entry.tokensCeiling);
  await request("/rest/v1/source_run_status?on_conflict=source_key,bucket", {
    method: "POST",
    signal,
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: [body],
  });
  return { write: "ok" };
}

export async function getSourceSnapshot({ organizationFingerprint, connectionId = "primary", sourceKey, scopeKey, signal = null }) {
  if (!organizationFingerprint) throw new Error("getSourceSnapshot requires the organizationFingerprint (isolated durable identity; fail closed).");
  try {
    const query = new URLSearchParams({
      select: "organization_fingerprint,connection_id,source_key,scope_key,object_path,payload_sha,row_count,payload_bytes,source_request_hash,validated_at",
      organization_fingerprint: `eq.${organizationFingerprint}`,
      connection_id: `eq.${connectionId}`,
      source_key: `eq.${sourceKey}`,
      scope_key: `eq.${scopeKey}`,
      limit: "1",
    });
    const rows = await request(`/rest/v1/source_snapshots?${query}`, { signal });
    return { snapshot: rows && rows[0] ? rows[0] : null, read: "ok", error: null };
  } catch (readError) {
    if (isSchemaMissingError(readError)) return { snapshot: null, read: "schema-missing", error: "SOURCE_SNAPSHOT_SCHEMA_MISSING" };
    return { snapshot: null, read: "read-failed", error: "SOURCE_SNAPSHOT_READ_FAILED" };
  }
}

// Replace the latest-good snapshot pointer ONLY with a fully VALIDATED one. Every evidence field --
// including the ISOLATED organization/connection identity and the CONTENT hash the object path embeds --
// is REQUIRED; anything missing is rejected before any HTTP, so a failed/partial refresh can never replace
// a validated snapshot through this wrapper (latest-good preserved by construction). The pointer upsert is
// the atomic protocol's second half: the immutable content-addressed object was uploaded FIRST, so whatever
// save wins the pointer CAS, its metadata always references a complete object of ITS OWN content.
export async function recordSourceSnapshot({ organizationFingerprint, connectionId = "primary", sourceKey, scopeKey, objectPath, payloadSha, rowCount, payloadBytes = 0, sourceRequestHash, validatedAt, signal = null }) {
  const org = String(organizationFingerprint || "").trim();
  const key = String(sourceKey || "").trim();
  const scope = String(scopeKey || "").trim();
  const path = String(objectPath || "").trim();
  const sha = String(payloadSha || "").trim();
  const hash = String(sourceRequestHash || "").trim();
  if (!org || !key || !scope || !path || !sha || !hash || !validatedAt
    || (connectionId !== "primary" && connectionId !== "dd-secondary")
    || typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 0) {
    throw new Error("recordSourceSnapshot requires complete VALIDATED snapshot evidence (organizationFingerprint/connectionId/sourceKey/scopeKey/objectPath/payloadSha/rowCount/sourceRequestHash/validatedAt); refusing to replace the latest-good snapshot (fail closed).");
  }
  if (!path.endsWith(`/${sha}.json`)) {
    throw new Error("recordSourceSnapshot: the object path does not embed the declared payloadSha; metadata and payload must belong to the same save (fail closed).");
  }
  // Round-4 finding 8: the pointer replacement is the ATOMIC record_source_snapshot CAS -- replaced only
  // when strictly NEWER; an older concurrent save is 'stale-save' (no write; the newer evidence stands);
  // an equal-validated_at identical save is 'unchanged'; equal but CONFLICTING evidence is 'conflict'
  // (fail closed, no write).
  const body = await request("/rest/v1/rpc/record_source_snapshot", {
    method: "POST",
    signal,
    body: {
      p_organization_fingerprint: org, p_connection_id: connectionId,
      p_source_key: key, p_scope_key: scope, p_object_path: path, p_payload_sha: sha,
      p_row_count: rowCount, p_payload_bytes: payloadBytes, p_source_request_hash: hash, p_validated_at: validatedAt,
    },
  });
  // Round-5 blocker 6: validate the EXACT RPC acknowledgement. The CAS returns exactly one scalar from
  // {replaced, unchanged, stale-save, conflict}; anything else (null, unknown string, object, multi-row
  // array) means the guard we rely on did not run as reviewed, so the save is NOT acknowledged -- typed
  // failure, never a coerced "ok".
  let value = body;
  if (Array.isArray(body)) {
    if (body.length !== 1) {
      const err = new Error(`SOURCE_SNAPSHOT_ACK_INVALID: record_source_snapshot returned ${body.length} rows; exactly one scalar acknowledgement is required (fail closed).`);
      err.code = "SOURCE_SNAPSHOT_ACK_INVALID";
      throw err;
    }
    value = body[0];
  }
  const KNOWN_ACKS = ["replaced", "unchanged", "stale-save", "conflict"];
  if (typeof value !== "string" || !KNOWN_ACKS.includes(value)) {
    const err = new Error(`SOURCE_SNAPSHOT_ACK_INVALID: record_source_snapshot acknowledgement ${JSON.stringify(value)} is not one of ${KNOWN_ACKS.join("|")}; the save is unacknowledged (fail closed).`);
    err.code = "SOURCE_SNAPSHOT_ACK_INVALID";
    throw err;
  }
  const ack = value;
  if (ack === "conflict") {
    const err = new Error("SOURCE_SNAPSHOT_CONFLICT: an equal-validated_at snapshot with DIFFERENT content already exists; refusing to replace (fail closed).");
    err.code = "SOURCE_SNAPSHOT_CONFLICT";
    throw err;
  }
  return { write: "ok", ack };
}

// ===== Durable Listings / Listings-Raw snapshot pointers (migrations 20260926 / 20260927; PREPARED, UNAPPLIED until
// sign-off). The content-addressed PAYLOAD objects reuse saveSourceSnapshotPayload / getSourceSnapshotPayload (the object
// path already namespaces by sourceKey='listings'|'listings-raw', so listings/listings-raw/catalog/fba objects never
// collide + are content-address validated on hydrate). ONLY the per-(org,connection,account) POINTER tables + their CAS
// RPCs are new. Both RPCs share the 11-arg signature + the as_of-DOMINATES-validated_at freshness ladder
// (replaced | stale-save | unchanged | conflict); marketplace is IMMUTABLE per account (a different marketplace ->
// conflict). service_role-only EXECUTE. The JS never decides freshness -- the RPC's CAS does. =====

// Read the latest-good durable Listings (or Listings-Raw) pointer for ONE isolated (org, connection, account). Returns
// { snapshot, read, error } with read in {ok, schema-missing, read-failed}; schema-missing is the expected pre-apply
// state (fail-soft -> the reconciler defers "LISTINGS unavailable", never a fabricated zero).
async function getListingsSnapshotFamily({ table, schemaCode }, { organizationFingerprint, connectionId = "primary", accountId, signal = null } = {}) {
  if (!organizationFingerprint) throw new Error(`${schemaCode}: getSourceListings*Snapshot requires the organizationFingerprint (isolated durable identity; fail closed).`);
  if (!accountId) throw new Error(`${schemaCode}: getSourceListings*Snapshot requires the accountId (fail closed).`);
  try {
    const query = new URLSearchParams({
      select: "organization_fingerprint,connection_id,account_id,marketplace,source_key,as_of,object_path,payload_sha,row_count,payload_bytes,source_request_hash,validated_at",
      organization_fingerprint: `eq.${organizationFingerprint}`,
      connection_id: `eq.${connectionId}`,
      account_id: `eq.${accountId}`,
      limit: "1",
    });
    const rows = await request(`/rest/v1/${table}?${query}`, { signal });
    return { snapshot: rows && rows[0] ? rows[0] : null, read: "ok", error: null };
  } catch (readError) {
    if (isSchemaMissingError(readError)) return { snapshot: null, read: "schema-missing", error: `${schemaCode}_SCHEMA_MISSING` };
    return { snapshot: null, read: "read-failed", error: `${schemaCode}_READ_FAILED` };
  }
}
export const getSourceListingsSnapshot = (args) => getListingsSnapshotFamily({ table: "source_listings_snapshot", schemaCode: "SOURCE_LISTINGS_SNAPSHOT" }, args);
export const getSourceListingsRawSnapshot = (args) => getListingsSnapshotFamily({ table: "source_listings_raw_snapshot", schemaCode: "SOURCE_LISTINGS_RAW_SNAPSHOT" }, args);

// Region scan: ALL latest-good durable Listings (or Raw) pointers for (org, connection) at a specific as_of (the
// reconciler/WORK-D scan for a requested D-1). Uses the (org, connection, as_of) index. { snapshots:[...], read, error }.
async function getListingsSnapshotsByAsOfFamily({ table, schemaCode }, { organizationFingerprint, connectionId = "primary", asOf, signal = null } = {}) {
  if (!organizationFingerprint) throw new Error(`${schemaCode}: getSourceListings*SnapshotsByAsOf requires the organizationFingerprint (fail closed).`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ""))) throw new Error(`${schemaCode}: getSourceListings*SnapshotsByAsOf requires a YYYY-MM-DD asOf (fail closed).`);
  try {
    const query = new URLSearchParams({
      select: "organization_fingerprint,connection_id,account_id,marketplace,source_key,as_of,object_path,payload_sha,row_count,payload_bytes,source_request_hash,validated_at",
      organization_fingerprint: `eq.${organizationFingerprint}`,
      connection_id: `eq.${connectionId}`,
      as_of: `eq.${asOf}`,
    });
    const rows = await request(`/rest/v1/${table}?${query}`, { signal });
    return { snapshots: Array.isArray(rows) ? rows : [], read: "ok", error: null };
  } catch (readError) {
    if (isSchemaMissingError(readError)) return { snapshots: [], read: "schema-missing", error: `${schemaCode}_SCHEMA_MISSING` };
    return { snapshots: [], read: "read-failed", error: `${schemaCode}_READ_FAILED` };
  }
}
export const getSourceListingsSnapshotsByAsOf = (args) => getListingsSnapshotsByAsOfFamily({ table: "source_listings_snapshot", schemaCode: "SOURCE_LISTINGS_SNAPSHOT" }, args);
export const getSourceListingsRawSnapshotsByAsOf = (args) => getListingsSnapshotsByAsOfFamily({ table: "source_listings_raw_snapshot", schemaCode: "SOURCE_LISTINGS_RAW_SNAPSHOT" }, args);

// Record the latest-good durable Listings (or Listings-Raw) pointer via the SECURITY DEFINER CAS RPC. Every evidence
// field is REQUIRED + validated BEFORE any HTTP (a partial/failed refresh can never replace the latest-good snapshot);
// the object path must embed the declared payloadSha (metadata + payload belong to the same save). The RPC returns
// exactly one scalar in {replaced, unchanged, stale-save, conflict}; anything else is a typed ACK_INVALID (unacknowledged
// -> fail closed), and 'conflict' throws a typed CONFLICT (equal-as_of/validated_at with different content, or a
// different immutable marketplace). Freshness is the RPC's as_of-dominant CAS -- the JS never decides it.
async function recordListingsSnapshotFamily({ rpc, code }, { organizationFingerprint, connectionId = "primary", accountId, marketplace, asOf, objectPath, payloadSha, rowCount, payloadBytes = 0, sourceRequestHash, validatedAt, signal = null } = {}) {
  const org = String(organizationFingerprint || "").trim();
  const acct = String(accountId || "").trim();
  const mkt = String(marketplace || "").trim();
  const asof = String(asOf || "").trim();
  const path = String(objectPath || "").trim();
  const sha = String(payloadSha || "").trim();
  const hash = String(sourceRequestHash || "").trim();
  if (!org || !acct || acct.includes(":") || !/^[A-Z]{2}$/.test(mkt) || !/^\d{4}-\d{2}-\d{2}$/.test(asof)
    || !path || !sha || !hash || !validatedAt
    || (connectionId !== "primary" && connectionId !== "dd-secondary")
    || typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 0
    || typeof payloadBytes !== "number" || !Number.isInteger(payloadBytes) || payloadBytes < 0) {
    throw new Error(`${code}: requires complete VALIDATED listings snapshot evidence (organizationFingerprint / connectionId in {primary,dd-secondary} / accountId[no ':'] / marketplace[^[A-Z]{2}$] / asOf[YYYY-MM-DD] / objectPath / payloadSha / rowCount>=0 / payloadBytes>=0 / sourceRequestHash / validatedAt); refusing to replace the latest-good snapshot (fail closed).`);
  }
  if (!path.endsWith(`/${sha}.json`)) {
    throw new Error(`${code}: the object path does not embed the declared payloadSha; metadata and payload must belong to the same save (fail closed).`);
  }
  const body = await request(`/rest/v1/rpc/${rpc}`, {
    method: "POST",
    signal,
    body: {
      p_organization_fingerprint: org, p_connection_id: connectionId,
      p_account_id: acct, p_marketplace: mkt, p_as_of: asof,
      p_object_path: path, p_payload_sha: sha, p_row_count: rowCount,
      p_payload_bytes: payloadBytes, p_source_request_hash: hash, p_validated_at: validatedAt,
    },
  });
  let value = body;
  if (Array.isArray(body)) {
    if (body.length !== 1) { const err = new Error(`${code}_ACK_INVALID: ${rpc} returned ${body.length} rows; exactly one scalar acknowledgement is required (fail closed).`); err.code = `${code}_ACK_INVALID`; throw err; }
    value = body[0];
  }
  const KNOWN_ACKS = ["replaced", "unchanged", "stale-save", "conflict"];
  if (typeof value !== "string" || !KNOWN_ACKS.includes(value)) { const err = new Error(`${code}_ACK_INVALID: acknowledgement ${JSON.stringify(value)} is not one of ${KNOWN_ACKS.join("|")}; the save is unacknowledged (fail closed).`); err.code = `${code}_ACK_INVALID`; throw err; }
  if (value === "conflict") { const err = new Error(`${code}_CONFLICT: an equal-as_of/validated_at snapshot with DIFFERENT content (or a different immutable marketplace) already exists; refusing to replace (fail closed).`); err.code = `${code}_CONFLICT`; throw err; }
  return { write: "ok", ack: value };
}
export const recordSourceListingsSnapshot = (args) => recordListingsSnapshotFamily({ rpc: "record_source_listings_snapshot", code: "SOURCE_LISTINGS_SNAPSHOT" }, args);
export const recordSourceListingsRawSnapshot = (args) => recordListingsSnapshotFamily({ rpc: "record_source_listings_raw_snapshot", code: "SOURCE_LISTINGS_RAW_SNAPSHOT" }, args);

// Insert-if-absent: ignore-duplicates so a resumed invocation never resets an
// in-progress or completed job (unique cycle_id, request_hash). connection_id must be an
// explicit 'primary'/'dd-secondary' from the plan — there is NO silent 'primary' default.
//
// The organization fingerprint is a hard handoff invariant: the durable job row is the
// record the one-attempt claim (claim_source_export_attempt) and the DataDoe adapter later
// key organization routing off. We REQUIRE a non-empty organizationFingerprint and reject
// BEFORE any PostgREST request, so a fingerprint-less job is never written (never as an
// empty string) and never reaches the one-attempt claim.
export async function upsertSyncSourceJob(job, { signal = null } = {}) {
  if (job.connectionId !== "primary" && job.connectionId !== "dd-secondary") {
    throw new Error(`upsertSyncSourceJob requires an explicit connection_id of 'primary' or 'dd-secondary' (got "${job.connectionId}").`);
  }
  if (!job.organizationFingerprint) {
    throw new Error("upsertSyncSourceJob requires a non-empty organizationFingerprint; refusing to write a source job with an empty organization fingerprint.");
  }
  await request("/rest/v1/sync_source_jobs?on_conflict=cycle_id,request_hash", {
    method: "POST",
    signal,
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: {
      cycle_id: job.cycleId,
      request_hash: job.requestHash,
      source_id: job.sourceId || "",
      source_key: job.sourceKey || "",
      organization_fingerprint: job.organizationFingerprint,
      connection_id: job.connectionId,
      account_scope_hash: job.accountScopeHash || "",
      request_meta: job.requestMeta || {},
      bucket: job.bucket,
    },
  });
}

// Canonical source jobs only. request_key is NOT a column here and is NOT ownership authority (report
// ownership lives in sync_source_job_owners); the SELECT lists only real sync_source_jobs columns.
// cache_object_path is REQUIRED: the priority-release finalize proves an ADOPTING bucket's warm-cache evidence
// (create_export_count=0) by reading it off the catalog source job. Omitting it made every adopting-bucket
// finalize fail closed as "no-cache-evidence" even though the durable row carries the path.
const SOURCE_JOB_COLUMNS = "id,request_hash,source_id,source_key,connection_id,organization_fingerprint,account_scope_hash,fetch_status,attempted_at,create_export_count,export_id,cache_object_path,terminal,error_stage,error_code,row_count";

export async function getSyncSourceJobs(cycleId, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: SOURCE_JOB_COLUMNS,
    cycle_id: `eq.${cycleId}`,
    order: "created_at.asc",
  });
  return request(`/rest/v1/sync_source_jobs?${query}`, { signal });
}

// The same read plus request_meta (which carries the canonical window from/to). Used ONLY by the trusted OLI
// download-recovery operator to VERIFY a target job's exact window before recovering it -- never by the worker.
export async function getSyncSourceJobsWithMeta(cycleId, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: SOURCE_JOB_COLUMNS + ",request_meta",
    cycle_id: `eq.${cycleId}`,
    order: "created_at.asc",
  });
  return request(`/rest/v1/sync_source_jobs?${query}`, { signal });
}

/* ===== Scheduler v2: normalized source-job OWNERSHIP (sync_source_job_owners) wrappers =====
   Many memberships per canonical (cycle_id, request_hash); unique(cycle_id, request_hash, owner_id).
   sync_source_jobs stays one row/export per canonical hash with NO report-specific ownership authority.
   These persist/read WHICH owner scopes may process/resume/read a canonical source, and record safe
   owner-level stale status without ever failing or corrupting the shared canonical row. No secrets. */

const SOURCE_JOB_OWNER_COLUMNS = "id,cycle_id,request_hash,owner_id,request_key,report_key,account_id,connection_id,organization_fingerprint,account_scope_hash,owner_status,error_code,error_message";
const OWNER_CONNECTION_IDS = new Set(["primary", "dd-secondary"]);

// Upsert owner memberships. Reactivation is intended: a re-declared membership resolution=merge-duplicates
// resets owner_status back to 'active' and clears any prior stale error (an owner that needs the hash
// again this cycle owns it again). Fails closed BEFORE any request on an incomplete membership so an
// ambiguous/secretless-but-empty owner identity is never written.
export async function upsertSyncSourceJobOwners(memberships, { signal = null } = {}) {
  const rows = (memberships || []).map((m) => {
    const ownerId = String(m.ownerId || m.owner_id || "").trim();
    const requestHash = String(m.requestHash || m.request_hash || "").trim();
    const requestKey = String(m.requestKey || m.request_key || "").trim();
    const reportKey = String(m.reportKey || m.report_key || "").trim();
    const accountId = String(m.accountId || m.account_id || "").trim();
    const connectionId = String(m.connectionId || m.connection_id || "").trim();
    const organizationFingerprint = String(m.organizationFingerprint || m.organization_fingerprint || "").trim();
    const accountScopeHash = String(m.accountScopeHash || m.account_scope_hash || "").trim();
    // Complete owner metadata is REQUIRED (nothing blank), and connection_id must be a supported typed
    // value -- it participates in owner identity.
    if (!ownerId || !requestHash || !requestKey || !reportKey || !accountId || !organizationFingerprint || !accountScopeHash) {
      throw new Error("upsertSyncSourceJobOwners requires a non-empty owner_id, request_hash, request_key, report_key, account_id, organization_fingerprint and account_scope_hash on every membership.");
    }
    if (!OWNER_CONNECTION_IDS.has(connectionId)) {
      throw new Error(`upsertSyncSourceJobOwners requires connection_id in {primary, dd-secondary} (got "${connectionId}").`);
    }
    // RECOMPUTE the owner identity from its authoritative tuple and reject a supplied owner_id that does
    // not match -- a buggy caller can never place an account/org job under another owner. Never a secret.
    const expected = sourceJobOwnerId({ reportKey, connectionId, organizationFingerprint, accountScopeHash });
    if (!expected || expected !== ownerId) {
      throw new Error("upsertSyncSourceJobOwners rejected a membership whose owner_id does not match sourceJobOwnerId(reportKey, connectionId, organization_fingerprint, account_scope_hash).");
    }
    return {
      cycle_id: m.cycleId || m.cycle_id,
      request_hash: requestHash,
      owner_id: ownerId,
      request_key: requestKey,
      report_key: reportKey,
      account_id: accountId,
      connection_id: connectionId,
      organization_fingerprint: organizationFingerprint,
      account_scope_hash: accountScopeHash,
      owner_status: "active",
      error_code: null,
      error_message: null,
    };
  });
  if (!rows.length) return;
  await request("/rest/v1/sync_source_job_owners?on_conflict=cycle_id,request_hash,owner_id", {
    method: "POST",
    signal,
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: rows,
  });
}

// List memberships for a set of declared owner ids in one cycle (empty owner set => no rows).
export async function getSyncSourceJobOwners(cycleId, ownerIds, { signal = null } = {}) {
  const owners = [...new Set((ownerIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!owners.length) return [];
  const query = new URLSearchParams({
    select: SOURCE_JOB_OWNER_COLUMNS,
    cycle_id: `eq.${cycleId}`,
    owner_id: `in.(${owners.join(",")})`,
    order: "created_at.asc",
  });
  return request(`/rest/v1/sync_source_job_owners?${query}`, { signal });
}

// Round-6 fix 5: EVERY owner membership of one cycle (no owner-id filter). This is the AUTHORITATIVE
// account<->request_hash ownership the source-first lineage builds depends_on from: a batched OLI hash has
// one row per member account, an FBA hash exactly its account's row, and the organization-wide catalog its
// "__organization" row -- so a report job can depend ONLY on hashes its account genuinely owns (or the
// shared organization scope), never on another batch's export. Bounded: a cycle holds at most
// jobs x <=5 memberships.
export async function getSyncSourceJobOwnersForCycle(cycleId, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: SOURCE_JOB_OWNER_COLUMNS,
    cycle_id: `eq.${cycleId}`,
    order: "created_at.asc",
  });
  const rows = await request(`/rest/v1/sync_source_job_owners?${query}`, { signal });
  return Array.isArray(rows) ? rows : [];
}

// List the CANONICAL source jobs the declared owners depend on: their ACTIVE memberships' request_hashes,
// deduplicated, then the canonical rows for those hashes. (Powers admin report-wise / owner-scoped sync.)
export async function getSyncSourceJobsForOwners(cycleId, ownerIds, { signal = null } = {}) {
  const memberships = await getSyncSourceJobOwners(cycleId, ownerIds, { signal });
  const hashes = [...new Set(memberships.filter((m) => m.owner_status !== "stale").map((m) => m.request_hash))];
  if (!hashes.length) return [];
  const query = new URLSearchParams({
    select: SOURCE_JOB_COLUMNS,
    cycle_id: `eq.${cycleId}`,
    request_hash: `in.(${hashes.join(",")})`,
    order: "created_at.asc",
  });
  return request(`/rest/v1/sync_source_jobs?${query}`, { signal });
}

// Mark ONE owner's membership stale (its plan no longer needs this hash). This is owner-scoped only: it
// NEVER touches the canonical sync_source_jobs row or any other owner's membership, so a hash still owned
// by another owner remains executable/resumable/readable, and no DataDoe call is made for a stale owner.
export async function recordSyncSourceJobOwnerStale({ cycleId, requestHash, ownerId, code = "STALE_PLAN", message = null }, { signal = null } = {}) {
  const query = new URLSearchParams({
    cycle_id: `eq.${cycleId}`,
    request_hash: `eq.${requestHash}`,
    owner_id: `eq.${ownerId}`,
  });
  await request(`/rest/v1/sync_source_job_owners?${query}`, {
    method: "PATCH",
    signal,
    headers: { Prefer: "return=minimal" },
    body: { owner_status: "stale", error_code: code, error_message: message },
  });
}

async function patchSyncSourceJob(cycleId, requestHash, body, { signal = null } = {}) {
  const query = new URLSearchParams({ cycle_id: `eq.${cycleId}`, request_hash: `eq.${requestHash}` });
  await request(`/rest/v1/sync_source_jobs?${query}`, {
    method: "PATCH",
    signal,
    headers: { Prefer: "return=minimal" },
    body,
  });
}

export async function recordSyncSourceSuccess({ cycleId, requestHash, exportId = null, rowCount, payloadBytes, durationMs, cacheObjectPath }, { signal = null } = {}) {
  await patchSyncSourceJob(cycleId, requestHash, {
    fetch_status: "succeeded",
    succeeded_at: new Date().toISOString(),
    export_id: exportId,
    row_count: rowCount,
    payload_bytes: payloadBytes,
    duration_ms: durationMs,
    cache_object_path: cacheObjectPath,
    last_good_fetched_at: new Date().toISOString(),
    error_stage: null,
    error_code: null,
    error_message: null,
  }, { signal });
}

// Persist the DataDoe export id IMMEDIATELY after create-export, keeping fetch_status
// 'attempted' (set by the claim RPC), so a crash after the POST resumes poll/download
// WITHOUT a second create-export.
export async function recordSyncSourceExportCreated({ cycleId, requestHash, exportId }, { signal = null } = {}) {
  await patchSyncSourceJob(cycleId, requestHash, { export_id: exportId }, { signal });
}

// DOWNLOAD-ONLY recovery claim (Phase 2): atomically transition a FAILED, non-terminal, poll/download-stage job
// that already created EXACTLY ONE export -- and whose saved export id EXACTLY equals `expectedExportId` -- back
// to 'attempted', so a fresh invocation resumes poll/download of the SAME export_id WITHOUT a second create.
// A conditional PATCH (UPDATE ... WHERE fetch_status='failed' AND terminal is not true AND error_stage in
// (poll,download) AND create_export_count=1 AND export_id = expectedExportId), which PostgreSQL serializes so
// EXACTLY ONE worker wins; a concurrent claim updates zero rows and loses. The filter carries the exact expected
// export id, so a CHANGED export id can never be claimed. It sets ONLY fetch_status (create_export_count +
// export_id preserved -> the one-create-per-hash invariant holds). Then the RETURNED representation is validated
// EXACTLY (cycle_id, request_hash, fetch_status='attempted', terminal=false, error_stage in (poll,download),
// create_export_count=1, export_id === expectedExportId, byte-for-byte -- never trimmed). Returns 'claimed'
// only on a single exactly-matching row; 0 rows => 'not-eligible'; any zero/multi/wrong-row/missing-field/
// wrong-id/malformed response => null so the caller fails closed. No recovery RPC (mirrors claimReportDeriveAttempt).
export async function claimSourceExportRecovery(cycleId, requestHash, expectedExportId, { signal = null } = {}) {
  // A non-canonical expected id can never be claimed (fail closed BEFORE any write).
  if (typeof expectedExportId !== "string" || expectedExportId === "" || expectedExportId !== expectedExportId.trim()) return null;
  const query = new URLSearchParams({
    cycle_id: `eq.${cycleId}`,
    request_hash: `eq.${requestHash}`,
    fetch_status: "eq.failed",
    terminal: "not.is.true",
    error_stage: "in.(poll,download)",
    create_export_count: "eq.1",
    export_id: `eq.${expectedExportId}`,
    select: "cycle_id,request_hash,fetch_status,terminal,error_stage,create_export_count,export_id",
  });
  const rows = await request(`/rest/v1/sync_source_jobs?${query}`, {
    method: "PATCH",
    signal,
    headers: { Prefer: "return=representation" },
    body: { fetch_status: "attempted" },
  });
  if (!Array.isArray(rows)) return null; // malformed -> caller fails closed
  if (rows.length === 0) return "not-eligible"; // never matched, OR a concurrent winner already claimed it
  if (rows.length !== 1) return null; // >1 impossible for a (cycle, request_hash); fail closed
  const r = rows[0];
  const ok = String(r.cycle_id) === String(cycleId)
    && String(r.request_hash) === String(requestHash)
    && r.fetch_status === "attempted"
    && r.terminal === false // STRICT: a missing/true/non-false terminal fails closed (never coerced)
    && (r.error_stage === "poll" || r.error_stage === "download")
    && Number(r.create_export_count) === 1
    && typeof r.export_id === "string" && r.export_id === expectedExportId; // EXACT, never trimmed
  return ok ? "claimed" : null; // wrong-row / missing-field / wrong-id / malformed => fail closed
}

// Failure NEVER clears cache_object_path / last_good_fetched_at, so last-known-good
// source data survives. error_message is the SAFE operator string only.
export async function recordSyncSourceFailure({ cycleId, requestHash, stage, code, message, terminal = false, durationMs, rowCount = null, exportId = null }, { signal = null } = {}) {
  await patchSyncSourceJob(cycleId, requestHash, {
    fetch_status: "failed",
    failed_at: new Date().toISOString(),
    error_stage: stage,
    error_code: code,
    error_message: message,
    terminal,
    duration_ms: durationMs,
    row_count: rowCount,
    export_id: exportId,
  }, { signal });
}

// v3 optional-inventory (Item 4): record a reuse-only OPTIONAL source COMPLETE-AS-UNAVAILABLE. fetch_status
// 'skipped' is already a legal terminal state (no migration), and this NEVER touches create_export_count /
// attempted_at / cache_object_path / last_good_fetched_at, so the one-attempt constraint holds and LKG is
// preserved. It is a NON-failure terminal state: finalize counts it as neither open nor failed, so the dedicated
// cycle drains + finalizes 'succeeded' for the accounts whose required sources published.
export async function recordSyncSourceSkipped({ cycleId, requestHash, code = "MISSING_REUSABLE_SOURCE", message = null }, { signal = null } = {}) {
  await patchSyncSourceJob(cycleId, requestHash, {
    fetch_status: "skipped",
    error_stage: null,
    error_code: code,
    error_message: message,
    terminal: true,
  }, { signal });
}

/* ===== Scheduler v2 Phase 1d: sync_report_jobs (report-derivation) wrappers =====
   The report worker (lib/server/sync/report-worker.js) drives these. fetch/derive/save
   statuses are tracked separately (a Supabase save failure is never a DataDoe fetch
   failure), and a failure NEVER clears snapshot_params_hash / last_good_snapshot_at so the
   previous good shadow snapshot survives. There is no report-derive RPC; the atomic
   one-derive guard is a conditional PATCH (UPDATE ... WHERE derive_status='pending'), which
   PostgreSQL serializes so only one worker transitions the row. */

const REPORT_JOB_COLUMNS = "id,report_key,report_version,account_id,connection_id,bucket,depends_on,fetch_status,derive_status,save_status,validated,error_stage,error_code,error_message,row_count,payload_bytes,duration_ms,latest_data_date,snapshot_params_hash,last_good_snapshot_at";

export async function getSyncReportJobs(cycleId) {
  const query = new URLSearchParams({ select: REPORT_JOB_COLUMNS, cycle_id: `eq.${cycleId}`, order: "created_at.asc" });
  return request(`/rest/v1/sync_report_jobs?${query}`);
}

// Insert-if-absent so a resumed invocation never resets an in-progress/completed report job.
// connection_id must be explicit (fail-closed, like the source jobs); no silent 'primary'.
export async function upsertSyncReportJob(job, { signal = null } = {}) {
  if (job.connectionId !== "primary" && job.connectionId !== "dd-secondary") {
    throw new Error(`upsertSyncReportJob requires an explicit connection_id of 'primary' or 'dd-secondary' (got "${job.connectionId}").`);
  }
  const baseBody = {
    cycle_id: job.cycleId,
    report_key: job.reportKey,
    report_version: job.reportVersion || "",
    account_id: job.accountId,
    connection_id: job.connectionId,
    bucket: job.bucket,
    depends_on: job.dependsOn || [],
  };
  const post = (body) => request("/rest/v1/sync_report_jobs?on_conflict=cycle_id,report_key,account_id", {
    method: "POST",
    signal,
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body,
  });
  // durable_content_deps (migration 20260925, PREPARED-UNAPPLIED) is written ONLY when a report actually consumed a
  // durable CONTENT-provenance source (the FBA snapshot); OLI/daily/brand-sales pass none, so their insert body is
  // byte-identical to before (no extra column, no schema-missing retry). FAIL-SOFT: if the column is absent (migration
  // not applied) the insert with the column errors schema-missing and we retry the base body -- the content dep is then
  // simply not persisted (the reconciler degrades to re-derive-not-covered until the migration lands), never a crash.
  const contentDeps = Array.isArray(job.durableContentDeps) ? job.durableContentDeps : [];
  if (contentDeps.length > 0) {
    try { await post({ ...baseBody, durable_content_deps: contentDeps }); return; }
    catch (e) { if (!isSchemaMissingError(e)) throw e; /* column absent -> fall through to the base insert */ }
  }
  await post(baseBody);
}

// Atomic single-derive guard: transition pending -> running for exactly this (cycle, report,
// account). return=representation returns the row(s) actually updated; a concurrent worker
// that already moved it off 'pending' updates zero rows and loses the claim.
export async function claimReportDeriveAttempt(cycleId, reportKey, accountId, { signal = null } = {}) {
  const query = new URLSearchParams({ cycle_id: `eq.${cycleId}`, report_key: `eq.${reportKey}`, account_id: `eq.${accountId}`, derive_status: "eq.pending" });
  const rows = await request(`/rest/v1/sync_report_jobs?${query}`, {
    method: "PATCH",
    signal,
    headers: { Prefer: "return=representation" },
    body: { derive_status: "running" },
  });
  return Array.isArray(rows) && rows.length === 1;
}

async function patchSyncReportJob(cycleId, reportKey, accountId, body, { signal = null } = {}) {
  const query = new URLSearchParams({ cycle_id: `eq.${cycleId}`, report_key: `eq.${reportKey}`, account_id: `eq.${accountId}` });
  await request(`/rest/v1/sync_report_jobs?${query}`, { method: "PATCH", signal, headers: { Prefer: "return=minimal" }, body });
}

// A required source failed/was skipped: block THIS report TERMINALLY for the cycle so it is
// not reprocessed on later invocations. fetch=blocked + derive/save=skipped + validated=false
// is a consistent finished state; the snapshot and last_good_snapshot_at are untouched
// (last-known-good survives), and a NEW cycle re-derives.
export async function recordSyncReportBlocked({ cycleId, reportKey, accountId, reason }) {
  await patchSyncReportJob(cycleId, reportKey, accountId, {
    fetch_status: "blocked", derive_status: "skipped", save_status: "skipped", validated: false,
    error_stage: "fetch", error_code: "SOURCE_BLOCKED", error_message: reason || "required source unavailable",
  });
}

// Records a fetch/derive/validate/save failure on its own stage; NEVER clears
// snapshot_params_hash / last_good_snapshot_at. A non-terminal derive-pending (deps not yet
// derivable) keeps derive_status re-runnable in a later cycle.
export async function recordSyncReportFailure({ cycleId, reportKey, accountId, stage, code, message, terminal = false, durationMs = null }) {
  const body = {
    error_stage: stage, error_code: code, error_message: message, duration_ms: durationMs, failed_at: new Date().toISOString(),
  };
  if (stage === "save") {
    // Derive succeeded; only the snapshot save failed -> mark the stages distinctly so a
    // save failure is never read as a derivation failure. last_good_snapshot_at untouched.
    body.derive_status = "succeeded";
    body.save_status = "failed";
  } else {
    body.derive_status = "failed";
  }
  await patchSyncReportJob(cycleId, reportKey, accountId, body);
}

// SUCCESS requires fetch + derive + validate + save all passing. Sets validated=true, records
// the snapshot key + latest data date, and stamps last_good_snapshot_at.
export async function recordSyncReportSuccess({ cycleId, reportKey, accountId, latestDataDate = null, rowCount = null, payloadBytes = null, snapshotParamsHash = null, durationMs = null }, { signal = null } = {}) {
  await patchSyncReportJob(cycleId, reportKey, accountId, {
    fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true,
    latest_data_date: latestDataDate, row_count: rowCount, payload_bytes: payloadBytes,
    snapshot_params_hash: snapshotParamsHash, last_good_snapshot_at: new Date().toISOString(),
    succeeded_at: new Date().toISOString(), error_stage: null, error_code: null, error_message: null,
  }, { signal });
}

/* Round-7 finding 1 -- DURABLE report-derive LEASE + guarded recovery (20260822_report_derive_lease.sql,
 * PREPARED-UNAPPLIED). The source-first report lineage uses these instead of the bare pending->running PATCH
 * so a commitUnknown mid-derive is RECOVERABLE (a fresh invocation safely tells pending / running-held /
 * running-stale / complete apart, reclaims an abandoned lease without stealing a live one, and reconciles to
 * success from the EXACT durable snapshot -- zero DataDoe, no fabricated success). Both validate the RPC's
 * jsonb disposition strictly; an unknown/malformed acknowledgement throws typed (fail closed). */
const CLAIM_LEASE_DISPOSITIONS = new Set(["claimed", "reclaimed", "held", "already-complete", "terminal", "invalid-state", "not-found", "invalid-lease"]);
const RECONCILE_DISPOSITIONS = new Set(["reconciled", "already-complete", "snapshot-absent", "lease-lost", "terminal", "invalid-state", "not-running", "not-found", "invalid-hash", "invalid-lease"]);
// A lease token is a Postgres uuid text (gen_random_uuid); the harness models it as "lease_<n>".
const isNonblankString = (v) => typeof v === "string" && v.trim().length > 0;

// Round-8 finding 4: a STRICT, disposition-dependent acknowledgement validator. The RPC returns exactly one
// jsonb object; a null / multi-row / non-object / unknown-disposition / field-incoherent acknowledgement
// fails closed (never coerced into a usable lease). Returns the typed result only on a coherent ack.
function throwAckInvalid(fn, code, value, reason) {
  const err = new Error(`${code}: ${fn} returned ${JSON.stringify(value)} -- ${reason} (fail closed).`);
  err.code = code; err.status = 503; throw err;
}

export async function claimReportDeriveLease(cycleId, reportKey, accountId, { leaseSeconds, signal = null } = {}) {
  const body = await request("/rest/v1/rpc/claim_report_derive_lease", {
    method: "POST",
    signal,
    body: { p_cycle_id: cycleId, p_report_key: reportKey, p_account_id: accountId, p_lease_seconds: leaseSeconds },
  });
  if (Array.isArray(body) && body.length !== 1) {
    throwAckInvalid("claim_report_derive_lease", "REPORT_LEASE_ACK_INVALID", body, `expected exactly one row (got ${body.length})`);
  }
  const value = Array.isArray(body) ? body[0] : body;
  const disposition = value && typeof value === "object" && !Array.isArray(value) ? value.disposition : null;
  if (typeof disposition !== "string" || !CLAIM_LEASE_DISPOSITIONS.has(disposition)) {
    throwAckInvalid("claim_report_derive_lease", "REPORT_LEASE_ACK_INVALID", value, "disposition not in the known set");
  }
  const leaseToken = typeof value.lease_token === "string" ? value.lease_token : null;
  const snapshotParamsHash = typeof value.snapshot_params_hash === "string" ? value.snapshot_params_hash : null;
  // Disposition-dependent field exactness: claimed/reclaimed MUST carry a nonblank lease token.
  if ((disposition === "claimed" || disposition === "reclaimed") && !isNonblankString(leaseToken)) {
    throwAckInvalid("claim_report_derive_lease", "REPORT_LEASE_ACK_INVALID", value, `disposition '${disposition}' without a nonblank lease_token`);
  }
  // A non-claiming disposition must NEVER carry a lease token (a token there would be contradictory).
  if (disposition !== "claimed" && disposition !== "reclaimed" && leaseToken != null) {
    throwAckInvalid("claim_report_derive_lease", "REPORT_LEASE_ACK_INVALID", value, `disposition '${disposition}' unexpectedly carries a lease_token`);
  }
  // Round-9 finding 1: an 'already-complete' acknowledgement MUST carry a nonblank snapshot_params_hash so the
  // runtime can bind the observed completion to its CURRENT derivation (never a hash-less false completion).
  if (disposition === "already-complete" && !isNonblankString(snapshotParamsHash)) {
    throwAckInvalid("claim_report_derive_lease", "REPORT_LEASE_ACK_INVALID", value, "'already-complete' without a nonblank snapshot_params_hash");
  }
  return { disposition, leaseToken, snapshotParamsHash, deriveStatus: typeof value.derive_status === "string" ? value.derive_status : null };
}

export async function reconcileReportDeriveSuccess({ cycleId, reportKey, accountId, snapshotParamsHash, leaseToken, latestDataDate = null }, { signal = null } = {}) {
  const body = await request("/rest/v1/rpc/reconcile_report_derive_success", {
    method: "POST",
    signal,
    body: {
      p_cycle_id: cycleId, p_report_key: reportKey, p_account_id: accountId,
      p_snapshot_params_hash: snapshotParamsHash, p_lease_token: leaseToken, p_latest_data_date: latestDataDate,
    },
  });
  if (Array.isArray(body) && body.length !== 1) {
    throwAckInvalid("reconcile_report_derive_success", "REPORT_RECONCILE_ACK_INVALID", body, `expected exactly one row (got ${body.length})`);
  }
  const value = Array.isArray(body) ? body[0] : body;
  const disposition = value && typeof value === "object" && !Array.isArray(value) ? value.disposition : null;
  if (typeof disposition !== "string" || !RECONCILE_DISPOSITIONS.has(disposition)) {
    throwAckInvalid("reconcile_report_derive_success", "REPORT_RECONCILE_ACK_INVALID", value, "disposition not in the known set");
  }
  // Round-9 finding 1: disposition-dependent field exactness -- BOTH 'reconciled' AND 'already-complete' MUST
  // echo the exact snapshot_params_hash the caller committed/observed (an idempotent already-complete binds
  // the observed success to THIS derivation's hash; anything else is a false completion).
  if ((disposition === "reconciled" || disposition === "already-complete") && value.snapshot_params_hash !== snapshotParamsHash) {
    throwAckInvalid("reconcile_report_derive_success", "REPORT_RECONCILE_ACK_INVALID", value, `'${disposition}' did not echo the exact snapshot_params_hash`);
  }
  return { disposition };
}

/**
 * Gate-7 publisher read: the LATEST sync_report_jobs row for one exact (report_key, account_id) with the
 * fields the publisher's success gate REQUIRES bound together -- cycle_id, validated, snapshot_params_hash,
 * derive/save status -- plus the OWNING cycle's status via the cycle_id FK embed (so "terminal cycle" is
 * proven against the exact cycle this job ran in, never a different cycle). Returns a TYPED flat row or null.
 */
export async function getLatestSyncReportJob(reportKey, accountId) {
  const query = new URLSearchParams({
    select: "cycle_id,report_key,account_id,derive_status,save_status,validated,snapshot_params_hash,created_at,sync_cycles(status)",
    report_key: `eq.${reportKey}`,
    account_id: `eq.${accountId}`,
    order: "created_at.desc",
    limit: "1",
  });
  const rows = await request(`/rest/v1/sync_report_jobs?${query}`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const cycle = Array.isArray(row.sync_cycles) ? row.sync_cycles[0] : row.sync_cycles;
  return {
    cycle_id: row.cycle_id,
    report_key: row.report_key,
    account_id: row.account_id,
    derive_status: row.derive_status,
    save_status: row.save_status,
    validated: row.validated === true,
    snapshot_params_hash: row.snapshot_params_hash ?? null,
    cycle_status: cycle && typeof cycle === "object" ? (cycle.status ?? null) : null,
  };
}

// OLI reconciler read (revision comparison): the LATEST sync_report_jobs row for one exact (report_key, account_id)
// with its lineage `depends_on` (the source request hashes the currently-promoted live snapshot was derived from),
// plus validated + snapshot_params_hash + latest_data_date. Read-only; returns a typed flat row or null. Used to
// detect a SAME-AS-OF but content-CORRECTED OLI export: the current durable OLI provenance hashes are compared
// against this depends_on -- a hash not present here means the OLI advanced and the live snapshot is stale.
export async function getLatestReportJobLineage(reportKey, accountId, { signal = null } = {}) {
  // durable_content_deps (migration 20260925, PREPARED-UNAPPLIED) records per-source CONTENT provenance (e.g. the FBA
  // snapshot's payload_sha) that a DATE-addressed depends_on hash cannot represent. FAIL-SOFT: select it, and if the
  // column is absent (migration not yet applied) retry WITHOUT it -> durableContentDeps degrades to [] (the
  // pre-migration behaviour, exactly like ads_sync_state.content_rev / migration 20260923).
  const baseSelect = "cycle_id,report_key,account_id,derive_status,save_status,validated,depends_on,snapshot_params_hash,latest_data_date,created_at,sync_cycles(status)";
  const fetchRows = (withContentDeps) => {
    const query = new URLSearchParams({
      select: withContentDeps ? baseSelect + ",durable_content_deps" : baseSelect,
      report_key: `eq.${reportKey}`,
      account_id: `eq.${accountId}`,
      order: "created_at.desc",
      limit: "1",
    });
    return request(`/rest/v1/sync_report_jobs?${query}`, { signal });
  };
  let rows;
  try { rows = await fetchRows(true); }
  catch (e) { if (isSchemaMissingError(e)) rows = await fetchRows(false); else throw e; }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const cycle = Array.isArray(row.sync_cycles) ? row.sync_cycles[0] : row.sync_cycles;
  return {
    reportKey: row.report_key,
    accountId: row.account_id,
    deriveStatus: row.derive_status ?? null,
    saveStatus: row.save_status ?? null,
    validated: row.validated === true,
    dependsOn: Array.isArray(row.depends_on) ? row.depends_on.map((h) => String(h)) : [],
    durableContentDeps: Array.isArray(row.durable_content_deps) ? row.durable_content_deps.map((h) => String(h)) : [],
    snapshotParamsHash: row.snapshot_params_hash ?? null,
    latestDataDate: row.latest_data_date ?? null,
    cycleStatus: cycle && typeof cycle === "object" ? (cycle.status ?? null) : null,
  };
}

// Gate-7 publisher hydration: a report snapshot whose payload was offloaded to Storage is read back through
// this ONE trusted loader (same private bucket as every dashboard snapshot object). Returns the parsed JSON
// payload, or null when the object is absent; throws on a transport failure -- the publisher fails closed on
// BOTH (live last-known-good is preserved).
export async function getReportSnapshotStoragePayload(objectPath, { signal = null } = {}) {
  return getPrivateStorageJson(SOURCE_CACHE_BUCKET, objectPath, { signal });
}

// Injected adapters for the ATOMIC source-cache save (lib/server/sync/source-cache.js):
// Storage put/get/delete on the private source-cache bucket, and the source_export_cache
// pointer read/write. Kept as adapters so the atomic algorithm stays offline-testable.
export function sourceCacheStorageAdapter({ signal = null } = {}) {
  return {
    put: (objectPath, contents) => putPrivateStorageObject(SOURCE_CACHE_BUCKET, objectPath, contents, "application/json", { signal }),
    get: (objectPath) => getPrivateStorageJson(SOURCE_CACHE_BUCKET, objectPath, { signal }),
    delete: (objectPath) => deletePrivateStorageObjects(SOURCE_CACHE_BUCKET, [objectPath], { signal }),
  };
}

export function sourceCacheMetadataAdapter({ signal = null } = {}) {
  return {
    read: async (requestHash) => {
      const query = new URLSearchParams({ select: "request_hash,object_path", request_hash: `eq.${requestHash}`, limit: "1" });
      const rows = await request(`/rest/v1/source_export_cache?${query}`, { signal });
      return rows[0] || null;
    },
    write: async (entry) => {
      const saved = await request("/rest/v1/source_export_cache?on_conflict=request_hash", {
        method: "POST",
        signal,
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: {
          request_hash: entry.requestHash,
          source_id: entry.sourceId,
          organization_fingerprint: entry.organizationFingerprint,
          account_scope_hash: entry.accountScopeHash,
          request_meta: entry.requestMeta,
          object_path: entry.objectPath,
          row_count: entry.rowCount,
          payload_bytes: entry.payloadBytes,
          fetched_at: new Date().toISOString(),
          expires_at: entry.expiresAt,
        },
      });
      return saved[0] || null;
    },
  };
}

export async function getReportSnapshotsMeta({ reportKeys, accountIds } = {}) {
  const params = new URLSearchParams({
    select: "report_key,account_id,params,source_refreshed_at,updated_at,payload_bytes",
    order: "updated_at.desc",
  });
  if (reportKeys && reportKeys.length) params.set("report_key", `in.(${reportKeys.map((k) => `"${k}"`).join(",")})`);
  if (accountIds && accountIds.length) params.set("account_id", `in.(${accountIds.map((id) => `"${id}"`).join(",")})`);
  return request(`/rest/v1/report_snapshots?${params}`);
}

/**
 * Retention: delete snapshots for one report_key older than a cutoff. Keeps the
 * newest rows (which are always more recent than the cutoff). Best-effort.
 */
export async function deleteReportSnapshotsOlderThan({ reportKey, cutoffIso }) {
  const params = new URLSearchParams({
    report_key: `eq.${reportKey}`,
    updated_at: `lt.${cutoffIso}`,
  });
  await request(`/rest/v1/report_snapshots?${params}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  }).catch(() => {});
}

// Documented safety bounds for one Daily Ads window read.
export const AD_DAILY_METRICS_PAGE_SIZE = 1000;      // PostgREST returns at most 1,000 rows per page
export const AD_DAILY_METRICS_MAX_ROWS = 200000;     // hard ceiling; exceeding it BLOCKS Ads derivation

// True ONLY for EXPLICIT evidence that a relation/table is not present (an unapplied shadow
// migration) -- so a shadow-only table degrades to a typed "unavailable" while every other failure
// stays a visible read/write failure. Recognizes: the PostgREST missing-table code (PGRST205), the
// Postgres undefined-table code (42P01), the exact "Could not find the table ... in the schema
// cache" message, or the Postgres 'relation "..." does not exist' message. A bare HTTP status
// (including a generic/proxy/path 404), 401/403/5xx, and network failures are NOT schema-missing.
// Inspects only the request helper's SAFE structured code + error text; never a secret.
export function isSchemaMissingError(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  if (code === "PGRST205" || code === "42P01") return true;
  const message = error && error.message ? String(error.message) : String(error || "");
  return /\bPGRST205\b/.test(message)
    || /\b42P01\b/.test(message)
    || /Could not find the table\b[\s\S]*\bschema cache\b/i.test(message)
    || /relation "[^"]+" does not exist/i.test(message);
}

// A PostgREST RPC signature-not-found error (PGRST202): the named function with the SUPPLIED argument set is not in
// the schema cache -- e.g. calling the 9-arg replace_oli_dimensional_window (with p_unit_rows) before its migration
// is applied. Distinct from a missing TABLE (isSchemaMissingError). Used to fall back to a compatible older signature.
export function isFunctionSignatureMissingError(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  if (code === "PGRST202") return true;
  const message = error && error.message ? String(error.message) : String(error || "");
  return /\bPGRST202\b/.test(message)
    || /Could not find the function\b[\s\S]*\bschema cache\b/i.test(message);
}

// Quote a text value for a PostgREST filter (dates need no quoting; text with reserved chars does).
function pgrstQuote(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

/**
 * Deterministic KEYSET pagination over ad_daily_metrics' full primary key
 * (metric_date, campaign_id, campaign_type, currency), which is a strict TOTAL order, so no row is
 * skipped or duplicated across pages. `fetchPage(cursor|null)` returns one ordered page. A per-key
 * dedup set guards page-boundary re-reads (the PK is unique, so a dedup is never data loss). A
 * non-array page is an ambiguous read (throws). Exceeding `maxRows` throws ADS_ROW_LIMIT_EXCEEDED so
 * the caller blocks Ads derivation rather than aggregating a partial (understated) total. Pure given
 * `fetchPage`, so it is unit-testable without Supabase.
 */
export async function paginateAdDailyMetrics({ fetchPage, pageSize = AD_DAILY_METRICS_PAGE_SIZE, maxRows = AD_DAILY_METRICS_MAX_ROWS }) {
  const rows = [];
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const page = await fetchPage(cursor);
    if (!Array.isArray(page)) {
      const err = new Error("ad_daily_metrics returned a non-array page; refusing an ambiguous read.");
      err.code = "ADS_READ_AMBIGUOUS";
      throw err;
    }
    for (const row of page) {
      const key = `${row.metric_date}|${row.campaign_id}|${row.campaign_type}|${row.currency}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      if (rows.length > maxRows) {
        const err = new Error(`ad_daily_metrics window exceeds the ${maxRows}-row safety limit; refusing a partial Ads total.`);
        err.code = "ADS_ROW_LIMIT_EXCEEDED";
        throw err;
      }
    }
    if (page.length < pageSize) break; // a short page is the last page
    const last = page[page.length - 1];
    cursor = { metric_date: last.metric_date, campaign_id: last.campaign_id, campaign_type: last.campaign_type, currency: last.currency };
  }
  return rows;
}

/**
 * Status-aware retention support: list snapshots for one report_key older than a
 * cutoff, returning enough to decide per-row (payload carries the action status).
 * Read-only; the caller filters by status and deletes exact rows.
 */
export async function getReportSnapshotsOlderThan({ reportKey, cutoffIso }) {
  const params = new URLSearchParams({
    select: "report_key,account_id,params_hash,params,payload,updated_at",
    report_key: `eq.${reportKey}`,
    updated_at: `lt.${cutoffIso}`,
  });
  return request(`/rest/v1/report_snapshots?${params}`);
}

/**
 * Delete exactly ONE snapshot row by its natural key. Used by status-aware retention so
 * an active record is never removed by a report-key-wide age deletion.
 *
 * CONTRACT: reports success ACCURATELY -- it resolves `true` only when the DELETE request
 * itself succeeded (a matched-and-removed row OR an already-absent row, which PostgREST
 * treats as a 2xx idempotent no-op), and THROWS on any transport/HTTP failure. It does NOT
 * swallow errors: the caller (retention) owns the best-effort decision, so it can positively
 * confirm each deletion and, on failure, keep the manifest for the next pass to retry.
 */
export async function deleteReportSnapshotByKey({ reportKey, accountId, paramsHash }) {
  const params = new URLSearchParams({
    report_key: `eq.${reportKey}`,
    account_id: `eq.${accountId}`,
    params_hash: `eq.${paramsHash}`,
  });
  await request(`/rest/v1/report_snapshots?${params}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  return true;
}

/**
 * THE shared optimistic-revision invariant, used at every rev boundary (the manifest
 * orchestrator, retention, and the CAS helper below): a POSITIVE SAFE integer whose increment
 * is ALSO a safe integer (so rev + 1 can never overflow Number's safe range or, worse, be a
 * string that "increments" by concatenation). Rejects missing, zero, negative, fractional,
 * string, NaN/null, MAX_SAFE_INTEGER, and otherwise-unsafe revisions.
 */
export function isSafeSnapshotRev(value) {
  return Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(value + 1);
}

/**
 * Optimistic-concurrency (CAS) update of ONE snapshot row's payload, conditional on the
 * stored optimistic version `payload->>rev`. The WHERE includes the expected rev, so the
 * UPDATE is a single atomic statement: exactly one of two concurrent writers whose expected
 * rev matches the stored row wins; the other matches zero rows. Returns `true` when a row was
 * updated (CAS won), `false` when zero rows matched (CAS lost -- a concurrent write moved the
 * row on). THROWS on transport failure so the caller can distinguish "lost the race" from
 * "could not reach the store".
 *
 * FAIL-CLOSED BEFORE ANY HTTP REQUEST: `expectedRev` must satisfy the shared revision
 * invariant, and `payload.rev` must equal `expectedRev + 1`. A malformed expectedRev or a
 * payload whose rev is not the exact increment THROWS without issuing a fetch, so a corrupt
 * revision can never reach the database (e.g. a string "1" concatenating to "11").
 */
export async function casUpdateReportSnapshotByRev({ reportKey, accountId, paramsHash, expectedRev, payload, sourceRefreshedAt }) {
  if (!isSafeSnapshotRev(expectedRev)) {
    throw new Error("casUpdateReportSnapshotByRev: expectedRev must be a positive safe integer whose increment is safe.");
  }
  if (!payload || payload.rev !== expectedRev + 1) {
    throw new Error("casUpdateReportSnapshotByRev: payload.rev must equal expectedRev + 1.");
  }
  const params = new URLSearchParams({
    report_key: `eq.${reportKey}`,
    account_id: `eq.${accountId}`,
    params_hash: `eq.${paramsHash}`,
    "payload->>rev": `eq.${expectedRev}`,
  });
  const rows = await request(`/rest/v1/report_snapshots?${params}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: { payload, source_refreshed_at: sourceRefreshedAt || new Date().toISOString() },
  });
  return Array.isArray(rows) && rows.length > 0;
}

export async function getAdDailyMetrics(accountId, from, to, { signal = null } = {}) {
  const fetchPage = (cursor) => {
    const query = new URLSearchParams({
      select: "metric_date,campaign_id,campaign_type,currency,ad_sales,ad_spend,ad_clicks",
      account_id: `eq.${accountId}`,
      and: `(metric_date.gte.${from},metric_date.lte.${to})`,
      order: "metric_date.asc,campaign_id.asc,campaign_type.asc,currency.asc",
      limit: String(AD_DAILY_METRICS_PAGE_SIZE),
    });
    if (cursor) {
      const d = cursor.metric_date;
      const ci = pgrstQuote(cursor.campaign_id);
      const ct = pgrstQuote(cursor.campaign_type);
      const cu = pgrstQuote(cursor.currency);
      // Strictly-after (d,ci,ct,cu) in the composite order, ANDed with the account/window filters.
      query.set("or", `(metric_date.gt.${d},and(metric_date.eq.${d},campaign_id.gt.${ci}),and(metric_date.eq.${d},campaign_id.eq.${ci},campaign_type.gt.${ct}),and(metric_date.eq.${d},campaign_id.eq.${ci},campaign_type.eq.${ct},currency.gt.${cu}))`);
    }
    return request(`/rest/v1/ad_daily_metrics?${query}`, { signal });
  };
  return paginateAdDailyMetrics({ fetchPage });
}

/* Durable successful Ads coverage windows (ads_sync_coverage), created by the additive migration
 * supabase/migrations/20260810_ads_sync_coverage.sql. Both helpers return a TYPED outcome so an
 * unmigrated shadow schema (`schema-missing`) is distinguished from a genuine PostgREST read/write
 * failure (`read-failed` / `write-failed`) -- the loader degrades schema-missing to a typed
 * "unavailable" (Daily still saves sales), while a real failure surfaces as an operational failure in
 * the payload metadata (future Data Sync Center). Only SAFE codes are returned -- never a raw DB
 * response or secret. Coverage is proven from SUCCESSFUL sync windows, not from the first/last
 * returned metric row (a successfully-covered day can have zero ads and thus no row). */
export async function getDailyAdsCoverage(accountId, sourceKey, { signal = null } = {}) {
  let windows = [];
  let read = "ok";
  let error = null;
  try {
    const query = new URLSearchParams({
      select: "covered_from,covered_to",
      account_id: `eq.${accountId}`,
      source_key: `eq.${sourceKey}`,
      status: "eq.succeeded",
      order: "covered_from.asc",
    });
    const rows = await request(`/rest/v1/ads_sync_coverage?${query}`, { signal });
    windows = (rows || []).map((row) => ({ from: row.covered_from, to: row.covered_to }));
  } catch (readError) {
    read = isSchemaMissingError(readError) ? "schema-missing" : "read-failed";
    error = read === "schema-missing" ? "COVERAGE_SCHEMA_MISSING" : "COVERAGE_READ_FAILED";
    windows = [];
  }
  let status = "missing";
  let latestMetricDate = null;
  let contentRev = null;
  const readState = async (withContentRev) => {
    const query = new URLSearchParams({
      select: withContentRev ? "last_status,latest_metric_date,content_rev" : "last_status,latest_metric_date",
      account_id: `eq.${accountId}`,
      source_key: `eq.${sourceKey}`,
      limit: "1",
    });
    return request(`/rest/v1/ads_sync_state?${query}`);
  };
  try {
    let state;
    try {
      // Item 2: fold the durable CONTENT revision so a same-window Ads correction flips the Brand View fingerprint.
      state = await readState(adsContentRevColumnSupported);
    } catch (colError) {
      // Fail-soft: the ONLY tolerated degradation is a missing content_rev column (migration 20260923 pending).
      // Retry WITHOUT it once and memoize; any other error falls through to the operational-failure handler below.
      if (adsContentRevColumnSupported && isUnknownContentRevColumnError(colError)) {
        adsContentRevColumnSupported = false;
        state = await readState(false);
      } else {
        throw colError;
      }
    }
    if (state && state[0]) {
      status = state[0].last_status || "missing";
      latestMetricDate = state[0].latest_metric_date || null;
      contentRev = state[0].content_rev || null;
    }
  } catch (stateError) {
    // ads_sync_state is migrated (20260729); a failure here is operational, not shadow-missing.
    if (read === "ok") { read = "read-failed"; error = "COVERAGE_READ_FAILED"; }
  }
  return { windows, status, latestMetricDate, contentRev, read, error };
}

export async function recordAdsCoverageWindows(rows) {
  const payload = (rows || [])
    .filter((row) => row && row.accountId && row.sourceKey && row.coveredFrom && row.coveredTo)
    .map((row) => ({
      account_id: row.accountId,
      source_key: row.sourceKey,
      covered_from: row.coveredFrom,
      covered_to: row.coveredTo,
      status: "succeeded",
      source_refreshed_at: row.sourceRefreshedAt || new Date().toISOString(),
    }));
  if (!payload.length) return { write: "ok", recorded: 0, error: null };
  try {
    await request("/rest/v1/ads_sync_coverage?on_conflict=account_id,source_key,covered_from,covered_to", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: payload,
    });
    return { write: "ok", recorded: payload.length, error: null };
  } catch (writeError) {
    // Schema-missing pre-rollout is a safe no-op; a real write failure is a typed operational failure
    // (never throws here, so the Ads sync batch is not broken; the caller may surface the outcome).
    if (isSchemaMissingError(writeError)) return { write: "schema-missing", recorded: 0, error: "COVERAGE_SCHEMA_MISSING" };
    return { write: "write-failed", recorded: 0, error: "COVERAGE_WRITE_FAILED" };
  }
}

/**
 * Gate-7 DURABLE ACCOUNT ROLLOUT state (20260816_account_rollout.sql -- PREPARED). Typed + FAIL-CLOSED:
 *   { read: "ok"|"schema-missing"|"read-failed"|"noncanonical-id", allPrimary: boolean, enabledAccountIds: string[] }
 * A non-"ok" read MUST select zero accounts (the resolver enforces it); default durable state (no rows,
 * all_primary=false) also selects zero. The enabled ids are returned EXACTLY as stored -- NEVER trimmed: a
 * durable id must already be canonical (Migration 6 enforces account_id = btrim(account_id) + nonblank), so a
 * NONCANONICAL id here (leading/trailing whitespace or blank) means the integrity constraint is absent or was
 * bypassed. Rather than silently trim it into a DIFFERENT account, the whole read fails closed
 * ("noncanonical-id" => zero accounts). Never throws; never returns a partial/guessed state as "ok".
 */
export async function getSchedulerAccountRollout({ signal = null } = {}) {
  try {
    const modeRows = await request("/rest/v1/scheduler_rollout_mode?select=all_primary&id=eq.1", { signal });
    const allowRows = await request("/rest/v1/scheduler_account_rollout?select=account_id&enabled=eq.true&order=account_id.asc", { signal });
    const allPrimary = !!(modeRows && modeRows[0] && modeRows[0].all_primary === true);
    const rawIds = (allowRows || []).map((r) => (r && typeof r.account_id === "string" ? r.account_id : ""));
    // Fail closed on a NONCANONICAL durable id (never silently trim it into another account).
    const noncanonical = rawIds.some((v) => v !== v.trim() || v.trim().length === 0);
    if (noncanonical) return { read: "noncanonical-id", allPrimary: false, enabledAccountIds: [] };
    return { read: "ok", allPrimary, enabledAccountIds: rawIds };
  } catch (error) {
    return {
      read: isSchemaMissingError(error) ? "schema-missing" : "read-failed",
      allPrimary: false,
      enabledAccountIds: [],
    };
  }
}

/**
 * Gate-7 durable PUBLISH approval for one exact (report_key, account_id). Typed + fail-closed:
 *   { read: "ok"|"schema-missing"|"read-failed", approved: boolean }
 * Absent row / non-"ok" read => approved:false. Never throws.
 */
export async function getSchedulerPublishApproval(reportKey, accountId) {
  try {
    const query = new URLSearchParams({
      select: "approved",
      report_key: `eq.${reportKey}`,
      account_id: `eq.${accountId}`,
      limit: "1",
    });
    const rows = await request(`/rest/v1/scheduler_publish_approvals?${query}`);
    return { read: "ok", approved: !!(rows && rows[0] && rows[0].approved === true) };
  } catch (error) {
    return { read: isSchemaMissingError(error) ? "schema-missing" : "read-failed", approved: false };
  }
}

// Deterministic canonical JSON: recursively sort object keys so two structurally-identical values always
// stringify to the SAME string regardless of key insertion order. Used ONLY to compare a candidate snapshot
// against the existing live row at EQUAL source freshness -- the result never leaves this module (only a
// typed outcome is returned; a payload/path/digest is never handed to a caller).
function canonicalJsonString(value) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(sortDeep(value));
}

// Round-10 blocker 1: a CHRONOLOGICAL instant comparison. Parse an RFC3339 timestamp to epoch milliseconds so
// two EQUIVALENT instants that are written differently ('Z' vs '+00:00', a non-UTC offset, differing fractional
// precision) compare EQUAL, and ordering is by real time -- never a lexicographic string compare. Returns null
// for a blank/unparseable value so the caller can fail closed (an uncomparable freshness is never a win).
function instantMs(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "") return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Gate-7 shadow-to-live CAS publish primitive on the natural key (report_key, account_id, params_hash).
 * Returns ONLY a typed outcome -- never a payload, storage path, digest, or raw DB response:
 *   1. INSERT-IF-ABSENT (ignore-duplicates + representation): the row was absent => { outcome: "inserted" }.
 *   2. On conflict, READ the existing live row (params + payload + storage pointer + source_refreshed_at)
 *      and classify by SOURCE FRESHNESS, fail-closed:
 *        - live source_refreshed_at STRICTLY OLDER  => guarded PATCH (CAS-filtered on `lt`) replaces it and
 *          CLEARS payload_storage_path (inline payload wins) => { outcome: "replaced" };
 *        - live STRICTLY NEWER                       => { outcome: "newer-live" } (zero write);
 *        - live EQUAL freshness + canonically IDENTICAL params AND payload (the live payload is HYDRATED from
 *          storage when the row is storage-backed) => { outcome: "already-current" } (zero write);
 *        - live EQUAL freshness but DIFFERENT params/payload/storage content, OR the live payload cannot be
 *          proven identical (unreadable storage / missing content / uncomparable timestamps)
 *          => { outcome: "conflict" } (zero write, live LKG byte-identical -- an equal timestamp is NEVER an
 *          unconditional overwrite; the safe remediation is a fresh shadow cycle with NEWER source evidence).
 * Touches ONLY the one (report_key, account_id, params_hash) row -- never another account/report. Throws on
 * transport failure (the caller maps it to a typed safe disposition).
 */
export async function publishLiveSnapshotIfNewer({ reportKey, accountId, paramsHash, params, payload, payloadBytes, sourceRefreshedAt }, { signal = null } = {}) {
  const candParams = params || {};
  const candPayload = payload == null ? null : payload;
  const body = {
    report_key: reportKey,
    account_id: accountId,
    params_hash: paramsHash,
    params: candParams,
    payload: candPayload,
    payload_storage_path: null,
    payload_bytes: payloadBytes || 0,
    source_refreshed_at: sourceRefreshedAt,
  };
  // 1) INSERT-IF-ABSENT. Only inserts when the natural-key row does not yet exist.
  const inserted = await request("/rest/v1/report_snapshots?on_conflict=report_key,account_id,params_hash", {
    method: "POST",
    signal,
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body,
  });
  if (Array.isArray(inserted) && inserted.length > 0) return { outcome: "inserted" };

  // 2) The row exists: READ its full identity so the CAS decision is made on real content, never assumed.
  const readLive = async () => {
    const q = new URLSearchParams({
      select: "params,payload,payload_storage_path,source_refreshed_at",
      report_key: `eq.${reportKey}`,
      account_id: `eq.${accountId}`,
      params_hash: `eq.${paramsHash}`,
      limit: "1",
    });
    const rows = await request(`/rest/v1/report_snapshots?${q}`, { signal });
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  };
  const live = await readLive();
  if (!live) return { outcome: "conflict" }; // vanished between insert and read -> fail closed, no write

  // EQUAL-or-NEWER classifier: EQUAL freshness demands PROVEN content identity (params AND payload, the live
  // payload hydrated STORAGE-FIRST); anything unprovable is a conflict, never an overwrite. Round-10 blocker 1:
  // freshness is compared CHRONOLOGICALLY (epoch instants), never as a lexicographic RFC3339 string.
  const candMs = instantMs(sourceRefreshedAt);
  const classifyNonOlder = async (row) => {
    const liveMs = instantMs(row.source_refreshed_at);
    if (liveMs === null || candMs === null) return { outcome: "conflict" }; // uncomparable freshness -> fail closed
    if (liveMs > candMs) return { outcome: "newer-live" };
    if (liveMs !== candMs) return { outcome: "conflict" }; // strictly older reached here only via a race -> no blind write
    // EQUAL freshness: prove params AND payload are canonically identical.
    if (canonicalJsonString(row.params) !== canonicalJsonString(candParams)) return { outcome: "conflict" };
    // Round-10 blocker 2: STORAGE-FIRST identity. A nonblank payload_storage_path is AUTHORITATIVE and is
    // ALWAYS hydrated + compared -- even when an inline payload is also present (a stale inline that happens to
    // match the candidate can NEVER stand in for authoritative storage). Inline is used ONLY when the pointer
    // is blank. An unreadable/absent object -> cannot prove identity after the race -> conflict (fail closed).
    const storagePath = String(row.payload_storage_path ?? "").trim();
    let livePayload;
    if (storagePath !== "") {
      try {
        livePayload = await getReportSnapshotStoragePayload(storagePath, { signal });
      } catch (_e) {
        return { outcome: "conflict" }; // unreadable authoritative storage -> cannot prove identity -> no write
      }
    } else {
      livePayload = row.payload;
    }
    if (livePayload == null || candPayload == null) return { outcome: "conflict" };
    if (canonicalJsonString(livePayload) !== canonicalJsonString(candPayload)) return { outcome: "conflict" };
    return { outcome: "already-current" };
  };

  const liveMs = instantMs(live.source_refreshed_at);
  if (liveMs !== null && candMs !== null && liveMs < candMs) {
    // STRICTLY OLDER: guarded replacement. The `lt` filter keeps this a CAS -- if a concurrent write advanced
    // the row to >= candidate between our read and this PATCH, it matches ZERO rows and we re-classify (never
    // a blind overwrite). The inline payload wins, so payload_storage_path is cleared explicitly.
    const filter = new URLSearchParams({
      report_key: `eq.${reportKey}`,
      account_id: `eq.${accountId}`,
      params_hash: `eq.${paramsHash}`,
      source_refreshed_at: `lt.${sourceRefreshedAt}`,
    });
    const replaced = await request(`/rest/v1/report_snapshots?${filter}`, {
      method: "PATCH",
      signal,
      headers: { Prefer: "return=representation" },
      body: { params: candParams, payload: candPayload, payload_storage_path: null, payload_bytes: body.payload_bytes, source_refreshed_at: sourceRefreshedAt },
    });
    if (Array.isArray(replaced) && replaced.length > 0) return { outcome: "replaced" };
    const live2 = await readLive();
    if (!live2) return { outcome: "conflict" };
    return classifyNonOlder(live2);
  }
  return classifyNonOlder(live);
}

// Round-9 P0-A WRITE-BOUNDARY FENCED live CAS. Unlike publishLiveSnapshotIfNewer (a multi-request PostgREST CAS
// whose fence could only be checked BEFORE the request), this routes the control-plane live write through the
// ATOMIC cas_report_snapshot_if_newer_fenced RPC: the exact fence {ownerToken, generation, unexpired lease} is
// proven INSIDE THE SAME PostgreSQL transaction as the CAS write. On mismatch/expiry it returns
// { outcome: 'lease-lost' } with ZERO rows written. Otherwise the CAS semantics are IDENTICAL (inserted /
// replaced / newer-live, and EQUAL freshness resolved STORAGE-FIRST here to already-current | conflict). Every
// control-enabled (Gate-7) publisher uses THIS; a blank fence fails closed as 'lease-lost'.
export async function publishLiveSnapshotFencedIfNewer({ reportKey, accountId, paramsHash, params, payload, payloadBytes, sourceRefreshedAt, ownerToken, generation }, { signal = null } = {}) {
  const candParams = params || {};
  const candPayload = payload == null ? null : payload;
  const rpc = await request("/rest/v1/rpc/cas_report_snapshot_if_newer_fenced", {
    method: "POST",
    signal,
    body: {
      p_report_key: reportKey, p_account_id: accountId, p_params_hash: paramsHash,
      p_params: candParams, p_payload: candPayload, p_payload_storage_path: null,
      p_payload_bytes: payloadBytes || 0, p_source_refreshed_at: sourceRefreshedAt ?? null,
      p_owner_token: ownerToken ?? "", p_generation: generation == null ? null : Number(generation),
    },
  });
  const value = Array.isArray(rpc) ? rpc[0] : rpc;
  const disposition = value && typeof value === "object" && !Array.isArray(value) ? value.disposition : null;
  // FENCE LOST at the write boundary -> zero rows written; the caller stops and returns typed contention.
  if (disposition === "lease-lost") return { outcome: "lease-lost", reason: value && value.reason };
  if (disposition === "inserted" || disposition === "replaced" || disposition === "newer-live") return { outcome: disposition };
  if (disposition !== "equal") return { outcome: "conflict" }; // invalid-freshness / vanished / cas-miss / unknown
  // EQUAL freshness: STORAGE-FIRST content-identity proof (identical to the shadow path).
  if (canonicalJsonString(value.params) !== canonicalJsonString(candParams)) return { outcome: "conflict" };
  const storagePath = typeof value.payload_storage_path === "string" ? value.payload_storage_path.trim() : "";
  let livePayload;
  if (storagePath !== "") {
    try { livePayload = await getReportSnapshotStoragePayload(storagePath, { signal }); }
    catch (_e) { return { outcome: "conflict" }; }
  } else { livePayload = value.payload; }
  if (livePayload == null || candPayload == null) return { outcome: "conflict" };
  if (canonicalJsonString(livePayload) !== canonicalJsonString(candPayload)) return { outcome: "conflict" };
  return { outcome: "already-current" };
}

// Round-9 finding 4 + round-10 blockers 1/2: the reviewed atomic freshness/CAS for a SHADOW report_snapshots
// row (scheduler-v2/<reportKey>). Round-10 routes the freshness decision + guarded write through the atomic,
// row-locked cas_report_snapshot_if_newer RPC so the comparison is CHRONOLOGICAL and DATABASE-safe (timestamptz;
// Z == +00:00 == fractional) rather than a lexicographic RFC3339 string compare, and so concurrent writers
// serialize on the exact row under FOR UPDATE. The RPC owns insert-if-absent / strictly-newer replace /
// strictly-older 'newer-live'. On EQUAL freshness the RPC returns the durable content and THIS wrapper proves
// content identity STORAGE-FIRST: a nonblank payload_storage_path is AUTHORITATIVE and is always hydrated (even
// when an inline payload is also present); if the authoritative content cannot be proven byte-identical (a race
// swapped it, a dangling/unreadable object, a params/payload mismatch) it fails closed as 'conflict' -- the
// durable last-known-good is never overwritten and success is never reconciled off an unprovable adoption.
// Returns ONLY a typed { outcome } (inserted | replaced | newer-live | already-current | conflict).
export async function saveShadowSnapshotIfNewer({ reportKey, accountId, paramsHash, params, payload, payloadBytes, payloadStoragePath = null, sourceRefreshedAt }, { signal = null } = {}) {
  const rpc = await request("/rest/v1/rpc/cas_report_snapshot_if_newer", {
    method: "POST",
    signal,
    body: {
      p_report_key: reportKey, p_account_id: accountId, p_params_hash: paramsHash,
      p_params: params || {}, p_payload: payload == null ? null : payload,
      p_payload_storage_path: payloadStoragePath || null,
      p_payload_bytes: payloadBytes || 0, p_source_refreshed_at: sourceRefreshedAt ?? null,
    },
  });
  const value = Array.isArray(rpc) ? rpc[0] : rpc;
  const disposition = value && typeof value === "object" && !Array.isArray(value) ? value.disposition : null;
  if (disposition === "inserted" || disposition === "replaced" || disposition === "newer-live") {
    return { outcome: disposition };
  }
  // A refused / vanished / unknown acknowledgement is a fail-closed conflict (the durable LKG is untouched).
  if (disposition !== "equal") return { outcome: "conflict" };
  // EQUAL freshness: STORAGE-FIRST content-identity proof. Prove params first, then the AUTHORITATIVE payload.
  if (canonicalJsonString(value.params) !== canonicalJsonString(params || {})) return { outcome: "conflict" };
  const storagePath = typeof value.payload_storage_path === "string" ? value.payload_storage_path.trim() : "";
  let livePayload;
  if (storagePath !== "") {
    try {
      livePayload = await getReportSnapshotStoragePayload(storagePath, { signal });
    } catch (_e) {
      return { outcome: "conflict" }; // authoritative storage unreadable after the race -> fail closed
    }
  } else {
    livePayload = value.payload;
  }
  const candPayload = payload == null ? null : payload;
  if (livePayload == null || candPayload == null) return { outcome: "conflict" };
  if (canonicalJsonString(livePayload) !== canonicalJsonString(candPayload)) return { outcome: "conflict" };
  return { outcome: "already-current" };
}

// Hard budget for one PPC read. PostgREST returns at most 1,000 rows per
// request, so this pages. If an account's window genuinely exceeds the budget
// the caller throws rather than aggregating a partial window, because a
// truncated spend total would understate waste.
const ADS_ROW_PAGE_SIZE = 1000;

/**
 * Read persisted Amazon Ads rows for one account.
 *
 * This is the PPC report's only Ads source: the scheduled worker owns the
 * DataDoe exports, so opening or refreshing PPC never spends an Ads export.
 */
export async function getAdsDailySourceRows({ accountId, sourceKeys, from, to, maxRows, signal = null }) {
  const rows = [];
  for (let offset = 0; ; offset += ADS_ROW_PAGE_SIZE) {
    const query = new URLSearchParams({
      // account_id is SELECTed (not just filtered) so the PPC loader can prove row-level account
      // isolation fail-closed -- an injected/mis-scoped reader that leaks another account's rows is
      // rejected by validatePpcAdsRows before any currency gating or folding, never trusted from the
      // PostgREST filter alone. dimension_key + updated_at are SELECTed so a consumer can deduplicate by
      // the natural grain (account, marketplace, date, dimension_key), last-write-wins on updated_at.
      select: "account_id,source_key,metric_date,marketplace_country_code,dimension_key,campaign_id,campaign_type,child_asin,targeting_id,currency,dimensions,metrics,source_refreshed_at,updated_at",
      account_id: `eq.${accountId}`,
      source_key: `in.(${sourceKeys.join(",")})`,
      and: `(metric_date.gte.${from},metric_date.lte.${to})`,
      // A date alone is not deterministic when one day has more than one
      // thousand rows. The remaining primary-key fields prevent PostgREST
      // offset pages from skipping or repeating tied same-day rows while the
      // PPC report aggregates multiple saved source types.
      order: "metric_date.asc,source_key.asc,marketplace_country_code.asc,dimension_key.asc",
      limit: String(ADS_ROW_PAGE_SIZE),
      offset: String(offset),
    });
    const page = await request(`/rest/v1/ads_daily_source_rows?${query}`, signal ? { signal } : undefined);
    rows.push(...page);
    if (page.length < ADS_ROW_PAGE_SIZE) break;
    if (maxRows && rows.length >= maxRows) {
      const err = new Error(`This account has more than ${maxRows.toLocaleString("en-US")} saved Amazon Ads rows in the selected window. The report was not built because aggregating a partial window would understate spend and wasted spend. Use a shorter window.`);
      err.code = "ADS_ROW_LIMIT_EXCEEDED";
      throw err;
    }
  }
  return rows;
}

// Daily Reporting's durable ASIN-Ads reader: the raw asin-performance-v1 rows for one account/window, read
// straight from ads_daily_source_rows (the SINGLE reusable Ads dataset Daily shares with Brand View + PPC).
// Signature mirrors getAdDailyMetrics (accountId, from, to, {signal}) so it drops into the same readAdMetrics
// binding; a window that overflows the hard row ceiling throws ADS_ROW_LIMIT_EXCEEDED (a typed degrade, never a
// partial total). The per-ASIN metrics live in each row's `metrics` JSONB (aggregated by the shared helper).
export async function getAsinAdsDailyRows(accountId, from, to, { signal = null } = {}) {
  return getAdsDailySourceRows({
    accountId, sourceKeys: ["asin-performance-v1"], from, to, maxRows: AD_DAILY_METRICS_MAX_ROWS, signal,
  });
}

// Daily/Brand durable CAMPAIGN-Ads reader: the raw campaign-performance-v1 rows for one account/window. Same
// signature + row-ceiling behaviour as getAsinAdsDailyRows so it drops into the same readAdMetrics binding.
export async function getCampaignAdsDailyRows(accountId, from, to, { signal = null } = {}) {
  return getAdsDailySourceRows({
    accountId, sourceKeys: ["campaign-performance-v1"], from, to, maxRows: AD_DAILY_METRICS_MAX_ROWS, signal,
  });
}

// The ACTIVE Ads durable reader after the ASIN->Campaign cutover (campaign; rollback flips to asin via
// ACTIVE_ADS_SOURCE_KEY). One binding switches every Daily/Brand/Dashboard durable ad read through the single seam.
export async function getActiveAdsDailyRows(accountId, from, to, opts = {}) {
  return ACTIVE_ADS_SOURCE_KEY === "asin-performance-v1"
    ? getAsinAdsDailyRows(accountId, from, to, opts)
    : getCampaignAdsDailyRows(accountId, from, to, opts);
}

/* ============================== EXCHANGE RATES ==============================
   The Brand View currency selector reads these rows. They are written only by
   the server-side FX service in lib/server/fx.js, never by a browser. */

export async function getLatestFxSnapshot(baseCurrency) {
  const query = new URLSearchParams({
    select: "base_currency,rate_date,provider,rates,provider_updated_at,provider_next_update_at,fetched_at,updated_at",
    base_currency: `eq.${baseCurrency}`,
    order: "fetched_at.desc",
    limit: "1",
  });
  const rows = await request(`/rest/v1/fx_rate_snapshots?${query}`);
  return rows[0] || null;
}

export async function saveFxSnapshot(snapshot) {
  const rows = await request("/rest/v1/fx_rate_snapshots?on_conflict=base_currency,rate_date,provider", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: {
      base_currency: snapshot.baseCurrency,
      rate_date: snapshot.rateDate,
      provider: snapshot.provider,
      rates: snapshot.rates,
      provider_updated_at: snapshot.providerUpdatedAt || null,
      provider_next_update_at: snapshot.providerNextUpdateAt || null,
      fetched_at: snapshot.fetchedAt || new Date().toISOString(),
    },
  });
  return rows[0] || null;
}

// Item 2 FAIL-SOFT: ads_sync_state.content_rev may not exist yet (migration 20260923 pending approval). This
// process-level memo lets the reader + writer degrade to the pre-migration shape ONCE per process when the column
// is absent, instead of failing every ads read/write. Once the column exists (fresh process post-apply) it stays true.
let adsContentRevColumnSupported = true;
function isUnknownContentRevColumnError(e) {
  const m = String((e && e.message) || e || "").toLowerCase();
  return m.includes("content_rev") || m.includes("pgrst204") || (m.includes("column") && m.includes("does not exist"));
}
const stripContentRev = (states) => states.map(({ content_rev, ...rest }) => rest);

export async function upsertAdsSyncStates(states) {
  if (!states.length) return;
  const body = adsContentRevColumnSupported ? states : stripContentRev(states);
  try {
    await request("/rest/v1/ads_sync_state?on_conflict=account_id,source_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body,
    });
  } catch (e) {
    // Fail-soft: the ONLY tolerated degradation is a missing content_rev column (pre-migration). Retry stripped
    // ONCE; any other error is re-thrown unchanged (the sync's own error handling stays byte-identical).
    if (adsContentRevColumnSupported && isUnknownContentRevColumnError(e)) {
      adsContentRevColumnSupported = false;
      await request("/rest/v1/ads_sync_state?on_conflict=account_id,source_key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: stripContentRev(states),
      });
      return;
    }
    throw e;
  }
}
