// Shared report snapshot layer.
//
// Every report built on this helper obeys one contract:
//
//   GET  ?action=<report>&ids=<one account>&...            -> read the SHARED
//        saved snapshot from Supabase. This NEVER calls DataDoe, so opening a
//        report, changing brand, filtering, sorting or paging costs nothing and
//        shows exactly what the last refresher fetched.
//   GET  ?action=<report>&ids=...&refresh=1                -> the one explicit
//        operation allowed to call DataDoe. It claims a database lock first, so
//        two people clicking Refresh cannot spend DataDoe tokens twice, then
//        saves the validated result for every permitted user and publishes a
//        compact Realtime event.
//
// The account is always authorised by api/datadoe.js before this runs.

import { createHash } from "node:crypto";

import {
  claimRefreshLock,
  getLatestReportSnapshot,
  getLatestReportSnapshotForScope,
  getReportSnapshot,
  isSupabaseConfigured,
  publishSnapshotUpdate,
  releaseRefreshLock,
  saveReportSnapshot,
} from "./supabase.js";

// A refresh that produces more than this is a design problem, not something to
// silently truncate or silently keep out of the shared store. Every new report
// aggregates server-side specifically to stay far below it.
// Canonical shared-snapshot payload ceiling now lives in the dependency-free limits leaf so
// every write path enforces ONE value. Imported locally (used below) and re-exported.
import { MAX_SNAPSHOT_BYTES } from "./report-limits.js";
export { MAX_SNAPSHOT_BYTES };

const DEFAULT_LOCK_SECONDS = 240;

export function paramsHashFor(reportVersion, params) {
  const ordered = {};
  Object.keys(params || {}).sort().forEach((key) => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== "") ordered[key] = String(value);
  });
  return createHash("sha256")
    .update(JSON.stringify({ reportVersion, ...ordered }))
    .digest("hex")
    .slice(0, 40);
}

