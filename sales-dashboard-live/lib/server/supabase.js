// Minimal server-only Supabase REST client. Keeping this dependency-free means
// Vercel can use the credentials injected by its Supabase Marketplace
// integration without exposing the secret key in the Vite bundle.

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

export function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
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

export async function getAdDailyMetrics(accountId, from, to) {
  const query = new URLSearchParams({
    select: "metric_date,currency,ad_sales,ad_spend,ad_clicks",
    account_id: `eq.${accountId}`,
    and: `(metric_date.gte.${from},metric_date.lte.${to})`,
    order: "metric_date.asc",
  });
  return request(`/rest/v1/ad_daily_metrics?${query}`);
}

export async function upsertAdsSyncStates(states) {
  if (!states.length) return;
  await request("/rest/v1/ads_sync_state?on_conflict=account_id,source_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: states,
  });
}
