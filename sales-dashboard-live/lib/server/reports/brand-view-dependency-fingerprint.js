// SHARED Brand View DEPENDENCY FINGERPRINT (Defect B repair).
//
// Brand View (single-account + portfolio) is ASSEMBLED at read/materialization time from MANY contributing
// dependencies -- per-account brand-sales, the compact brand-inventory snapshot, the fba-plan / listing-health
// inventory fallbacks, durable Ads coverage, the campaign->brand mapping revision, and the org Product Catalog.
// Freshness used to be keyed on a SINGLE brand-sales timestamp (report-materialization-core.js compared only
// derived.sourceRefreshedAt), so a changed OPTIONAL dependency (inventory became available, Ads advanced, a
// mapping was edited) with an unchanged brand-sales timestamp returned `unchanged` and never reached the saved
// report. This module replaces the single-timestamp equality with a STABLE dependency FINGERPRINT: one sha256
// over a canonical manifest of every contributing dependency's IDENTITY (params_hash + provenance timestamp +
// present/absent), computed IDENTICALLY by BOTH the writer (materializer) and the reader (serve) from the SAME
// injected readers, so the two can never drift. Equality of the fingerprint means "the complete dependency set
// is unchanged" (same inputs => zero-write replay); ANY change -- including missing->available AND
// available->unavailable (explicit `present:false` sentinels) -- flips the hash and yields exactly one update.
//
// It is PURE + dependency-light: the hash is a pure function of the manifest (mirrors report-store.js
// paramsHashFor), and the async collector takes INJECTED readers so it is offline-testable and makes ZERO
// DataDoe calls. It reuses metadata every snapshot read already returns (params_hash + source_refreshed_at)
// plus the cheap indexed ads-coverage / mapping-revision / catalog-validated_at reads -- no new store, no
// migration, no payload change (the fingerprint is carried in the existing params jsonb by the caller).

import { createHash } from "node:crypto";

const S = (v) => (v == null ? "" : String(v));

// A snapshot's IDENTITY tuple for the manifest: params_hash + provenance timestamp, or an explicit absent
// sentinel. NEVER the payload -- two different payloads under the same identity cannot occur (a content change
// always advances source_refreshed_at via saveReportSnapshot), and the absent sentinel makes an available->
// unavailable (row deleted / never produced) transition flip the hash.
function snapshotIdentity(meta) {
  if (!meta) return { present: false };
  return {
    present: true,
    h: S(meta.params_hash ?? meta.paramsHash),
    t: S(meta.source_refreshed_at ?? meta.sourceRefreshedAt ?? meta.updated_at ?? meta.updatedAt),
  };
}

// Ads dependency identity: the durable coverage advance (latestMetricDate) + the successful coverage windows +
// the sync status. An Ads-only advance (a new metric date, or a newly-covered window) flips this; a genuinely
// quiet covered day (no new metric row) does not. `absent` when no coverage state exists at all.
function adsIdentity(coverage) {
  if (!coverage) return { present: false };
  const windows = Array.isArray(coverage.windows) ? coverage.windows : [];
  const winKey = windows
    .map((w) => `${S(w && (w.from ?? w.covered_from))}..${S(w && (w.to ?? w.covered_to))}`)
    .sort()
    .join(",");
  return {
    present: true,
    latest: S(coverage.latestMetricDate),
    status: S(coverage.status),
    wins: winKey,
    // CONTENT revision (Item 2): a durable per-(account, source) hash the Ads writer computes over the persisted
    // row VALUES. A SAME-WINDOW correction (spend/sales/clicks change with unchanged coverage dates + latestMetricDate)
    // changes rev and flips the fingerprint; an unchanged re-sync yields the SAME rev (replay-stable). Absent (no
    // coverage / pre-migration) -> "" -> byte-identical to the coverage-only identity, so this is fail-soft.
    rev: S(coverage.contentRev),
  };
}

/**
 * PURE: the stable dependency fingerprint of a canonical manifest. Sorted-key JSON -> sha256 -> 40 hex chars
 * (exactly like paramsHashFor). Same manifest => same fingerprint on both writer and serve.
 */
export function brandViewDependencyFingerprint(manifest) {
  const canonical = canonicalize(manifest);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 40);
}

// Deterministic key ordering so JSON.stringify is stable regardless of insertion order (objects only; arrays
// keep their given order -- callers must sort arrays they build, which the collector does for account ids).
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * Build the canonical dependency manifest for a Brand View identity from INJECTED readers, then fingerprint it.
 * BOTH the writer (report-materialization-brandview-composition deriveBrandView/Portfolio) and the serve
 * (api/datadoe.js) call this with the SAME readers, so they compute an identical value by construction.
 *
 * @param {object} args
 *   scope       "account" | "portfolio"
 *   brand       the selected brand (display name)
 *   accountIds  the contributing account id(s) (single = [one]; portfolio = the sorted membership set)
 *   reportVersion the report version (so a version bump always changes the fingerprint)
 *   readers     ALL zero-export, injected:
 *     getSnapshotMeta({ reportKey, accountId }) -> { params_hash, source_refreshed_at, updated_at } | null
 *     getAdsCoverage(accountId) -> { windows, status, latestMetricDate } | null
 *     getMappingRev(accountId) -> string (a deterministic mapping revision; "" when none)
 *     getCatalogValidatedAt() -> string | null (org Product Catalog validated_at / payload sha)
 * Returns the fingerprint string. Reader failures degrade to an absent/empty identity (never throws), so a
 * transient read cannot fabricate a false "unchanged" -- an unreadable dependency simply contributes its safe
 * absent sentinel, which differs from a real present identity and errs toward "changed" (a rebuild), never the
 * reverse.
 */
export async function collectBrandViewDependencyFingerprint({
  scope, brand, accountIds, reportVersion, readers = {},
}) {
  const {
    getSnapshotMeta = async () => null,
    getAdsCoverage = async () => null,
    getMappingRev = async () => "",
    getCatalogValidatedAt = async () => null,
  } = readers;

  const ids = [...new Set((accountIds || []).map(S))].filter(Boolean).sort();

  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

  // Gather every account's dependency identity in PARALLEL (each read is cheap indexed metadata) so a multi-account
  // portfolio serve does not accumulate per-account latency before returning its last-known-good. The catalog read
  // (org-scoped) runs alongside.
  const [perAccount, cat] = await Promise.all([
    Promise.all(ids.map(async (accountId) => {
      const [bs, bi, fp, lh, ads, map] = await Promise.all([
        safe(() => getSnapshotMeta({ reportKey: "brand-sales", accountId }), null),
        safe(() => getSnapshotMeta({ reportKey: "brand-inventory", accountId }), null),
        safe(() => getSnapshotMeta({ reportKey: "fba-plan", accountId }), null),
        safe(() => getSnapshotMeta({ reportKey: "listing-health", accountId }), null),
        safe(() => getAdsCoverage(accountId), null),
        safe(() => getMappingRev(accountId), ""),
      ]);
      return [accountId, {
        bs: snapshotIdentity(bs),
        bi: snapshotIdentity(bi),
        fp: snapshotIdentity(fp),
        lh: snapshotIdentity(lh),
        ads: adsIdentity(ads),
        map: S(map),
      }];
    })),
    safe(() => getCatalogValidatedAt(), null),
  ]);
  const deps = {};
  for (const [accountId, identity] of perAccount) deps[accountId] = identity;

  const manifest = {
    v: S(reportVersion),
    scope: S(scope),
    brand: S(brand),
    accounts: ids,
    cat: S(cat),
    deps,
  };
  return brandViewDependencyFingerprint(manifest);
}
