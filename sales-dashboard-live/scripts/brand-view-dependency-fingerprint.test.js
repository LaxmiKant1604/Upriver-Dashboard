// Defect B regression: the Brand View DEPENDENCY FINGERPRINT makes freshness depend on the COMPLETE contributing
// set, not a single brand-sales timestamp. Proves: (1) the pure fingerprint is stable + flips on any dependency
// change (incl. missing->available AND available->unavailable); (2) the writer (materializeSnapshot) writes exactly
// once on a changed dependency with unchanged sales provenance, and zero on a replay, while every non-fingerprint
// report stays byte-identical; (3) the serve (serveSharedReport) flags updating on a fingerprint mismatch and fresh
// on a match -- writer and serve agree by construction. Offline, pure, ZERO network. 7-bit ASCII, LF.
import "./_supabase-env-stub.mjs"; // FIRST: make isSupabaseConfigured() true so the serve READ path runs (injected readers only).
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  brandViewDependencyFingerprint, collectBrandViewDependencyFingerprint,
} from "../lib/server/reports/brand-view-dependency-fingerprint.js";
import { materializeSnapshot } from "../lib/server/sync/report-materialization-core.js";
import { serveSharedReport } from "../lib/server/report-store.js";
import { buildBrandViewMaterializationRelease } from "../lib/server/sync/report-materialization-brandview-composition.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "brand-view-dependency-fingerprint (Defect B)\n");

// ---- (1) pure fingerprint stability + change-detection --------------------------------------------------------
const baseManifest = {
  v: "brand-view-account-scoped-v2", scope: "account", brand: "Acme", accounts: ["a1"], cat: "cat-v1",
  deps: { a1: { bs: { present: true, h: "bsh", t: "2026-09-09T03:00:00Z" }, bi: { present: false }, fp: { present: false }, lh: { present: false }, ads: { present: false }, map: "" } },
};
const fp = (m) => brandViewDependencyFingerprint(m);
ok("A: identical manifest => identical fingerprint (deterministic)", fp(baseManifest) === fp(JSON.parse(JSON.stringify(baseManifest))));
ok("A: key order does not matter (canonical sort)", fp({ ...baseManifest }) === fp({ deps: baseManifest.deps, cat: baseManifest.cat, accounts: baseManifest.accounts, brand: baseManifest.brand, scope: baseManifest.scope, v: baseManifest.v }));

const withInvAvailable = JSON.parse(JSON.stringify(baseManifest));
withInvAvailable.deps.a1.bi = { present: true, h: "bih", t: "2026-09-09T16:40:00Z" };
ok("A: inventory missing->available flips the fingerprint", fp(baseManifest) !== fp(withInvAvailable));

const invGone = JSON.parse(JSON.stringify(withInvAvailable));
invGone.deps.a1.bi = { present: false };
ok("A: inventory available->unavailable (present:false sentinel) flips back / differs", fp(withInvAvailable) !== fp(invGone) && fp(invGone) === fp(baseManifest));

const adsAdvanced = JSON.parse(JSON.stringify(baseManifest));
adsAdvanced.deps.a1.ads = { present: true, latest: "2026-09-08", status: "succeeded", wins: "2026-07-08..2026-09-08" };
ok("A: an Ads advance (latestMetricDate/window) flips the fingerprint", fp(baseManifest) !== fp(adsAdvanced));

const mapChanged = JSON.parse(JSON.stringify(baseManifest));
mapChanged.deps.a1.map = "rev-2";
ok("A: a campaign->brand mapping revision change flips the fingerprint", fp(baseManifest) !== fp(mapChanged));

const catChanged = { ...baseManifest, cat: "cat-v2" };
ok("A: a Product Catalog re-validation flips the fingerprint", fp(baseManifest) !== fp(catChanged));

const verBump = { ...baseManifest, v: "brand-view-account-scoped-v3" };
ok("A: a report-version bump flips the fingerprint", fp(baseManifest) !== fp(verBump));

