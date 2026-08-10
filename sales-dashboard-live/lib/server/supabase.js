// Minimal server-only Supabase REST client. Keeping this dependency-free means
// Vercel can use the credentials injected by its Supabase Marketplace
// integration without exposing the secret key in the Vite bundle.

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
    throw new Error(`Supabase request failed (${response.status}): ${result?.message || result?.hint || "Unknown error"}`);
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

export async function getSyncSourceJobs(cycleId) {
  const query = new URLSearchParams({
    select: "id,request_hash,source_id,source_key,connection_id,fetch_status,attempted_at,create_export_count,export_id,terminal,error_stage,error_code,row_count",
    cycle_id: `eq.${cycleId}`,
    order: "created_at.asc",
  });
  return request(`/rest/v1/sync_source_jobs?${query}`);
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

export async function getAdDailyMetrics(accountId, from, to) {
  const query = new URLSearchParams({
    select: "metric_date,currency,ad_sales,ad_spend,ad_clicks",
    account_id: `eq.${accountId}`,
    and: `(metric_date.gte.${from},metric_date.lte.${to})`,
    order: "metric_date.asc",
  });
  return request(`/rest/v1/ad_daily_metrics?${query}`);
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
      select: "source_key,metric_date,marketplace_country_code,campaign_id,campaign_type,child_asin,targeting_id,currency,dimensions,metrics,source_refreshed_at",
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