export function wantsRefresh(req) {
  const value = String(req.query?.refresh ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// A stale snapshot is only safe to serve across a date rollover when it was
// produced by the current metric schema. A reportVersion bump means its
// payload shape or definitions changed, so an older payload must not masquerade
// as the new report.
export function staleSnapshotMatchesReportVersion(snapshot, reportVersion) {
  return snapshot?.params?.reportVersion === reportVersion;
}

// A stale snapshot may only be served across a date rollover when it belongs to the SAME scope as the request --
// not just the same report version. Daily Reporting is scoped by brand: an ALL-brand snapshot must never be
// served to a named-brand request (that would show the whole account under one brand's heading), nor the reverse.
// The as-of date (`to`) is deliberately NOT part of the scope -- rolling past it is the whole point of the stale
// path. Keys not listed impose no constraint, so reports that pass no staleScopeKeys keep the prior behaviour.
const BRAND_SCOPE_DEFAULT = "ALL";
function scopeValue(key, value) {
  if (key === "brand") { const b = value == null ? "" : String(value).trim(); return b || BRAND_SCOPE_DEFAULT; }
  return value == null ? "" : String(value);
}
export function pickStaleScope(params, keys) {
  const scope = {};
  for (const k of keys || []) scope[k] = scopeValue(k, params ? params[k] : undefined);
  return scope;
}
export function staleSnapshotMatchesScope(snapshot, params, keys) {
  if (!keys || !keys.length) return true;
  const sp = snapshot && snapshot.params ? snapshot.params : {};
  return keys.every((k) => scopeValue(k, sp[k]) === scopeValue(k, params ? params[k] : undefined));
}

function snapshotMeta(snapshot) {
  return {
    savedAt: snapshot.source_refreshed_at || snapshot.updated_at || null,
    updatedAt: snapshot.updated_at || null,
    bytes: Number(snapshot.payload_bytes || 0),
    shared: true,
  };
}

// Legacy reports were originally written before the shared store existed.
// They still build their payload in api/datadoe.js, so this small session API
// lets those builders claim the same lock and persist through the same schema
// without duplicating locking or Supabase writes in every route.
export async function beginSharedRefresh({
  res, reportKey, reportVersion, accountId, params, userId, label,
  lockSeconds = DEFAULT_LOCK_SECONDS, present = (payload) => payload,
}) {
  const paramsHash = paramsHashFor(reportVersion, params);
  if (!isSupabaseConfigured()) {
    return {
      finish(payload) {
        res.status(200).json({ ...present(payload), reportKey, reportVersion, paramsHash, shared: false });
      },
      release: async () => {},
    };
  }

  const locked = await claimRefreshLock({ reportKey, accountId, paramsHash, lockSeconds });
  if (!locked) {
    res.status(409).json({
      error: `${label} is already being refreshed for this account. Wait for that refresh to finish, then read the saved data â€” it does not need a second DataDoe export.`,
    });
    return null;
  }

  return {
    async finish(payload) {
      const serialised = JSON.stringify(payload);
      const payloadBytes = Buffer.byteLength(serialised, "utf8");
      if (payloadBytes > MAX_SNAPSHOT_BYTES) {
        throw new Error(`${label} produced ${(payloadBytes / (1024 * 1024)).toFixed(1)} MB, above the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MB shared-snapshot limit. It was not saved. Narrow the scope (fewer days or a single brand) or aggregate this report further before relying on it.`);
      }
      const saved = await saveReportSnapshot({
        reportKey,
        accountId,
        paramsHash,
        params: { reportVersion, ...params },
        payload,
        payloadBytes,
        sourceRefreshedAt: new Date().toISOString(),
      });
      if (saved?.id) {
        await publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
      }
      res.status(200).json({
        ...present(payload),
        reportKey,
        reportVersion,
        paramsHash,
        snapshot: {
          savedAt: saved?.source_refreshed_at || new Date().toISOString(),
          updatedAt: saved?.updated_at || null,
          bytes: payloadBytes,
          shared: true,
          refreshedBy: userId || null,
        },
      });
    },
    release: () => releaseRefreshLock({ reportKey, accountId, paramsHash }).catch(() => {}),
  };
}

/**
 * Serve one report through the shared snapshot layer.
 *
 * @param {object} options
 * @param {object} options.res            Vercel response
 * @param {boolean} options.refresh       true only for an explicit Refresh
 * @param {string} options.reportKey      stable report identifier
 * @param {string} options.reportVersion  bump when the metric definition changes
 * @param {string} options.accountId      single selected account
 * @param {object} options.params         scope that identifies the snapshot
 * @param {string} options.userId         requesting user (audit only)
 * @param {string} options.label          human report name for messages
 * @param {() => Promise<object>} options.build  performs the DataDoe work
 * @param {(payload: object) => object} [options.present]  removes data the
 *        current user is not allowed to see after a shared payload is read
 */
export async function serveSharedReport({
  res, refresh, reportKey, reportVersion, accountId, params, userId, label, build,
  lockSeconds = DEFAULT_LOCK_SECONDS, present = (payload) => payload,
  // Optional TRUSTED ZERO-EXPORT durable re-derivation. When provided (Daily Reporting) and no compatible saved
  // snapshot exists on a READ, recompute the current-version payload from already-durable evidence and publish
  // it so the page auto-populates on this very visit -- still ZERO DataDoe. () => ({ payload, sourceRefreshedAt }
  // | { notReady, blockedBy? }). NEVER passed a DataDoe adapter, so it cannot create an export.
  deriveDurable = null,
  // Param keys that a stale (date-rolled) snapshot MUST match to be served -- e.g. ["brand"] for Daily, so a
  // named-brand read never falls back to the ALL-brand snapshot. Empty keeps the original report-version-only match.
  staleScopeKeys = [],
  // Injectable Supabase readers + self-heal store, so the full read path (including the brand-scoped stale fallback
  // and the durable self-heal) is provable offline. Production passes nothing and uses the module wrappers.
  readers = {}, store = undefined,
  // FRESHNESS (Brand View): the newest contributing-source provenance (ISO). When set, a served snapshot older
  // than it is flagged `updating:true` so the caller shows the last-known-good NOW and a zero-export rebuild is
  // known to be due (default null = the field is never added, behaviour byte-identical for every other report).
  contributingProvenanceAt = null,
  // 504 GUARD (Brand View portfolio): when true, a READ never runs the potentially-slow `deriveDurable` inline
  // (the serverless-timeout source); a missing snapshot returns a typed `updating` state instead. The bounded
  // rebuild happens only on an explicit refresh (below). Default false keeps the inline self-heal for every
  // other report.
  deferRebuildOnRead = false,
  // Optional serve-time augmentation (Daily Reporting + Brand View): async ({ accountId, params, payload }) =>
  // extra response fields merged into a PAYLOAD-serving response only. Used to attach the current two-layer
  // `completeness` (provisional/final + itemization) read live from source_oli_completeness -- always fresh, never
  // stored in the snapshot, never on a snapshotMissing/updating-only response. Default null = never added.
  augmentResponse = null,
  // When set (a makeRouteDeadline handle), the REFRESH build is bounded: on ROUTE_DEADLINE_EXCEEDED the caller
  // serves the last-known-good + `updating:true` (HTTP 200), never a 504. Default null = unbounded (unchanged).
  routeDeadline = null,
}) {
  const paramsHash = paramsHashFor(reportVersion, params);
  // Null-safe source-staleness probe: a served snapshot whose source provenance predates the newest contributing
  // provenance is stale (a rebuild is due). Returns false whenever no provenance was supplied (never fabricates).
  const isSourceStale = (snap) => {
    if (!contributingProvenanceAt || !snap) return false;
    const snapAt = String(snap.source_refreshed_at || snap.updated_at || "");
    return !!snapAt && snapAt < String(contributingProvenanceAt);
  };
  const readSnapshot = readers.getReportSnapshot || getReportSnapshot;
  const readLatest = readers.getLatestReportSnapshot || getLatestReportSnapshot;
  const readLatestForScope = readers.getLatestReportSnapshotForScope || getLatestReportSnapshotForScope;

  // Without Supabase there is no shared store. Refresh still works so the app
  // remains usable in a local environment, but it is reported as unshared
  // rather than pretending the result was saved for everyone.
  if (!isSupabaseConfigured()) {
    if (!refresh) {
      res.status(200).json({
        snapshotMissing: true,
        reportKey, reportVersion, accountId, paramsHash,
        message: `${label} has no shared saved data because Supabase is not configured in this deployment.`,
      });
      return;
    }
    const payload = await build();
    res.status(200).json({ ...present(payload), reportKey, reportVersion, paramsHash, shared: false });
    return;
  }

  if (!refresh) {
    const snapshot = await readSnapshot({ reportKey, accountId, paramsHash });
    if (snapshot && snapshot.payload) {
      // The EXACT snapshot exists. If the contributing sources have advanced past it (e.g. brand-sales rolled
      // 21 -> 25 Aug under the same asOf), serve it NOW but flag `updating` so a zero-export rebuild is triggered.
      const updating = isSourceStale(snapshot);
      const extra = augmentResponse ? await augmentResponse({ accountId, params, payload: snapshot.payload }) : {};
      res.status(200).json({
        ...present(snapshot.payload),
        reportKey, reportVersion, paramsHash,
        ...(updating ? { updating: true } : {}),
        ...(extra && typeof extra === "object" ? extra : {}),
        snapshot: snapshotMeta(snapshot),
      });
      return;
    }

    // Every report's scope includes its as-of date, so the exact key stops
    // matching the moment the date rolls over. Rather than show a blank report
    // every morning, serve the most recent saved snapshot for this report and
    // account and label it with the scope it was actually saved for. The stale
    // flag is what lets the UI say "this is yesterday's report" instead of
    // implying it is current. When staleScopeKeys is set the fallback is
    // narrowed to the SAME scope (e.g. brand), so a named-brand read cannot be
    // answered with the ALL-brand snapshot.
    const latest = staleScopeKeys.length
      ? await readLatestForScope({ reportKey, accountId, reportVersion, scope: pickStaleScope(params, staleScopeKeys) })
      : await readLatest({ reportKey, accountId });
    if (latest && latest.payload
        && staleSnapshotMatchesReportVersion(latest, reportVersion)
        && staleSnapshotMatchesScope(latest, params, staleScopeKeys)) {
      // A last-known-good for a DIFFERENT params hash (across-day / changed account set) is itself a stale
      // scope; when a rebuild is deferred (Brand View portfolio) OR the sources advanced past it, flag updating
      // so the caller shows this LKG NOW and polls until the rebuild republishes the exact-identity snapshot.
      const updating = deferRebuildOnRead || isSourceStale(latest);
      const extra = augmentResponse ? await augmentResponse({ accountId, params, payload: latest.payload }) : {};
      res.status(200).json({
        ...present(latest.payload),
        reportKey, reportVersion, paramsHash,
        ...(updating ? { updating: true } : {}),
        ...(extra && typeof extra === "object" ? extra : {}),
        snapshot: {
          ...snapshotMeta(latest),
          staleScope: true,
          savedForParams: latest.params || null,
          requestedParams: { reportVersion, ...params },
        },
      });
      return;
    }

    // 504 GUARD: a slow full-portfolio rebuild must NOT run inline on a read. When deferRebuildOnRead is set and
    // no snapshot exists at all, return a typed `updating` state (never a blank fatal error); the frontend shows
    // the updating state and triggers the bounded rebuild via an explicit refresh.
    if (deferRebuildOnRead) {
      res.status(200).json({
        snapshotMissing: true, updating: true,
        reportKey, reportVersion, accountId, paramsHash,
        message: `${label} is being prepared from saved data. It will appear here shortly — no export is created.`,
      });
      return;
    }

    // No exact + no compatible stale snapshot. If a trusted zero-export durable re-derivation exists for this
    // report, recompute the current-version payload from durable evidence and publish it NOW (still zero DataDoe),
    // so a normal page visit auto-populates instead of showing "Nothing saved" while durable evidence is present.
    if (deriveDurable) {
      const healed = await selfHealFromDurable({
        deriveDurable, reportKey, reportVersion, accountId, paramsHash, params, present, res, label, lockSeconds, augmentResponse,
      }, store);
      if (healed.served) return;
      if (healed.notReady) {
        res.status(200).json({
          snapshotMissing: true, reportKey, reportVersion, accountId, paramsHash,
          waitingForScheduledData: true,
          missingSources: healed.missingSources || [],
          message: healed.message,
        });
        return;
      }
      // Concurrent re-derivation in flight (lock held elsewhere) and not yet landed: fall through to the honest
      // "not saved yet" state; the in-flight derivation will publish it for the next read.
    }

    res.status(200).json({
      snapshotMissing: true,
      reportKey, reportVersion, accountId, paramsHash,
      message: `No saved ${label} for this account yet — waiting for the scheduled data refresh.`,
    });
    return;
  }

  const locked = await claimRefreshLock({ reportKey, accountId, paramsHash, lockSeconds });
  if (!locked) {
    res.status(409).json({
      error: `${label} is already being refreshed for this account. Wait for that refresh to finish, then read the saved data — it does not need a second DataDoe export.`,
    });
    return;
  }

  try {
    let payload;
    try {
      payload = await build();
    } catch (e) {
      // BOUNDED rebuild: on a route-deadline expiry, serve the last-known-good + `updating` (HTTP 200) so the
      // page never blanks with a 504. The frontend polls; a later pass republishes the exact-identity snapshot.
      if (routeDeadline && routeDeadline.isDeadlineError && routeDeadline.isDeadlineError(e)) {
        const lkg = staleScopeKeys.length
          ? await readLatestForScope({ reportKey, accountId, reportVersion, scope: pickStaleScope(params, staleScopeKeys) })
          : await readLatest({ reportKey, accountId });
        if (lkg && lkg.payload) {
          res.status(200).json({
            ...present(lkg.payload),
            reportKey, reportVersion, paramsHash, updating: true,
            snapshot: { ...snapshotMeta(lkg), staleScope: lkg.params_hash !== paramsHash, rebuildDeferred: true },
          });
        } else {
          res.status(200).json({
            snapshotMissing: true, updating: true, reportKey, reportVersion, accountId, paramsHash,
            message: `${label} is still being prepared from saved data. It will appear here shortly — no export is created.`,
          });
        }
        return;
      }
      throw e;
    }
    const serialised = JSON.stringify(payload);
    const payloadBytes = Buffer.byteLength(serialised, "utf8");
    if (payloadBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error(`${label} produced ${(payloadBytes / (1024 * 1024)).toFixed(1)} MB, above the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MB shared-snapshot limit. It was not saved. Narrow the scope (fewer days or a single brand) or aggregate this report further before relying on it.`);
    }
    const saved = await saveReportSnapshot({
      reportKey,
      accountId,
      paramsHash,
      params: { reportVersion, ...params },
      payload,
      payloadBytes,
      sourceRefreshedAt: new Date().toISOString(),
    });
    if (saved?.id) {
      // Only a tiny row is broadcast; report payloads never travel on Realtime.
      await publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
    }
    res.status(200).json({
      ...present(payload),
      reportKey, reportVersion, paramsHash,
      snapshot: {
        savedAt: saved?.source_refreshed_at || new Date().toISOString(),
        updatedAt: saved?.updated_at || null,
        bytes: payloadBytes,
        shared: true,
        refreshedBy: userId || null,
      },
    });
  } finally {
    await releaseRefreshLock({ reportKey, accountId, paramsHash }).catch(() => {});
  }
}

// Friendly names for the durable sources a re-derivation can be blocked on (for the "waiting" message).
const SOURCE_LABELS = {
  "order-line-items": "Order Line Items sales history",
  "product-catalog": "Product Catalog",
  "ads-asin-date": "Amazon Ads (ASIN)",
};
function describeMissingSources(blockedBy) {
  const keys = [...new Set((Array.isArray(blockedBy) ? blockedBy : [])
    // Only sources that actually block the report (sales) matter for the "waiting" state; an Ads-only gap
    // never blocks -- the report still shows sales with Ads typed unavailable.
    .filter((b) => b && b.blocksSales)
    .map((b) => b.sourceKey))];
  return keys.map((k) => SOURCE_LABELS[k] || k);
}

function serveSnapshotJson(res, snapshot, { reportKey, reportVersion, paramsHash, present, extra = {} }) {
  res.status(200).json({
    ...present(snapshot.payload),
    reportKey, reportVersion, paramsHash,
    snapshot: { ...snapshotMeta(snapshot), ...extra },
  });
}

// The default durable store the self-heal writes through (injectable for offline tests).
const DEFAULT_STORE = { claimRefreshLock, releaseRefreshLock, getReportSnapshot, saveReportSnapshot, publishSnapshotUpdate };

// Persist a payload produced by a trusted zero-export re-derivation under the EXACT live identity, and broadcast
// the compact update event. Mirrors beginSharedRefresh.finish's write, minus any DataDoe involvement.
async function persistDerivedSnapshot({ reportKey, reportVersion, accountId, paramsHash, params, payload, sourceRefreshedAt, label }, store = DEFAULT_STORE) {
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (payloadBytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(`${label} re-derived ${(payloadBytes / (1024 * 1024)).toFixed(1)} MB, above the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MB shared-snapshot limit; it was not saved.`);
  }
  const saved = await store.saveReportSnapshot({
    reportKey, accountId, paramsHash,
    params: { reportVersion, ...params },
    payload, payloadBytes,
    sourceRefreshedAt: sourceRefreshedAt || new Date().toISOString(),
  });
  if (saved?.id) await store.publishSnapshotUpdate({ reportKey, accountId, paramsHash, snapshotId: saved.id }).catch(() => {});
  return {
    savedAt: saved?.source_refreshed_at || sourceRefreshedAt || new Date().toISOString(),
    updatedAt: saved?.updated_at || null,
    payload_bytes: payloadBytes,
  };
}

/**
 * Trusted ZERO-EXPORT self-heal for a read whose snapshot is missing. Serializes on the SAME refresh lock so a
 * burst of concurrent page loads produces exactly ONE re-derivation/save; the losers re-read (and serve if it has
 * landed). Returns { served } | { served:false, notReady, missingSources, message } | { served:false } (a
 * concurrent derivation is in flight but not yet saved -> caller shows the honest "not saved yet" state).
 * `store` is injectable so the concurrency + zero-export contract is provable offline.
 */
export async function selfHealFromDurable({ deriveDurable, reportKey, reportVersion, accountId, paramsHash, params, present = (p) => p, res, label, lockSeconds, augmentResponse = null }, store = DEFAULT_STORE) {
  // Two-layer completeness for the self-heal serve (first visit before a scheduled publish). Advisory; the augment
  // returns {} on any failure, so it never breaks the self-heal.
  const augExtra = augmentResponse ? await augmentResponse({ accountId, params }) : {};
  const withAug = (extra) => ({ ...extra, ...(augExtra && typeof augExtra === "object" ? augExtra : {}) });
  const locked = await store.claimRefreshLock({ reportKey, accountId, paramsHash, lockSeconds });
  if (!locked) {
    // Another request already holds the lock and is re-deriving this exact snapshot. Never derive twice; re-read
    // once and serve it if it has already landed, otherwise report missing for this read.
    const snap = await store.getReportSnapshot({ reportKey, accountId, paramsHash });
    if (snap && snap.payload) { serveSnapshotJson(res, snap, { reportKey, reportVersion, paramsHash, present, extra: withAug({ rederived: true }) }); return { served: true }; }
    return { served: false };
  }
  try {
    // Double-check inside the lock: the race winner may have just published it.
    const existing = await store.getReportSnapshot({ reportKey, accountId, paramsHash });
    if (existing && existing.payload) { serveSnapshotJson(res, existing, { reportKey, reportVersion, paramsHash, present, extra: withAug({ rederived: true }) }); return { served: true }; }

    // A re-derivation FAILURE (e.g. an unreadable durable source or a row-limit) must degrade to the honest
    // "waiting" state on a READ -- never a 500 and never a fabricated value.
    let derived = null;
    try { derived = await deriveDurable(); }
    catch (e) { return { served: false, notReady: true, missingSources: [], message: `Waiting for the scheduled data refresh before ${label} can be shown. No fabricated values are displayed and no export is created.` }; }
    if (!derived || !derived.payload) {
      const missingSources = describeMissingSources(derived && derived.blockedBy);
      const named = missingSources.length ? ` (waiting for: ${missingSources.join(", ")})` : "";
      return {
        served: false, notReady: true, missingSources,
        message: `Waiting for the scheduled data refresh before ${label} can be shown${named}. No fabricated values are displayed and no export is created.`,
      };
    }
    // If the re-derivation CLAMPED the requested as-of down to the account's latest proven date, the honest
    // identity is the effective window (from, to=latest-proven, brand), NOT the requested one. Persist under that
    // identity so the row's params_hash matches its params (provenance stays exact) and serve it clearly labelled
    // as an earlier as-of -- exactly like the stale path -- rather than pretending it covers the requested date.
    const effectiveParams = derived.effectiveParams || null;
    const effectiveHash = effectiveParams ? paramsHashFor(reportVersion, effectiveParams) : paramsHash;
    const clamped = effectiveParams && effectiveHash !== paramsHash;
    const persistParams = clamped ? effectiveParams : params;
    const saved = await persistDerivedSnapshot({ reportKey, reportVersion, accountId, paramsHash: effectiveHash, params: persistParams, payload: derived.payload, sourceRefreshedAt: derived.sourceRefreshedAt, label }, store);
    res.status(200).json({
      ...present(derived.payload),
      reportKey, reportVersion, paramsHash: effectiveHash,
      ...(augExtra && typeof augExtra === "object" ? augExtra : {}),
      snapshot: {
        savedAt: saved.savedAt, updatedAt: saved.updatedAt, bytes: saved.payload_bytes, shared: true, rederived: true,
        ...(clamped ? { staleScope: true, savedForParams: { reportVersion, ...effectiveParams }, requestedParams: { reportVersion, ...params } } : {}),
      },
    });
    return { served: true };
  } finally {
    await store.releaseRefreshLock({ reportKey, accountId, paramsHash }).catch(() => {});
  }
}
