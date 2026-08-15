// Minimal server-only Supabase REST client. It stays client-bundle-free (only server-only imports) so
// Vercel can use the credentials injected by its Supabase Marketplace integration without exposing the
// secret key in the Vite bundle. The one import below is the shared, server-only owner-identity helper,
// used to RECOMPUTE and validate sync_source_job_owners.owner_id before any write (never a secret).

import { sourceJobOwnerId } from "./source-identity.js";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
// Vercel Marketplace projects can expose either the legacy service-role JWT or
// Supabase's newer secret key. Prefer the service-role key when both exist:
// it is accepted by every REST/Storage endpoint used by the server snapshot
// layer, while keeping the newer key as a compatible fallback.
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

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

async function request(path, { method = "GET", body, headers = {} } = {}) {
  requireConfiguration();
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

async function putPrivateStorageObject(bucket, objectPath, contents, contentType = "application/json") {
  requireConfiguration();
  const response = await fetch(storageObjectUrl(bucket, objectPath), {
    method: "POST",
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: contents,
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(`Supabase Storage upload failed (${response.status}): ${result?.message || result?.error || "Unknown error"}`);
  }
}

async function getPrivateStorageJson(bucket, objectPath) {
  requireConfiguration();
  const response = await fetch(storageObjectUrl(bucket, objectPath), {
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Supabase Storage download failed (${response.status}).`);
  return response.json();
}

async function deletePrivateStorageObjects(bucket, objectPaths) {
  if (!objectPaths.length) return;
  await request(`/storage/v1/object/${encodeURIComponent(bucket)}`, {
    method: "DELETE",
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

export async function getReportSnapshot({ reportKey, accountId, paramsHash }) {
  const query = new URLSearchParams({
    select: "id,report_key,account_id,params_hash,params,payload,payload_storage_path,payload_bytes,source_refreshed_at,updated_at",
    report_key: `eq.${reportKey}`,
    account_id: `eq.${accountId}`,
    params_hash: `eq.${paramsHash}`,
    limit: "1",
  });
  const rows = await request(`/rest/v1/report_snapshots?${query}`);
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
    select: "id,report_key,account_id,params_hash,params,payload,payload_bytes,source_refreshed_at,updated_at",
    report_key: `eq.${reportKey}`,
    account_id: `eq.${accountId}`,
    order: "updated_at.desc",
    limit: "1",
  });
  const rows = await request(`/rest/v1/report_snapshots?${query}`);
  return rows[0] || null;
}

export async function saveReportSnapshot(snapshot) {
  const rows = await request("/rest/v1/report_snapshots?on_conflict=report_key,account_id,params_hash", {
    method: "POST",
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

export async function getSourceExportCache(requestHash) {
  const query = new URLSearchParams({
    select: "request_hash,source_id,object_path,row_count,payload_bytes,fetched_at,expires_at",
    request_hash: `eq.${requestHash}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1",
  });
  const rows = await request(`/rest/v1/source_export_cache?${query}`);
  const entry = rows[0];
  if (!entry) return null;
  const payload = await getPrivateStorageJson(SOURCE_CACHE_BUCKET, entry.object_path);
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

export async function insertAuditLog({ actorUserId = null, action, target = {} }) {
  await request("/rest/v1/audit_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: { actor_user_id: actorUserId, action, target },
  }).catch(() => {});
}

export async function getReportSyncSettings() {
  return request("/rest/v1/report_sync_settings?select=report_key,schedule_enabled,updated_at&order=report_key.asc");
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

/* ===================== Scheduler v2 (Phase 1c) — source-first cycle =====================
   Thin wrappers over the three additive tables + three RPCs in
   20260807_scheduler_v2.sql. Service-role only (RLS bypassed for writes). These power
   the SHADOW-MODE source worker; they never store an API key or a raw DataDoe error. */

// open_sync_cycle: idempotent kickoff. Returns the single cycle id for (bucket, date).
export async function openSyncCycle({ bucket, cycleDate, scheduledAt = null, trigger = "manual" }) {
  return request("/rest/v1/rpc/open_sync_cycle", {
    method: "POST",
    body: { p_bucket: bucket, p_cycle_date: cycleDate, p_scheduled_at: scheduledAt, p_trigger: trigger },
  });
}

// claim_sync_cycle: pending -> running; true only for the worker that won the start.
export async function claimSyncCycle(cycleId) {
  return request("/rest/v1/rpc/claim_sync_cycle", { method: "POST", body: { p_cycle_id: cycleId } });
}

export async function getSyncCycle(cycleId) {
  const query = new URLSearchParams({
    select: "id,bucket,cycle_date,status,started_at,finished_at,source_total,source_succeeded,source_failed",
    id: `eq.${cycleId}`,
    limit: "1",
  });
  const rows = await request(`/rest/v1/sync_cycles?${query}`);
  return rows[0] || null;
}

export async function updateSyncCycleCounts(cycleId, { sourceTotal, sourceSucceeded, sourceFailed, reportTotal, reportSucceeded, reportFailed, status } = {}) {
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

export async function finalizeSyncCycle(cycleId) {
  const body = await request("/rest/v1/rpc/finalize_sync_cycle", { method: "POST", body: { p_cycle_id: cycleId } });
  const result = Array.isArray(body) ? body[0] : body;
  return validateFinalizeResponse(result, cycleId);
}

// claim_source_export_attempt: the durable one-attempt guard. TRUE only for the caller
// that made the first (and only) create-export POST for this (cycle, request_hash).
export async function claimSourceExportAttempt(cycleId, requestHash) {
  return request("/rest/v1/rpc/claim_source_export_attempt", {
    method: "POST",
    body: { p_cycle_id: cycleId, p_request_hash: requestHash },
  });
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
export async function upsertSyncSourceJob(job) {
  if (job.connectionId !== "primary" && job.connectionId !== "dd-secondary") {
    throw new Error(`upsertSyncSourceJob requires an explicit connection_id of 'primary' or 'dd-secondary' (got "${job.connectionId}").`);
  }
  if (!job.organizationFingerprint) {
    throw new Error("upsertSyncSourceJob requires a non-empty organizationFingerprint; refusing to write a source job with an empty organization fingerprint.");
  }
  await request("/rest/v1/sync_source_jobs?on_conflict=cycle_id,request_hash", {
    method: "POST",
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
const SOURCE_JOB_COLUMNS = "id,request_hash,source_id,source_key,connection_id,organization_fingerprint,account_scope_hash,fetch_status,attempted_at,create_export_count,export_id,terminal,error_stage,error_code,row_count";

export async function getSyncSourceJobs(cycleId) {
  const query = new URLSearchParams({
    select: SOURCE_JOB_COLUMNS,
    cycle_id: `eq.${cycleId}`,
    order: "created_at.asc",
  });
  return request(`/rest/v1/sync_source_jobs?${query}`);
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
export async function upsertSyncSourceJobOwners(memberships) {
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
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: rows,
  });
}

// List memberships for a set of declared owner ids in one cycle (empty owner set => no rows).
export async function getSyncSourceJobOwners(cycleId, ownerIds) {
  const owners = [...new Set((ownerIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!owners.length) return [];
  const query = new URLSearchParams({
    select: SOURCE_JOB_OWNER_COLUMNS,
    cycle_id: `eq.${cycleId}`,
    owner_id: `in.(${owners.join(",")})`,
    order: "created_at.asc",
  });
  return request(`/rest/v1/sync_source_job_owners?${query}`);
}

// List the CANONICAL source jobs the declared owners depend on: their ACTIVE memberships' request_hashes,
// deduplicated, then the canonical rows for those hashes. (Powers admin report-wise / owner-scoped sync.)
export async function getSyncSourceJobsForOwners(cycleId, ownerIds) {
  const memberships = await getSyncSourceJobOwners(cycleId, ownerIds);
  const hashes = [...new Set(memberships.filter((m) => m.owner_status !== "stale").map((m) => m.request_hash))];
  if (!hashes.length) return [];
  const query = new URLSearchParams({
    select: SOURCE_JOB_COLUMNS,
    cycle_id: `eq.${cycleId}`,
    request_hash: `in.(${hashes.join(",")})`,
    order: "created_at.asc",
  });
  return request(`/rest/v1/sync_source_jobs?${query}`);
}

// Mark ONE owner's membership stale (its plan no longer needs this hash). This is owner-scoped only: it
// NEVER touches the canonical sync_source_jobs row or any other owner's membership, so a hash still owned
// by another owner remains executable/resumable/readable, and no DataDoe call is made for a stale owner.
export async function recordSyncSourceJobOwnerStale({ cycleId, requestHash, ownerId, code = "STALE_PLAN", message = null }) {
  const query = new URLSearchParams({
    cycle_id: `eq.${cycleId}`,
    request_hash: `eq.${requestHash}`,
    owner_id: `eq.${ownerId}`,
  });
  await request(`/rest/v1/sync_source_job_owners?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: { owner_status: "stale", error_code: code, error_message: message },
  });
}

async function patchSyncSourceJob(cycleId, requestHash, body) {
  const query = new URLSearchParams({ cycle_id: `eq.${cycleId}`, request_hash: `eq.${requestHash}` });
  await request(`/rest/v1/sync_source_jobs?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body,
  });
}

export async function recordSyncSourceSuccess({ cycleId, requestHash, exportId = null, rowCount, payloadBytes, durationMs, cacheObjectPath }) {
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
  });
}

// Persist the DataDoe export id IMMEDIATELY after create-export, keeping fetch_status
// 'attempted' (set by the claim RPC), so a crash after the POST resumes poll/download
// WITHOUT a second create-export.
export async function recordSyncSourceExportCreated({ cycleId, requestHash, exportId }) {
  await patchSyncSourceJob(cycleId, requestHash, { export_id: exportId });
}

// Failure NEVER clears cache_object_path / last_good_fetched_at, so last-known-good
// source data survives. error_message is the SAFE operator string only.
export async function recordSyncSourceFailure({ cycleId, requestHash, stage, code, message, terminal = false, durationMs, rowCount = null, exportId = null }) {
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
  });
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
export async function upsertSyncReportJob(job) {
  if (job.connectionId !== "primary" && job.connectionId !== "dd-secondary") {
    throw new Error(`upsertSyncReportJob requires an explicit connection_id of 'primary' or 'dd-secondary' (got "${job.connectionId}").`);
  }
  await request("/rest/v1/sync_report_jobs?on_conflict=cycle_id,report_key,account_id", {
    method: "POST",
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
export async function claimReportDeriveAttempt(cycleId, reportKey, accountId) {
  const query = new URLSearchParams({ cycle_id: `eq.${cycleId}`, report_key: `eq.${reportKey}`, account_id: `eq.${accountId}`, derive_status: "eq.pending" });
  const rows = await request(`/rest/v1/sync_report_jobs?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: { derive_status: "running" },
  });
  return Array.isArray(rows) && rows.length === 1;
}

async function patchSyncReportJob(cycleId, reportKey, accountId, body) {
  const query = new URLSearchParams({ cycle_id: `eq.${cycleId}`, report_key: `eq.${reportKey}`, account_id: `eq.${accountId}` });
  await request(`/rest/v1/sync_report_jobs?${query}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body });
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
export async function recordSyncReportSuccess({ cycleId, reportKey, accountId, latestDataDate = null, rowCount = null, payloadBytes = null, snapshotParamsHash = null, durationMs = null }) {
  await patchSyncReportJob(cycleId, reportKey, accountId, {
    fetch_status: "ready", derive_status: "succeeded", save_status: "succeeded", validated: true,
    latest_data_date: latestDataDate, row_count: rowCount, payload_bytes: payloadBytes,
    snapshot_params_hash: snapshotParamsHash, last_good_snapshot_at: new Date().toISOString(),
    succeeded_at: new Date().toISOString(), error_stage: null, error_code: null, error_message: null,
  });
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
export async function getReportSnapshotStoragePayload(objectPath) {
  return getPrivateStorageJson(SOURCE_CACHE_BUCKET, objectPath);
}

// Injected adapters for the ATOMIC source-cache save (lib/server/sync/source-cache.js):
// Storage put/get/delete on the private source-cache bucket, and the source_export_cache
// pointer read/write. Kept as adapters so the atomic algorithm stays offline-testable.
export function sourceCacheStorageAdapter() {
  return {
    put: (objectPath, contents) => putPrivateStorageObject(SOURCE_CACHE_BUCKET, objectPath, contents),
    get: (objectPath) => getPrivateStorageJson(SOURCE_CACHE_BUCKET, objectPath),
    delete: (objectPath) => deletePrivateStorageObjects(SOURCE_CACHE_BUCKET, [objectPath]),
  };
}

export function sourceCacheMetadataAdapter() {
  return {
    read: async (requestHash) => {
      const query = new URLSearchParams({ select: "request_hash,object_path", request_hash: `eq.${requestHash}`, limit: "1" });
      const rows = await request(`/rest/v1/source_export_cache?${query}`);
      return rows[0] || null;
    },
    write: async (entry) => {
      const saved = await request("/rest/v1/source_export_cache?on_conflict=request_hash", {
        method: "POST",
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

export async function getAdDailyMetrics(accountId, from, to) {
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
    return request(`/rest/v1/ad_daily_metrics?${query}`);
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
export async function getDailyAdsCoverage(accountId, sourceKey) {
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
    const rows = await request(`/rest/v1/ads_sync_coverage?${query}`);
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
export async function getSchedulerAccountRollout() {
  try {
    const modeRows = await request("/rest/v1/scheduler_rollout_mode?select=all_primary&id=eq.1");
    const allowRows = await request("/rest/v1/scheduler_account_rollout?select=account_id&enabled=eq.true&order=account_id.asc");
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
export async function publishLiveSnapshotIfNewer({ reportKey, accountId, paramsHash, params, payload, payloadBytes, sourceRefreshedAt }) {
  const candTs = String(sourceRefreshedAt ?? "").trim();
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
    const rows = await request(`/rest/v1/report_snapshots?${q}`);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  };
  const live = await readLive();
  if (!live) return { outcome: "conflict" }; // vanished between insert and read -> fail closed, no write

  // EQUAL-or-NEWER classifier: EQUAL freshness demands PROVEN content identity (params AND payload, the live
  // payload hydrated from storage when needed); anything unprovable is a conflict, never an overwrite.
  const classifyNonOlder = async (row) => {
    const liveTs = String(row.source_refreshed_at ?? "").trim();
    if (liveTs === "" || candTs === "") return { outcome: "conflict" }; // uncomparable freshness -> fail closed
    if (liveTs > candTs) return { outcome: "newer-live" };
    if (liveTs !== candTs) return { outcome: "conflict" }; // strictly older reached here only via a race -> no blind write
    // EQUAL freshness: prove params AND payload are canonically identical.
    if (canonicalJsonString(row.params) !== canonicalJsonString(candParams)) return { outcome: "conflict" };
    let livePayload = row.payload;
    if (livePayload == null && String(row.payload_storage_path ?? "").trim() !== "") {
      try {
        livePayload = await getReportSnapshotStoragePayload(String(row.payload_storage_path).trim());
      } catch (_e) {
        return { outcome: "conflict" }; // unreadable live storage -> cannot prove identity -> no write
      }
    }
    if (livePayload == null || candPayload == null) return { outcome: "conflict" };
    if (canonicalJsonString(livePayload) !== canonicalJsonString(candPayload)) return { outcome: "conflict" };
    return { outcome: "already-current" };
  };

  const liveTs = String(live.source_refreshed_at ?? "").trim();
  if (liveTs !== "" && candTs !== "" && liveTs < candTs) {
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
export async function getAdsDailySourceRows({ accountId, sourceKeys, from, to, maxRows }) {
  const rows = [];
  for (let offset = 0; ; offset += ADS_ROW_PAGE_SIZE) {
    const query = new URLSearchParams({
      // account_id is SELECTed (not just filtered) so the PPC loader can prove row-level account
      // isolation fail-closed -- an injected/mis-scoped reader that leaks another account's rows is
      // rejected by validatePpcAdsRows before any currency gating or folding, never trusted from the
      // PostgREST filter alone.
      select: "account_id,source_key,metric_date,marketplace_country_code,campaign_id,campaign_type,child_asin,targeting_id,currency,dimensions,metrics,source_refreshed_at",
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
    const page = await request(`/rest/v1/ads_daily_source_rows?${query}`);
    rows.push(...page);
    if (page.length < ADS_ROW_PAGE_SIZE) break;
    if (maxRows && rows.length >= maxRows) {
      throw new Error(`This account has more than ${maxRows.toLocaleString("en-US")} saved Amazon Ads rows in the selected window. The PPC report was not built because aggregating a partial window would understate spend and wasted spend. Use a shorter window.`);
    }
  }
  return rows;
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
