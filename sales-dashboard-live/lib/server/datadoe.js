// Shared server-side DataDoe REST helpers.
//
// These were extracted verbatim in behaviour from api/datadoe.js so every
// report — existing and new — goes through one rate limiter, one export
// poller, and one row-cap policy. The DATADOE_API_KEY never leaves the server.
//
// Verified DataDoe REST details (see PROJECT_MEMORY.md):
// - Accounts endpoint includes the /util prefix.
// - Auth uses the custom `datadoe-api-key` header, not Authorization: Bearer.
// - Exports accept no more than 5 seller/vendor IDs per request.
// - Sources without a date column (Listings, Product Catalog) must not receive
//   a from/to range, and must order by a column that actually exists.

import { AsyncLocalStorage } from "node:async_hooks";
import { marketplaceProfile } from "../marketplaces.js";
import { cacheHoursForSource } from "./source-contracts.js";
// The canonical source request identity (request_hash) lives in a shared module so
// the scheduler can compute the same hash without this DataDoe/report module graph.
// Byte-identical to the previous in-file implementation: the source cache stays valid.
import { sourceRequestIdentity } from "./source-identity.js";
// Account-ID batching lives in a dependency-free leaf so the scheduler shares the
// exact 5-ID chunking. Re-exported here so existing importers of these symbols from
// this module (e.g. api/datadoe.js) keep working unchanged.
import { MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT, chunkArray, chunkAccountIds } from "./id-batching.js";
export { MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT, chunkArray, chunkAccountIds };
// Pure calendar/window helpers live in a dependency-free leaf (so the "pure" report-derivation
// graph never transitively reaches this transport/storage module). Imported for local use
// (splitDateRangeByDays needs addDaysStr) and re-exported so existing importers keep working.
import { pad2s, daysInMonthUTC, addDaysStr, splitDateRangeByMonth, isFullCalendarMonthWindow } from "./date-windows.js";
import {
  getSourceExportCache,
  isSupabaseConfigured,
  pruneSourceExportCache,
  saveSourceExportCache,
} from "./supabase.js";

export const DATADOE_BASE = "https://api.datadoe.com/api/v1";

export const ENDPOINTS = {
  sellers: `${DATADOE_BASE}/util/sellers-and-vendors`,
  exportsCreate: `${DATADOE_BASE}/exports`,
  exportStatus: (id) => `${DATADOE_BASE}/exports/${id}`,
  exportRaw: (id) => `${DATADOE_BASE}/exports/${id}/raw`,
};

// MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT now lives in ./id-batching.js (imported +
// re-exported above).

