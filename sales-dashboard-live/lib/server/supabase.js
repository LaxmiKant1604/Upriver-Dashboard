// Minimal server-only Supabase REST client. It stays client-bundle-free (only server-only imports) so
// Vercel can use the credentials injected by its Supabase Marketplace integration without exposing the
// secret key in the Vite bundle. The one import below is the shared, server-only owner-identity helper,
// used to RECOMPUTE and validate sync_source_job_owners.owner_id before any write (never a secret).

import { createHash } from "node:crypto";
import { sourceJobOwnerId } from "./source-identity.js";

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
    select: "account_id",
    user_id: `eq.${user.id}`,
  });
  const permissions = await request(`/rest/v1/account_permissions?${permissionsQuery}`);
  return {
    userId: user.id,
    email: user.email || "",
    displayName: profile.display_name || user.user_metadata?.display_name || "",
    role: profile.role,
    accountIds: permissions.map((permission) => permission.account_id),
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

export async function replaceAccountPermissions(userId, accountIds) {
  const normalized = normalizeAccountIds(accountIds);
  await request(`/rest/v1/account_permissions?user_id=eq.${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  if (normalized.length) {
    await request("/rest/v1/account_permissions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: normalized.map((accountId) => ({ user_id: userId, account_id: accountId })),
    });
  }
  return normalized;
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
    select: "request_hash,source_id,organization_fingerprint,account_scope_hash,object_path,row_count,payload_bytes,fetched_at,expires_at",
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

// Read-only lookup of the ONE cycle for (bucket, cycle_date) -- the sync_cycles_bucket_date_unique constraint
// guarantees at most one. Used by the priority release's restart-safe finalize to reconstruct the cycle it must
// verify WITHOUT creating one and WITHOUT trusting an in-memory cycle id. Selects `trigger` so the finalize can
// prove the cycle was a reviewed MANUAL run. Returns the row or null.
export async function getSyncCycleByBucketDate(bucket, cycleDate, { signal = null } = {}) {
  const query = new URLSearchParams({
    select: "id,bucket,cycle_date,status,trigger,created_at,started_at,finished_at",
    bucket: `eq.${bucket}`,
    cycle_date: `eq.${cycleDate}`,
    limit: "2",
  });
  const rows = await request(`/rest/v1/sync_cycles?${query}`, { signal });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (rows.length > 1) throw new Error("getSyncCycleByBucketDate: more than one cycle for (bucket, cycle_date); failing closed.");
  return rows[0];
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
  if (!key || (bucket !== "us" && bucket !== "non-us")) {
    throw new Error("upsertSourceRunStatus requires a nonblank sourceKey and a bucket of 'us'|'non-us' (fail closed).");
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
  await request("/rest/v1/sync_report_jobs?on_conflict=cycle_id,report_key,account_id", {
    method: "POST",
    signal,
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: {
      cycle_id: job.cycleId,
      report_key: job.reportKey,
      report_version: job.reportVersion || "",
      account_id: job.accountId,
      connection_id: job.connectionId,
      bucket: job.bucket,
      depends_on: job.dependsOn || [],
    },
  });
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
  try {
    const query = new URLSearchParams({
      select: "last_status,latest_metric_date",
      account_id: `eq.${accountId}`,
      source_key: `eq.${sourceKey}`,
      limit: "1",
    });
    const state = await request(`/rest/v1/ads_sync_state?${query}`);
    if (state && state[0]) {
      status = state[0].last_status || "missing";
      latestMetricDate = state[0].latest_metric_date || null;
    }
  } catch (stateError) {
    // ads_sync_state is migrated (20260729); a failure here is operational, not shadow-missing.
    if (read === "ok") { read = "read-failed"; error = "COVERAGE_READ_FAILED"; }
  }
  return { windows, status, latestMetricDate, read, error };
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

export async function upsertAdsSyncStates(states) {
  if (!states.length) return;
  await request("/rest/v1/ads_sync_state?on_conflict=account_id,source_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: states,
  });
}