// ---- (2) collector: writer + serve compute an IDENTICAL fingerprint from the SAME readers ---------------------
// A tiny in-memory dependency world; two independent reader sets over it must agree.
const world = {
  meta: {
    "brand-sales|a1": { params_hash: "bsh", source_refreshed_at: "2026-09-09T03:00:00Z" },
    "brand-inventory|a1": { params_hash: "bih", source_refreshed_at: "2026-09-09T16:40:00Z" },
    "fba-plan|a1": { params_hash: "fph", source_refreshed_at: "2026-09-09T16:40:00Z" },
  },
  ads: { a1: { windows: [{ from: "2026-07-08", to: "2026-09-08" }], status: "succeeded", latestMetricDate: "2026-09-06" } },
  mapRev: { a1: "rev-1" },
  catalog: "cat-2026-09-09",
};
const readersFrom = (w) => ({
  getSnapshotMeta: async ({ reportKey, accountId }) => w.meta[`${reportKey}|${accountId}`] || null,
  getAdsCoverage: async (accountId) => w.ads[accountId] || null,
  getMappingRev: async (accountId) => w.mapRev[accountId] || "",
  getCatalogValidatedAt: async () => w.catalog,
});
const args = { scope: "account", brand: "Acme", accountIds: ["a1"], reportVersion: "brand-view-account-scoped-v2" };
const writerFp = await collectBrandViewDependencyFingerprint({ ...args, readers: readersFrom(world) });
const serveFp = await collectBrandViewDependencyFingerprint({ ...args, readers: readersFrom(JSON.parse(JSON.stringify(world))) });
ok("B: writer and serve collectors agree over the same dependency state (converged => equal)", writerFp === serveFp);

// Advance inventory in the serve's world only -> the two disagree (a rebuild is due).
const advanced = JSON.parse(JSON.stringify(world));
advanced.meta["brand-inventory|a1"] = { params_hash: "bih2", source_refreshed_at: "2026-09-10T16:40:00Z" };
const serveFp2 = await collectBrandViewDependencyFingerprint({ ...args, readers: readersFrom(advanced) });
ok("B: an inventory advance makes the current fingerprint differ from the stored one", serveFp2 !== writerFp);

// A reader that throws degrades to an absent identity (never throws, never a false 'unchanged').
const throwyFp = await collectBrandViewDependencyFingerprint({ ...args, readers: {
  getSnapshotMeta: async () => { throw new Error("read fail"); },
  getAdsCoverage: async () => { throw new Error("read fail"); },
  getMappingRev: async () => { throw new Error("read fail"); },
  getCatalogValidatedAt: async () => { throw new Error("read fail"); },
} });
ok("B: a fully-unreadable dependency world yields a stable fingerprint (never throws)", typeof throwyFp === "string" && throwyFp.length === 40 && throwyFp !== writerFp);

// ---- (3) writer idempotency (invert the codex repro) ----------------------------------------------------------
const salesAt = "2026-09-09T03:00:00Z";
const fpOld = fp(baseManifest);
const fpNew = fp(withInvAvailable);
{
  let writes = 0;
  const r = await materializeSnapshot({
    reportKey: "brand-view", reportVersion: "brand-view-account-scoped-v2", accountId: "brand-view:a1::Acme", params: { accountId: "a1", brand: "Acme", asOf: "2026-09-09" },
    derived: { payload: { inventoryAvailable: true, adSpend: 123 }, sourceRefreshedAt: salesAt, depFingerprint: fpNew },
    readSnapshot: async () => ({ payload: { inventoryAvailable: false, adSpend: null }, source_refreshed_at: salesAt, params: { depFingerprint: fpOld } }),
    persistSnapshot: async () => { writes += 1; return {}; },
  });
  ok("C: changed inventory/Ads with UNCHANGED sales provenance => exactly one write (repro inverted)", r.status === "materialized" && writes === 1);
}
{
  let writes = 0;
  const r = await materializeSnapshot({
    reportKey: "brand-view", reportVersion: "brand-view-account-scoped-v2", accountId: "brand-view:a1::Acme", params: { accountId: "a1", brand: "Acme", asOf: "2026-09-09" },
    derived: { payload: { inventoryAvailable: true, adSpend: 123 }, sourceRefreshedAt: salesAt, depFingerprint: fpNew },
    readSnapshot: async () => ({ payload: { inventoryAvailable: true, adSpend: 123 }, source_refreshed_at: salesAt, params: { depFingerprint: fpNew } }),
    persistSnapshot: async () => { writes += 1; return {}; },
  });
  ok("C: unchanged replay (same fingerprint) => zero writes", r.status === "unchanged" && writes === 0);
}
{
  // Persisted params must carry the new fingerprint so a later replay compares against it.
  let savedParams = null;
  await materializeSnapshot({
    reportKey: "brand-view", reportVersion: "brand-view-account-scoped-v2", accountId: "brand-view:a1::Acme", params: { accountId: "a1", brand: "Acme", asOf: "2026-09-09" },
    derived: { payload: { x: 1 }, sourceRefreshedAt: salesAt, depFingerprint: fpNew },
    readSnapshot: async () => null,
    persistSnapshot: async (u) => { savedParams = u.params; return {}; },
  });
  ok("C: the stored params jsonb carries depFingerprint (NOT in the identity params/paramsHash)", savedParams && savedParams.depFingerprint === fpNew);
}
{
  // Legacy path (no fingerprint) is byte-identical: equal source_refreshed_at => unchanged.
  let writes = 0;
  const r = await materializeSnapshot({
    reportKey: "sku-movement", reportVersion: "sku-movement/v2", accountId: "s", params: { asOf: "2026-09-09" },
    derived: { payload: { x: 1 }, sourceRefreshedAt: salesAt },
    readSnapshot: async () => ({ payload: { x: 0 }, source_refreshed_at: salesAt }),
    persistSnapshot: async () => { writes += 1; return {}; },
  });
  ok("C: a report supplying NO fingerprint keeps legacy timestamp idempotency (byte-identical)", r.status === "unchanged" && writes === 0);
}