export function authHeaders(apiKey) {
  return {
    "datadoe-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

const dataDoeDeadline = new AsyncLocalStorage();
const DEADLINE_HEADROOM_MS = 750;

export class DataDoeDeadlineError extends Error {
  constructor() {
    super("DataDoe work deferred before the server execution deadline.");
    this.name = "DataDoeDeadlineError";
    this.code = "DATADOE_DEADLINE";
  }
}

export function isDataDoeDeadlineError(error) {
  return error?.code === "DATADOE_DEADLINE" || error instanceof DataDoeDeadlineError;
}

// AsyncLocalStorage lets every existing report builder inherit the scheduled
// invocation deadline without threading a new argument through every helper.
// Browser-triggered/manual routes do not call this wrapper and keep their
// existing behaviour.
export function withDataDoeDeadline(deadlineAt, callback) {
  return dataDoeDeadline.run(Number(deadlineAt), callback);
}

function remainingDeadlineMs() {
  const deadlineAt = dataDoeDeadline.getStore();
  return Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : null;
}

export const sleep = (ms) => {
  const remaining = remainingDeadlineMs();
  if (remaining !== null && remaining <= ms + DEADLINE_HEADROOM_MS) {
    return Promise.reject(new DataDoeDeadlineError());
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const num = (v) => Number(v) || 0;

// A nullable numeric read. Unlike `num`, this preserves "no value" so a report
// can render an honest em dash instead of a fabricated zero.
export function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const value = Number(v);
  return Number.isFinite(value) ? value : null;
}

// DataDoe caps requests at 2/sec per organization. `ddFetch` spaces requests
// out to stay under that cap and transparently retries on HTTP 429 using the
// server's retry hint, so a burst of exports or concurrent tabs don't surface a
// rate-limit error to the user.
let _lastDataDoeCall = 0;
const MIN_REQUEST_INTERVAL_MS = 550;
const MAX_RATE_LIMIT_RETRIES = 6;

export async function ddFetch(url, options, attempt = 0) {
  const remaining = remainingDeadlineMs();
  if (remaining !== null && remaining <= DEADLINE_HEADROOM_MS) {
    throw new DataDoeDeadlineError();
  }
  const since = Date.now() - _lastDataDoeCall;
  if (since < MIN_REQUEST_INTERVAL_MS) await sleep(MIN_REQUEST_INTERVAL_MS - since);
  _lastDataDoeCall = Date.now();

  let deadlineTimer = null;
  let deadlineController = null;
  const requestOptions = { ...options };
  const requestRemaining = remainingDeadlineMs();
  if (requestRemaining !== null && !requestOptions.signal) {
    deadlineController = new AbortController();
    requestOptions.signal = deadlineController.signal;
    deadlineTimer = setTimeout(
      () => deadlineController.abort(),
      Math.max(1, requestRemaining - DEADLINE_HEADROOM_MS),
    );
  }

  let r;
  try {
    r = await fetch(url, requestOptions);
  } catch (error) {
    if (deadlineController?.signal.aborted) throw new DataDoeDeadlineError();
    throw error;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
  if (r.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
    let retrySec = Number(r.headers.get("retry-after")) || 0;
    try {
      const body = await r.clone().json();
      retrySec = Number(body.retryAfterSeconds) || Number(body.config && body.config.retryAfterSeconds) || retrySec || 1;
    } catch (e) {
      retrySec = retrySec || 1;
    }
    await sleep(retrySec * 1000 + 250);
    return ddFetch(url, options, attempt + 1);
  }
  return r;
}

export async function fetchAccounts(apiKey) {
  const r = await ddFetch(ENDPOINTS.sellers, { headers: authHeaders(apiKey) });
  if (!r.ok) {
    throw new Error(`DataDoe accounts request failed (${r.status}). Check the endpoint path in lib/server/datadoe.js against https://api.datadoe.com/api/v1/docs`);
  }
  const body = await r.json();
  const list = body.data || body.results || (Array.isArray(body) ? body : []);
  return list.map((a) => {
    const profile = marketplaceProfile(a.marketplaceCountryCode, a.currency);
    return {
      id: a.id,
      name: a.name,
      country: profile.country,
      countryName: a.marketplaceCountryName || profile.countryName,
      currency: profile.currency,
      locale: profile.locale,
      timeZone: profile.timeZone,
    };
  });
}

export async function createExport(apiKey, sourceId, columns, sellerOrVendorIds, from, to, limit, options = {}) {
  const { groupBy, aggregations, orderByColumn = "date", orderByDirection = "ASC" } = options;
  const r = await ddFetch(ENDPOINTS.exportsCreate, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      sourceId,
      sellerOrVendorIds,
      columns,
      // Sources without a date column (e.g. Listings) must not receive a date
      // range; only include from/to when provided.
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      limit,
      outputType: "JSON",
      orderByColumn,
      orderByDirection,
      ...(groupBy ? { groupBy } : {}),
      ...(aggregations ? { aggregations } : {}),
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`DataDoe export creation failed (${r.status}): ${text}`);
  }
  return r.json();
}

export async function pollExport(apiKey, exportId) {
  // DataDoe recommends a five-second poll cadence and exports can take close
  // to 30 seconds. Keep this below Vercel's 60-second function limit: the
  // cadence sleep runs at the START of each attempt (9 x 5s = 45s of sleeps,
  // the same total budget as before -- the old loop slept AFTER each attempt,
  // including a useless final sleep), so the bound is unchanged.
  //
  // Confirmed DataDoe behaviour: a status GET issued too soon after the
  // create-export POST can return HTTP 404 before the export becomes visible.
  // So (1) always wait one 5s cadence BEFORE the first status GET, and
  // (2) treat a status-GET 404 as "not visible yet" (still pending) within
  // this SAME bounded window -- never terminal, and NEVER answered by a second
  // create-export POST (the export id is fixed; this function only ever GETs).
  // A 404 that outlives every attempt becomes the normal poll timeout
  // (non-terminal, resumable by export_id -- still no second create). Any
  // other non-OK status stays a real failure, as does a 404 on the CREATE
  // POST itself (createExport above throws on any non-OK response).
  const maxAttempts = 9;
  const delayMs = 5000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(delayMs); // cadence first: also the wait before the FIRST status GET
    const r = await ddFetch(ENDPOINTS.exportStatus(exportId), { headers: authHeaders(apiKey) });
    if (r.status === 404) continue; // export not visible yet: temporary within the bounded window
    if (!r.ok) throw new Error(`DataDoe export status check failed (${r.status})`);
    const body = await r.json();
    if (body.status === "COMPLETED") return body;
    if (["FAILED", "ERROR", "BLOCKED_NO_TOKENS"].includes(body.status)) {
      throw new Error(`DataDoe export failed to process (${body.status}).`);
    }
  }
  throw new Error("DataDoe export timed out while processing. Try a shorter date range.");
}

export async function downloadExport(apiKey, exportId) {
  const r = await ddFetch(ENDPOINTS.exportRaw(exportId), { headers: authHeaders(apiKey) });
  if (!r.ok) throw new Error(`DataDoe export download failed (${r.status})`);
  const body = await r.json();
  if (typeof body.rawContent === "string") {
    return JSON.parse(body.rawContent);
  }
  return Array.isArray(body) ? body : [];
}

// chunkArray now lives in ./id-batching.js (imported + re-exported above).

const SOURCE_CACHE_MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const SOURCE_MEMORY_CACHE_MAX = 24;
const sourceExportInflight = new Map();
const sourceMemoryCache = new Map();
let sourceCacheUnavailableUntil = 0;
let sourceCacheLastPrunedAt = 0;

// sha256 / stableValue / sourceRequestIdentity were moved verbatim to
// ./source-identity.js (imported above) so the scheduler shares one identity
// implementation. No behaviour change; request_hash values are byte-identical.

function rememberSourceRows(requestHash, rows, expiresAt) {
  sourceMemoryCache.delete(requestHash);
  sourceMemoryCache.set(requestHash, { rows, expiresAt });
  while (sourceMemoryCache.size > SOURCE_MEMORY_CACHE_MAX) {
    sourceMemoryCache.delete(sourceMemoryCache.keys().next().value);
  }
}

function memorySourceRows(requestHash) {
  const saved = sourceMemoryCache.get(requestHash);
  if (!saved) return null;
  if (saved.expiresAt <= Date.now()) {
    sourceMemoryCache.delete(requestHash);
    return null;
  }
  sourceMemoryCache.delete(requestHash);
  sourceMemoryCache.set(requestHash, saved);
  return saved.rows;
}

async function readPersistedSourceRows(requestHash) {
  if (!isSupabaseConfigured() || Date.now() < sourceCacheUnavailableUntil) return null;
  try {
    return await getSourceExportCache(requestHash);
  } catch {
    // A migration may be pending during a rolling deployment. Source caching
    // is an optimisation and must never make a report unavailable.
    sourceCacheUnavailableUntil = Date.now() + 60_000;
    return null;
  }
}

async function persistSourceRows({ identity, sourceId, rows, cacheHours }) {
  if (!isSupabaseConfigured() || Date.now() < sourceCacheUnavailableUntil) return;
  const deadlineRemaining = remainingDeadlineMs();
  if (deadlineRemaining !== null && deadlineRemaining < 3000) return;
  const serialised = JSON.stringify({ rows });
  const payloadBytes = Buffer.byteLength(serialised, "utf8");
  if (payloadBytes > SOURCE_CACHE_MAX_OBJECT_BYTES) return;
  const expiresAt = new Date(Date.now() + cacheHours * 3600_000).toISOString();
  try {
    await saveSourceExportCache({
      ...identity,
      sourceId: String(sourceId),
      rows,
      payloadBytes,
      expiresAt,
    });
    if (Date.now() - sourceCacheLastPrunedAt > 15 * 60_000) {
      sourceCacheLastPrunedAt = Date.now();
      await pruneSourceExportCache().catch(() => {});
    }
  } catch {
    sourceCacheUnavailableUntil = Date.now() + 60_000;
  }
}

async function fetchSourceChunk(apiKey, sourceId, columns, ids, from, to, limit, options) {
  const identity = sourceRequestIdentity({ apiKey, sourceId, columns, ids, from, to, limit, options });
  const cacheHours = cacheHoursForSource(sourceId);
  if (options.bypassSourceCache !== true) {
    const memoryRows = memorySourceRows(identity.requestHash);
    if (memoryRows) return memoryRows;
    const persisted = await readPersistedSourceRows(identity.requestHash);
    if (persisted?.rows) {
      const persistedExpiry = Date.parse(persisted.expires_at);
      rememberSourceRows(
        identity.requestHash,
        persisted.rows,
        Number.isFinite(persistedExpiry) ? persistedExpiry : Date.now() + cacheHours * 3600_000
      );
      return persisted.rows;
    }
  }

  const existing = sourceExportInflight.get(identity.requestHash);
  if (existing) return existing;

  const work = (async () => {
    const created = await createExport(apiKey, sourceId, columns, ids, from, to, limit, options);
    const exportId = created.exportId || created.id;
    if (created.status !== "COMPLETED") await pollExport(apiKey, exportId);
    const rows = await downloadExport(apiKey, exportId);
    const expiresAt = Date.now() + cacheHours * 3600_000;
    rememberSourceRows(identity.requestHash, rows, expiresAt);
    // A result on the cap may be truncated. Strict callers reject it; do not
    // persist it where another report could mistake it for complete data.
    if (rows.length < limit) {
      await persistSourceRows({ identity, sourceId, rows, cacheHours });
    }
    return rows;
  })();
  sourceExportInflight.set(identity.requestHash, work);
  try {
    return await work;
  } finally {
    sourceExportInflight.delete(identity.requestHash);
  }
}

// Run an export for any source, chunking by the 5-id-per-export cap and
// combining the returned rows. Every report reaches DataDoe through this
// function, so identical source requests are shared across reports and users.
// The cache key includes the organization, exact account scope, fields, grain,
// aggregations, date window, row cap and ordering; incompatible requests can
// never collide.
export async function fetchExportRows(apiKey, sourceId, columns, sellerOrVendorIds, from, to, limit, options = {}) {
  const chunks = chunkArray(sellerOrVendorIds, MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT);
  const allRows = [];

  for (const chunk of chunks) {
    const rows = await fetchSourceChunk(apiKey, sourceId, columns, chunk, from, to, limit, options);
    allRows.push(...rows);
  }

  return allRows;
}

// A result sitting exactly on the row cap is indistinguishable from a
// truncated one. Every new report refuses partial data rather than presenting
// an understated total as complete.
export async function fetchExportRowsStrict(apiKey, sourceId, columns, ids, from, to, limit, options = {}, label = "Export") {
  const rows = await fetchExportRows(apiKey, sourceId, columns, ids, from, to, limit, options);
  if (rows.length >= limit) {
    throw new Error(`${label} reached the ${limit.toLocaleString("en-US")} row cap${from ? ` for ${from} to ${to}` : ""}. The report was not saved because partial data would be misleading.`);
  }
  return rows;
}

/* ===== Date helpers (UTC, string based) =====
 * The pure calendar-date/window helpers live in the dependency-free ../date-windows.js leaf so
 * modules that need them (e.g. the report-derivation boundary) do NOT transitively depend on this
 * transport/storage module (which imports supabase.js). They are RE-EXPORTED here unchanged so
 * every existing `import { ... } from "../datadoe.js"` caller keeps working byte-for-byte. */
export { pad2s, daysInMonthUTC, addDaysStr, splitDateRangeByMonth, isFullCalendarMonthWindow };

export function isDateStr(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

// Fixed-length day windows, used where a source is at raw row grain and a whole
// range would exceed the export row cap.
export function splitDateRangeByDays(from, to, days) {
  const windows = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDaysStr(cursor, days - 1);
    windows.push({ from: cursor, to: end < to ? end : to });
    cursor = addDaysStr(end, 1);
  }
  return windows;
}

// DataDoe returns HTTP 400 with this wording when a non-default table has not
// been enabled for the organisation. Reports turn it into an actionable setup
// message instead of a generic server failure.
export function isSourceDisabledError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /source is disabled for this organization/i.test(message);
}