// ---- (4) serve freshness by fingerprint (real serveSharedReport path) -----------------------------------------
const makeRes = () => { const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; return res; };
const storedSnap = (depFingerprint) => ({ payload: { brand: "Acme", ok: true }, source_refreshed_at: salesAt, params: { reportVersion: "brand-view-account-scoped-v2", accountId: "a1", brand: "Acme", asOf: "2026-09-09", depFingerprint } });
const serveWith = async ({ stored, contributingDepFingerprint }) => {
  const res = makeRes();
  await serveSharedReport({
    res, refresh: false, reportKey: "brand-view", reportVersion: "brand-view-account-scoped-v2", accountId: "brand-view:a1::Acme",
    params: { accountId: "a1", brand: "Acme", asOf: "2026-09-09" }, userId: "u", label: "Brand View",
    contributingProvenanceAt: salesAt, contributingDepFingerprint,
    readers: { getReportSnapshot: async () => stored, getLatestReportSnapshot: async () => stored, getLatestReportSnapshotForScope: async () => stored },
  });
  return res;
};
{
  const res = await serveWith({ stored: storedSnap(fpNew), contributingDepFingerprint: fpNew });
  ok("D: stored fingerprint == current => served fresh (NOT updating)", res.statusCode === 200 && !res.body.updating);
}
{
  const res = await serveWith({ stored: storedSnap(fpOld), contributingDepFingerprint: fpNew });
  ok("D: stored fingerprint != current => served LKG + updating:true (converges on next scheduled publish)", res.statusCode === 200 && res.body.updating === true);
}
{
  // A legacy snapshot with NO stored fingerprint falls back to the timestamp probe (here equal => fresh).
  const legacy = { payload: { ok: true }, source_refreshed_at: salesAt, params: { reportVersion: "brand-view-account-scoped-v2", accountId: "a1", brand: "Acme", asOf: "2026-09-09" } };
  const res = await serveWith({ stored: legacy, contributingDepFingerprint: fpNew });
  ok("D: a legacy snapshot with no stored fingerprint falls back to the timestamp probe (equal ts => fresh)", res.statusCode === 200 && !res.body.updating);
}

// ---- (5) TOCTOU-safe ordering: the fingerprint is captured BEFORE the payload is built --------------------------
// If the payload were built first and the fingerprint after, a concurrent same-account dependency advance during the
// (unlocked) build could store payload=rev(N) with fingerprint=rev(N+1) -- stranding a stale payload as 'fresh' and
// blocking self-heal. Capturing the fingerprint first guarantees stored fp is never NEWER than the payload.
{
  const order = [];
  const release = buildBrandViewMaterializationRelease({
    getConnections: () => [{ id: "primary", apiKey: "k", organizationFingerprint: "org" }],
    getSnapshotMeta: async () => { order.push("fp"); return null; },
    getAdsCoverageState: async () => { order.push("fp"); return null; },
    getMappings: async () => [],
    getSourceSnap: async () => ({ snapshot: null }),
    getProvenance: async () => "2026-09-09T00:00:00Z",
    getAdsRows: async () => [],
    buildSingle: async () => { order.push("build"); return { rows: [{ product_brand: "Acme" }] }; },
    buildPortfolio: async () => { order.push("build"); return { rows: [{ product_brand: "Acme" }] }; },
  });
  const rSingle = await release.deriveBrandView({ accountId: "a1", brand: "Acme", asOf: "2026-09-09", account: { country: "IN" } });
  ok("E: single derive captures the fingerprint BEFORE building the payload (TOCTOU-safe)", order.indexOf("fp") >= 0 && order.indexOf("build") >= 0 && order.indexOf("fp") < order.indexOf("build") && typeof rSingle.depFingerprint === "string");
  order.length = 0;
  const rPort = await release.deriveBrandViewPortfolio({ accountIds: ["a1"], brand: "Acme", asOf: "2026-09-09", region: "india", accountsById: {} });
  ok("E: portfolio derive captures the fingerprint BEFORE building the payload (TOCTOU-safe)", order.indexOf("fp") < order.indexOf("build") && typeof rPort.depFingerprint === "string");
}

writeSync(1, `\nbrand-view-dependency-fingerprint: ${passed} assertions passed\n`);
