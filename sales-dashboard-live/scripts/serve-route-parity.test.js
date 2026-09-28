// Publication recovery WP10 (part A) -- the api/datadoe.js SERVE changes, proven fully offline against (a) the recovery
// routes that publish the rows the serve reads and (b) the PRE-WP10 serve (the OLD_API sources below are the pre-change
// api/datadoe.js functions, spliced VERBATIM as line arrays). api/datadoe.js is a Vercel entry that evaluates the whole
// sync runtime on import, so the CURRENT serve functions are source-extracted and compiled over injected readers (the
// harness the brand-view route suites use).
//   R. the supabase.js readers the SKU serve token needs: getSourceCoverageWindows (ADDITIVE updated_at -> updatedAt) and
//      the new cheap getSourceOliOperationalUnitStats (Prefer: count=exact + max(updated_at)), over a PostgREST emulator.
//   K. the additive updatedAt is ignored by every pure coverage consumer (byte-identical outputs with / without it).
//   S. SKU Movement serve-token PARITY: the REAL serve (source-extracted, over the REAL readers) computes EXACTLY the token
//      the sku-movement route stamps (composeSkuMovementScopeEvidence over its SQL-rendered evidence) and the
//      sku-movement-route.test.js wp10Serve model computes (its S6 cases, the T4 same-effectiveAsOf OLI correction, the
//      T5 operational-units backfill).
//   P. the serve predicate: a new-token row is served stored; a mismatching / 'sms1:' / blank token re-derives read-only;
//      a failed stats read is no token; a LEGACY row keeps the old predicate and the old response BYTE-FOR-BYTE with ZERO
//      extra reads; the response paramsHash is the canonical { asOf, brand } hash for rows with stored extras.
//   M. sharedSnapshotBrandAccounts through brand-directory-membership.js: byte-identical to the pre-WP10 serve over the
//      fixtures ('Unassigned', an out-of-line payload, a still-loading account, unknown country, inactive / settingUp,
//      case variants, dd-secondary / duplicate / whitespace ids, catalog statuses, action attempts).
//   F. brandViewDepFingerprintReaders through makeBrandViewDepReaders: byte-identical reader results, underlying calls and
//      fingerprints (with / without a primary org, failing readers).
//   D. Brand View directory hydration: an out-of-line brand-sales payload now contributes its brands in BOTH the serve
//      rebuild and the brand-view-brands route derive (byte-identical payloads); an ABSENT storage object is the serve's
//      typed 503 UNAVAILABLE and the route's typed 'storage-missing:<rk>' deferral; a failed load 'hydrate-failed:<rk>'.
// Zero DataDoe / zero writes: the global fetch answers ONLY two PostgREST SELECT tables and refuses everything else.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SUPABASE_URL = "http://supabase.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
process.env[SB_KEY_ENV] = ["test", "svc", "role", "key"].join("-");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; out("  ok  " + name); };
const J = (v) => JSON.stringify(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// PostgREST's JSON rendering of a timestamptz (fraction trimmed, '+00:00') -- what the serve's REST reads see -- and the
// route SQL's to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') rendering of the SAME instant (fixtures are ms precision).
const pgrest = (iso) => (iso == null ? null : String(iso).replace(/\.000Z$/, "+00:00").replace(/(\.\d*?)0+Z$/, "$1+00:00").replace(/Z$/, "+00:00"));
const toUs = (iso) => (iso == null ? null : String(iso).replace(/\.(\d{3})Z$/, ".$1000Z"));

// =====================================================================================================================
// The network: a PostgREST emulator for SELECTs on source_coverage + source_oli_operational_units ONLY.
// =====================================================================================================================
const ORG = "org-fp-test";
const net = { calls: [], refused: [], headers: [] };
let world = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const method = String(opts.method || "GET");
  const headers = opts.headers || {};
  net.calls.push(method + " " + u.pathname + "?" + u.searchParams.toString());
  net.headers.push(headers);
  if (u.origin !== "http://supabase.test" || method !== "GET" || !world) { net.refused.push(String(url)); throw new Error("network refused in an offline test"); }
  const q = u.searchParams;
  const eq = (k) => { const v = q.get(k); return v && v.startsWith("eq.") ? v.slice(3) : null; };
  const json = (body, status = 200, extra = {}) => new Response(J(body), { status, headers: { "content-type": "application/json", ...extra } });
  if (u.pathname === "/rest/v1/source_coverage") {
    if (world.fail.coverage) return json({ code: "XX000", message: "coverage read failed" }, 400);
    const sel = String(q.get("select") || "").split(",");
    const rows = world.coverage
      .filter((r) => r.organization_fingerprint === eq("organization_fingerprint") && r.connection_id === eq("connection_id") && r.account_id === eq("account_id") && r.source_key === eq("source_key") && r.status === eq("status"))
      .sort((a, b) => (a.covered_from < b.covered_from ? -1 : a.covered_from > b.covered_from ? 1 : 0))
      .map((r) => Object.fromEntries(sel.map((c) => [c, c.endsWith("_at") ? pgrest(r[c]) : r[c]])));
    return json(rows);
  }
  if (u.pathname === "/rest/v1/source_oli_operational_units") {
    if (world.fail.opunits === "http404") return json({ code: "PGRST205", message: "relation missing" }, 404);
    const dates = q.getAll("sale_date");
    const gte = (dates.find((d) => d.startsWith("gte.")) || "").slice(4);
    const lte = (dates.find((d) => d.startsWith("lte.")) || "").slice(4);
    const all = world.opunits
      .filter((r) => r.organization_fingerprint === eq("organization_fingerprint") && r.connection_id === eq("connection_id") && r.account_id === eq("account_id") && r.sale_date >= gte && r.sale_date <= lte)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    const limit = q.get("limit") == null ? all.length : Number(q.get("limit"));
    const page = all.slice(0, limit).map((r) => ({ updated_at: pgrest(r.updated_at) }));
    const extra = {};
    const exact = /count=exact/.test(String(headers.Prefer || headers.prefer || ""));
    const total = world.fail.opunits === "mismatch" ? (all.length ? 0 : 3) : all.length;
    if (exact && world.fail.opunits !== "no-range") extra["content-range"] = page.length ? "0-" + (page.length - 1) + "/" + total : "*/" + total;
    return json(page, all.length > page.length ? 206 : 200, extra);
  }
  net.refused.push(String(url));
  throw new Error("network refused: unexpected path " + u.pathname);
};

const SB = await import("../lib/server/supabase.js");
const EVI = await import("../lib/server/reports/sku-movement-evidence.js");
const RDR = await import("../lib/server/reports/sku-movement-durable-rederive.js");
const SKW = await import("../lib/server/recovery/routes/sku-movement.route.js");
const { paramsHashFor } = await import("../lib/server/report-params-hash.js");
const { monthBackStr } = await import("../lib/server/date-windows.js");
const SDM = await import("../lib/server/sync/source-durable-model.js");
const DDR = await import("../lib/server/reports/daily-durable-rederive.js");
const FPL = await import("../lib/server/sync/fba-plan-durable-loader.js");
const LHL = await import("../lib/server/sync/listing-health-v3-durable-loader.js");
const MEM = await import("../lib/server/reports/brand-directory-membership.js");
const BM = await import("../lib/server/reports/brand-membership.js");
const BV = await import("../lib/server/reports/brand-view.js");
const DEPR = await import("../lib/server/sync/brand-view-dependency-readers.js");
const FPM = await import("../lib/server/reports/brand-view-dependency-fingerprint.js");
const BVB_C = await import("../lib/server/sync/routes/brand-view-brands.release.js");
const BVB_W = await import("../lib/server/recovery/routes/brand-view-brands.route.js");
const REL = await import("../lib/server/sync/route-publication-release.js");
const { ACTIVE_ADS_SOURCE_KEY } = await import("../lib/server/active-ads-source.js");
const { campaignMappingRevision } = await import("../lib/server/reports/campaign-ads-aggregation.js");

// =====================================================================================================================
// The api/datadoe.js source harness: extract a top-level function by its header, compile it over injected bindings.
// =====================================================================================================================
function matchBracket(text, i, open, close) {
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i]; const d = text[i + 1];
    if (c === "/" && d === "/") { i = text.indexOf("\n", i); if (i < 0) return -1; continue; }
    if (c === "/" && d === "*") { i = text.indexOf("*/", i + 2) + 1; continue; }
    if (c === "'" || c === '"' || c === "`") { const qc = c; i++; while (i < text.length && text[i] !== qc) { if (text[i] === "\\") i++; i++; } continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function extractFunction(text, header) {
  const start = text.indexOf(header);
  if (start < 0) return null;
  const close = matchBracket(text, text.indexOf("(", start), "(", ")");
  const end = matchBracket(text, text.indexOf("{", close), "{", "}");
  return end > 0 ? text.slice(start, end + 1) : null;
}
function compileApi(bodySrc, scope, ret) {
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  return new Function(...names, bodySrc + "\nreturn " + ret + ";")(...names.map((k) => scope[k]));
}
const API = src("api/datadoe.js");
const apiConst = (name) => (API.match(new RegExp("^const " + name + " = \"([^\"]+)\";", "m")) || [])[1];
const NEW = {
  sharedSnapshotBrandAccounts: extractFunction(API, "async function sharedSnapshotBrandAccounts("),
  campaignMappingsReader: extractFunction(API, "function campaignMappingsReader()"),
  brandViewDepFingerprintReaders: extractFunction(API, "function brandViewDepFingerprintReaders()"),
  serveSelfHealingSkuMovement: extractFunction(API, "async function serveSelfHealingSkuMovement("),
  brandViewDirectory: extractFunction(API, "async function brandViewDirectory("),
  respondBrandViewDirectoryUnavailable: extractFunction(API, "function respondBrandViewDirectoryUnavailable("),
};
// The PRE-WP10 api/datadoe.js functions, VERBATIM (spliced from the pre-change file; 7-bit JSON line strings).
const OLD_API = {
  snapshotBrandNames: [
    "function snapshotBrandNames(payload) {",
    "  const names = new Set((payload?.catalogBrands || []).map((brand) => String(brand || \"\").trim()).filter(Boolean));",
    "  // Older Dashboard and SKU P&L snapshots predate catalogBrands on every",
    "  // payload, but their row records still carry the joined brand. This keeps",
    "  // the directory recoverable after a schema upgrade without any DataDoe call.",
    "  (payload?.rows || []).forEach((row) => {",
    "    const brand = row?.product_brand || row?.brand;",
    "    if (String(brand || \"\").trim()) names.add(String(brand).trim());",
    "  });",
    "  return [...names];",
    "}",
  ].join("\n"),
  sharedSnapshotBrandAccounts: [
    "async function sharedSnapshotBrandAccounts(accountIds, { actionId = null, getAttemptState = defaultGetCatalogAttemptState } = {}) {",
    "  const selectorByKey = new Map();    // SELECTOR list (canonical key -> display): catalog(complete) UNION sales (+ fallbacks); never pins",
    "  const perAccountSales = [];         // MEMBERSHIP evidence: [{accountId, salesBrands}] -> buildBrandAccountMembership (canonical-key based)",
    "  const salesMeta = [];               // fingerprint parts: [{accountId, updatedAt, paramsHash}] over the latest brand-sales identity per account",
    "  const coveredAccountIds = new Set();",
    "  const catalogPendingAccountIds = new Set();",
    "  const catalogUnavailable = new Map();",
    "  // Accounts whose latest attempt under THIS action did not succeed -- whether their brand",
    "  // map is a preserved last-known-good (\"complete\") or absent. Their typed code must appear",
    "  // in the cumulative summary even after later continuations reread them, and it is read",
    "  // from the SEPARATE per-(action,account) attempt row so overlapping actions never clobber",
    "  // each other's summaries.",
    "  const catalogActionFailures = new Map();",
    "  const addSelector = (entries) => { for (const e of (entries || [])) if (e && e.key && !selectorByKey.has(e.key)) selectorByKey.set(e.key, e.display); };",
    "  const finalise = () => ({",
    "    membership: buildBrandAccountMembership(perAccountSales),",
    "    selectorEntries: [...selectorByKey.entries()].map(([key, display]) => ({ key, display })),",
    "    fingerprint: membershipFingerprint(salesMeta),",
    "    coveredAccountIds, catalogPendingAccountIds, catalogUnavailable, catalogActionFailures,",
    "  });",
    "  if (!isSupabaseConfigured()) return finalise();",
    "",
    "  // MEMBERSHIP follows the CURRENT sales evidence (latest validated brand-sales), so it matches the figures and",
    "  // never drops a selling account (nor pins a catalog-only, zero-sale account). The complete catalog still",
    "  // supplies the SELECTOR list (zero-sale brands), and other reports keep the selector recoverable while an",
    "  // account waits for its one-time catalog sync -- but only brand-sales pins membership.",
    "  // MEMBERSHIP is CURRENT-PRIMARY only: a dd-secondary (\"conn:uuid\") id can never pin a brand's account set.",
    "  await Promise.all(primaryAccountIdsOnly(accountIds).map(async (accountId) => {",
    "    const id = String(accountId);",
    "    const catalogSnapshot = await getLatestReportSnapshotHydrated({ reportKey: BRAND_CATALOG_REPORT_KEY, accountId });",
    "    const payload = catalogSnapshot?.payload;",
    "    const catalogStatus = payload?.catalogSyncStatus;",
    "    const catalogBrands = snapshotBrandNames(payload);",
    "    // A non-successful attempt under THIS action is surfaced separately so it is never lost",
    "    // across continuation batches. Read from the durable attempt row (scoped by action +",
    "    // account); typed safe codes only, never a raw DataDoe body.",
    "    if (actionId) {",
    "      const attempt = await Promise.resolve(getAttemptState(id, actionId)).catch(() => null);",
    "      if (attempt && attempt.status && attempt.status !== \"complete\") {",
    "        const attemptCode = String(attempt.code || \"\");",
    "        catalogActionFailures.set(id, SAFE_CATALOG_CODES.has(attemptCode)",
    "          ? attemptCode",
    "          : (attempt.status === \"attempting\" ? CATALOG_ATTEMPT_PENDING : CATALOG_SOURCE_UNAVAILABLE));",
    "      }",
    "    }",
    "",
    "    // (1) MEMBERSHIP: the latest validated brand-sales snapshot ONLY, hydrated STORAGE-FIRST so a large out-of-line",
    "    // payload never silently drops its account. An account is a member of a brand iff its current brand-sales",
    "    // contains it (canonical-key matched). Its snapshot identity feeds the self-heal fingerprint.",
    "    const salesSnapshot = await getLatestReportSnapshotHydrated({ reportKey: BRAND_SALES_REPORT_KEY, accountId });",
    "    const salesBrands = snapshotBrandNames(salesSnapshot?.payload);",
    "    perAccountSales.push({ accountId: id, salesBrands });",
    "    if (salesSnapshot) salesMeta.push({ accountId: id, updatedAt: String(salesSnapshot.updated_at || salesSnapshot.source_refreshed_at || \"\"), paramsHash: String(salesSnapshot.params_hash || \"\") });",
    "",
    "    // (2) SELECTOR list only: a complete catalog contributes its (zero-sale-inclusive) brands, unioned with",
    "    // brand-sales. Selector brands NEVER pin membership.",
    "    addSelector(selectorBrandsForAccount({ catalogStatus, catalogBrands, salesBrands }));",
    "",
    "    if (catalogStatus === \"complete\") { coveredAccountIds.add(id); return; }",
    "    if (catalogStatus === \"unavailable\") {",
    "      // Only a typed, admin-safe code is carried forward. Any legacy raw `catalogSyncError` on an older snapshot",
    "      // is IGNORED (never surfaced): unknown codes normalise to the generic source-unavailable code.",
    "      const rawCode = String(payload?.catalogSyncCode || \"\");",
    "      catalogUnavailable.set(id, SAFE_CATALOG_CODES.has(rawCode) ? rawCode : CATALOG_SOURCE_UNAVAILABLE);",
    "    } else {",
    "      catalogPendingAccountIds.add(id);",
    "    }",
    "    if (salesBrands.length) { coveredAccountIds.add(id); return; }",
    "",
    "    // No complete catalog and no brand-sales: recover the SELECTOR list from other report snapshots (fba-plan,",
    "    // sku-pl, ...). This never pins membership -- brand-sales is the only membership authority.",
    "    for (const reportKey of BRAND_DIRECTORY_SNAPSHOT_KEYS.slice(2)) {",
    "      const snapshot = await getLatestReportSnapshotHydrated({ reportKey, accountId });",
    "      const brands = snapshotBrandNames(snapshot?.payload);",
    "      if (brands.length) {",
    "        addSelector(brands.map((b) => ({ key: brandKey(b), display: brandDisplay(b) })).filter((e) => e.key));",
    "        coveredAccountIds.add(id);",
    "        break;",
    "      }",
    "    }",
    "  }));",
    "  return finalise();",
    "}",
  ].join("\n"),
  campaignMappingsReader: [
    "function campaignMappingsReader() {",
    "  const fp = primaryOrgFingerprintOrNull();",
    "  return async ({ accountId }) => (fp ? getCampaignBrandMappings({ organizationFingerprint: fp, connectionId: \"primary\", accountId }).catch(() => []) : []);",
    "}",
  ].join("\n"),
  brandViewDepFingerprintReaders: [
    "function brandViewDepFingerprintReaders() {",
    "  const fp = primaryOrgFingerprintOrNull();",
    "  const mappings = campaignMappingsReader();",
    "  return {",
    "    getSnapshotMeta: ({ reportKey, accountId }) => getLatestReportSnapshotMeta({ reportKey, accountId }).catch(() => null),",
    "    getAdsCoverage: (accountId) => getDailyAdsCoverage(accountId, ACTIVE_ADS_SOURCE_KEY).catch(() => null),",
    "    getMappingRev: async (accountId) => campaignMappingRevision(await mappings({ accountId }).catch(() => [])),",
    "    getCatalogValidatedAt: async () => {",
    "      if (!fp) return null;",
    "      const read = await getSourceSnapshot({ organizationFingerprint: fp, connectionId: \"primary\", sourceKey: \"product-catalog\", scopeKey: \"__organization\" }).catch(() => null);",
    "      const ptr = read && typeof read === \"object\" && \"snapshot\" in read ? read.snapshot : read;",
    "      return (ptr && (ptr.validated_at || ptr.payload_sha)) || null;",
    "    },",
    "    // Round-4 Defect 2: fingerprint the SELECTED authoritative compact (available LKG the builder serves), NOT the",
    "    // latest brand-inventory row -- so a selected-row change flips the serve fingerprint even when the latest",
    "    // placeholder is unchanged. Identical selection to the materializer => writer + serve agree.",
    "    getInventorySelected: (accountId) => getInventorySnapshotCandidates({ reportKey: BRAND_INVENTORY_SNAPSHOT_KEY, accountId, reportVersion: BRAND_INVENTORY_REPORT_VERSION })",
    "      .then((rows) => selectAuthoritativeInventorySnapshot(rows)).catch(() => null),",
    "  };",
    "}",
  ].join("\n"),
  serveSelfHealingSkuMovement: [
    "async function serveSelfHealingSkuMovement({ res, legacyShared, accountScope, connections, userScope = null }) {",
    "  const { reportKey, reportVersion, accountId, params, label } = legacyShared;",
    "  const brand = params && params.brand != null ? params.brand : \"ALL\";",
    "  const brandScope = { brand: String(brand).trim() === \"\" ? \"ALL\" : String(brand).trim() };",
    "  // BRAND-SCOPE PROJECTION (SELECTED_BRANDS users): a NAMED brand is already served by the brand-scoped derive (the",
    "  // caller forced params.brand to the permitted brand); for ALL_PERMITTED the derive serves the account payload, so",
    "  // filter its ASIN rows to the permitted brand keys. Unrestricted -> identity (byte-identical).",
    "  const scopeProject = (payload) => (userScope && userScope.restricted ? projectSkuMovementPayload(payload, userScope.permittedBrandKeys) : payload);",
    "  const primary = connections.find((c) => c && c.id === \"primary\" && String(c.apiKey || \"\").trim());",
    "  if (!accountId || !primary) {",
    "    res.status(200).json({ snapshotMissing: true, reportKey, reportVersion, accountId, message: `${label} needs the primary connection and a selected account.` });",
    "    return;",
    "  }",
    "  const orgFp = primary.organizationFingerprint || organizationFingerprint(primary.apiKey);",
    "  // The future-guard ceiling is the SERVER's UTC calendar date (never the viewer's browser clock). The real as-of is",
    "  // the account's latest PROVEN OLI date (its marketplace D-1), inherently <= this ceiling.",
    "  const ceiling = new Date().toISOString().slice(0, 10);",
    "  const readers = {",
    "    readOliHistory: getSourceOliHistoryRows, readOliCoverage: getSourceCoverageWindows,",
    "    readCatalogSnapshot: getSourceSnapshot, loadCatalogPayload: getSourceSnapshotPayload,",
    "    readOliOperationalUnits: getSourceOliOperationalUnitRows,",
    "    readOliSkuAsinResolution: getOliSkuAsinResolutionRows, readDirectory: getAccountDirectorySnapshotAccounts,",
    "  };",
    "  const augment = makeCompletenessAugment({ organizationFingerprint: orgFp, connectionId: \"primary\", read: getOliCompleteness, readUnitBreakdown: getSourceOliOperationalUnitRows, readEstimates: getSourceOliSalesEstimateRows, readCoverage: getSourceCoverageWindows });",
    "",
    "  // Manual per-(account, marketplace, ASIN) identifiers, JOINED at serve time (kept OUT of the snapshot so a",
    "  // re-derive never erases them). Account-scoped; fail-soft (any read failure -> no identifiers, report unaffected).",
    "  const identifierMap = await getSkuMovementIdentifiers({ organizationFingerprint: orgFp, connectionId: \"primary\", accountId }).catch(() => ({}));",
    "  const withIdentifiers = (payload) => {",
    "    const scoped = scopeProject(payload); // narrow to permitted brands FIRST (never attach identifiers to hidden rows)",
    "    return scoped && Array.isArray(scoped.rows)",
    "      ? { ...scoped, rows: scoped.rows.map((r) => ({ ...r, identifier: identifierMap[String(r.asin || \"\").trim().toUpperCase()] || \"\" })) }",
    "      : scoped;",
    "  };",
    "",
    "  // CHEAP freshness probe (coverage + catalog metadata only -- NO history load, NO DataDoe): the current proven",
    "  // as-of + the provenance the derive WOULD stamp. Used to decide \"serve stored\" vs \"re-derive\".",
    "  let effectiveAsOf = null;",
    "  let freshRefreshedAt = null;",
    "  try {",
    "    const cov = await getSourceCoverageWindows({ organizationFingerprint: orgFp, connectionId: \"primary\", accountId, sourceKey: SKU_MOVEMENT_OLI_SOURCE_KEY });",
    "    const oliWindows = cov && cov.read === \"ok\" ? (cov.windows || []) : [];",
    "    ({ effectiveAsOf } = skuMovementProvenDates(oliWindows, ceiling));",
    "    const catRead = await getSourceSnapshot({ organizationFingerprint: orgFp, connectionId: \"primary\", sourceKey: SKU_MOVEMENT_CATALOG_SOURCE_KEY, scopeKey: SKU_MOVEMENT_ORG_SCOPE });",
    "    const catalogSnapshot = catRead && typeof catRead === \"object\" && \"snapshot\" in catRead ? catRead.snapshot : catRead;",
    "    freshRefreshedAt = skuMovementRefreshedAt({ catalogSnapshot, effectiveAsOf });",
    "  } catch (_e) { /* fall through: treat as evidence-advanced and let the derive make the honest decision */ }",
    "",
    "  const stored = await getLatestReportSnapshotForScope({ reportKey, accountId, reportVersion, scope: brandScope }).catch(() => null);",
    "  const serveStored = async (snap, extra = {}) => {",
    "    const storedParams = snap.params && typeof snap.params === \"object\"",
    "      ? Object.fromEntries(Object.entries(snap.params).filter(([k]) => k !== \"reportVersion\"))",
    "      : params;",
    "    const paramsHash = paramsHashFor(reportVersion, storedParams);",
    "    const extraAug = await augment({ accountId, params, payload: snap.payload }).catch(() => ({}));",
    "    res.status(200).json({",
    "      ...withIdentifiers(snap.payload), reportKey, reportVersion, paramsHash,",
    "      ...(extraAug && typeof extraAug === \"object\" ? extraAug : {}),",
    "      ...extra,",
    "      snapshot: { savedAt: snap.source_refreshed_at || snap.updated_at || null, updatedAt: snap.updated_at || null, shared: true },",
    "    });",
    "  };",
    "",
    "  // Stored snapshot is CURRENT (its provenance matches the freshly-probed evidence for the SAME effectiveAsOf) ->",
    "  // serve it immediately, no re-derive, no history load.",
    "  if (stored && stored.payload && effectiveAsOf && freshRefreshedAt",
    "      && String(stored.source_refreshed_at || \"\") === String(freshRefreshedAt)",
    "      && stored.payload.effectiveAsOf === effectiveAsOf) {",
    "    await serveStored(stored);",
    "    return;",
    "  }",
    "",
    "  // PHASE 3 READ-ONLY GET: evidence advanced (or nothing stored yet) -> re-derive from saved OLI + Catalog and SERVE",
    "  // it, but NEVER lock, persist, or publish. ZERO DataDoe. The regional scheduler materializer owns the snapshot; a",
    "  // page load / reload / account-change / brand-change performs zero backend mutations. On a not-ready derive, serve",
    "  // the stored last-known-good (labelled updating) or the honest waiting state -- never a write, never a fabrication.",
    "  {",
    "    const derived = await rederiveSkuMovement({ accountId, brand, organizationFingerprint: orgFp, connectionId: \"primary\", ceiling }, readers);",
    "    if (!derived || derived.notReady || !derived.payload) {",
    "      if (stored && stored.payload) { await serveStored(stored, { updating: true }); return; }",
    "      res.status(200).json({",
    "        snapshotMissing: true, reportKey, reportVersion, accountId, waitingForScheduledData: true,",
    "        missingSources: (derived && derived.blockedBy) || [],",
    "        message: `No saved ${label} for this account yet \u2014 waiting for the scheduled data refresh.`,",
    "      });",
    "      return;",
    "    }",
    "    const publishedParams = { asOf: derived.effectiveParams.asOf, brand: brandScope.brand };",
    "    const publishedHash = paramsHashFor(reportVersion, publishedParams);",
    "    const extraAug = await augment({ accountId, params, payload: derived.payload }).catch(() => ({}));",
    "    res.status(200).json({",
    "      ...withIdentifiers(derived.payload), reportKey, reportVersion, paramsHash: publishedHash,",
    "      ...(extraAug && typeof extraAug === \"object\" ? extraAug : {}),",
    "      snapshot: { savedAt: derived.sourceRefreshedAt || null, updatedAt: null, shared: true, rederived: true, readOnly: true },",
    "    });",
    "  }",
    "}",
  ].join("\n"),
  brandViewDirectory: [
    "async function brandViewDirectory(accountId, { rebuild = false } = {}) {",
    "  const paramsHash = paramsHashFor(BRAND_VIEW_BRANDS_VERSION, { accountId });",
    "  if (!rebuild) {",
    "    const saved = await getReportSnapshot({ reportKey: BRAND_VIEW_BRANDS_REPORT_KEY, accountId, paramsHash });",
    "    if (saved?.payload) {",
    "      return {",
    "        payload: saved.payload,",
    "        savedAt: saved.source_refreshed_at || saved.updated_at || null,",
    "        shared: true,",
    "      };",
    "    }",
    "  }",
    "  // PHASE 3 READ-ONLY GET: build the directory read-only from ALREADY-DURABLE brand-source membership and return it",
    "  // WITHOUT persisting. The regional scheduler materializer owns the stored brand-view-brands snapshot; a page load or",
    "  // an explicit reload never writes. The build always reflects current brand-sales membership, so a newly-recorded",
    "  // brand still appears (from the durable evidence) without a page-open write.",
    "  const payload = await buildBrandViewBrandDirectory({ accountId, getSnapshot: getLatestReportSnapshot });",
    "  return { payload, savedAt: null, shared: false, rederived: true };",
    "}",
  ].join("\n"),
};

ok("H1 the CURRENT serve functions are extracted from api/datadoe.js; the api no longer defines snapshotBrandNames (it imports the shared module) and imports the shared factories + the SKU serve-token module",
  Object.values(NEW).every((s) => typeof s === "string" && s.length > 40) && extractFunction(API, "function snapshotBrandNames(payload)") === null
  && /import \{ snapshotBrandNames, computeBrandDirectoryMembership \} from "\.\.\/lib\/server\/reports\/brand-directory-membership\.js";/.test(API)
  && /import \{ makeBrandViewDepReaders \} from "\.\.\/lib\/server\/sync\/brand-view-dependency-readers\.js";/.test(API)
  && /computeSkuServeToken, skuServeOpunitsWindow, skuMovementStoredIsCurrent, stripStoredExtras,\s*\} from "\.\.\/lib\/server\/reports\/sku-movement-evidence\.js";/.test(API)
  && OLD_API && Object.values(OLD_API).every((s) => typeof s === "string" && s.length > 40));
const listApi = (dir = path.join(ROOT, "api"), prefix = "") => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
  ? listApi(path.join(dir, e.name), prefix + e.name + "/")
  : (e.name.endsWith(".js") ? [prefix + e.name] : []))).sort();
ok("H1 no new api/*.js function (the Vercel 12-function cap): api/ still holds exactly the 12 known entries",
  J(["access.js", "admin/sources.js", "admin/sync.js", "campaign-brand-mapping.js", "cron/[scope].js", "cron/sync.js", "datadoe.js", "fba-plan-columns.js", "fba-plan-config.js", "sku-movement-identifier.js", "sku-movement-prefs.js", "sync.js"].sort())
  === J(listApi()));

// =====================================================================================================================
// The durable SKU Movement evidence (MIRRORED from scripts/sku-movement-route.test.js makeStore: coverage, operational
// units, the org catalog pointer).
// =====================================================================================================================
const A = "acct-a-0001";
const BB = "acct-b-0002";
const KEY = "sku-movement";
const VERSION = "sku-movement/v2";
const EFF = "2026-09-23";
const EFF_B = "2026-09-22";
const NOW_MS = Date.UTC(2026, 8, 24, 6, 0, 0); // the route suite's world clock: the serve's UTC ceiling is 2026-09-24
const DIRECTORY = new Map([[A, { accountId: A, country: "IN" }], [BB, { accountId: BB, country: "IN" }]]);
function makeSkuWorld() {
  return {
    coverage: [
      { organization_fingerprint: ORG, connection_id: "primary", account_id: A, source_key: "order-line-items", covered_from: "2026-01-01", covered_to: "2026-09-23", status: "succeeded", source_refreshed_at: "2026-09-24T01:00:00.000Z", updated_at: "2026-09-24T01:00:00.000Z" },
      { organization_fingerprint: ORG, connection_id: "primary", account_id: BB, source_key: "order-line-items", covered_from: "2026-03-01", covered_to: "2026-09-22", status: "succeeded", source_refreshed_at: "2026-09-23T01:00:00.000Z", updated_at: "2026-09-23T01:00:00.000Z" },
    ],
    opunits: [
      { organization_fingerprint: ORG, connection_id: "primary", account_id: A, seller_or_vendor_id: "raw-a", sale_date: "2026-09-23", sku: "A-1", child_asin: "", currency: "INR", pending_units: 2, updated_at: "2026-09-24T01:00:00.000Z" },
    ],
    catalogPointer: { organization_fingerprint: ORG, connection_id: "primary", source_key: "product-catalog", scope_key: "__organization", object_path: "source-snapshots/product-catalog/catsha1.json", payload_sha: "catsha1", row_count: 3, payload_bytes: 10, source_request_hash: "catreq1", validated_at: "2026-09-20T00:00:00.000Z" },
    fail: { coverage: null, opunits: null },
  };
}

// The sku-movement-route.test.js wp10Serve model (MIRRORED): its OWN REST-shaped reads -> computeSkuServeToken.
function restCoverage(w, acct) {
  return w.coverage.filter((r) => r.organization_fingerprint === ORG && r.connection_id === "primary" && r.account_id === acct && r.source_key === "order-line-items" && r.status === "succeeded")
    .map((r) => ({ from: r.covered_from, to: r.covered_to, updatedAt: pgrest(r.updated_at) }));
}
function restOpunitsStats(w, acct, from, to) {
  const rows = w.opunits.filter((u) => u.organization_fingerprint === ORG && u.connection_id === "primary" && u.account_id === acct && u.sale_date >= from && u.sale_date <= to);
  const max = rows.map((u) => u.updated_at).sort().pop();
  return { windowFrom: from, windowTo: to, rows: rows.length, maxUpdatedAt: rows.length ? pgrest(max) : null };
}
function modelServe(w, acct, brandParam) {
  const brand = String(brandParam).trim() === "" ? "ALL" : String(brandParam).trim();
  const ceiling = new Date(NOW_MS).toISOString().slice(0, 10);
  const oliWindows = restCoverage(w, acct);
  const { effectiveAsOf } = RDR.skuMovementProvenDates(oliWindows, ceiling);
  const p = w.catalogPointer;
  const win = EVI.skuServeOpunitsWindow(effectiveAsOf);
  const opunits = win ? restOpunitsStats(w, acct, win.from, win.to) : null;
  return {
    brand, effectiveAsOf, provenance: RDR.skuMovementRefreshedAt({ catalogSnapshot: p, effectiveAsOf }),
    token: EVI.computeSkuServeToken({ effectiveAsOf, coverageWindows: oliWindows, catalogPayloadSha: p.payload_sha, opunits, brand }),
  };
}

// The ROUTE's stored serve token: the route's four evidence statements as Postgres returns them (to_char 'Z' instants;
// the sku_opunits window least(max(covered_to), ceiling) / monthBack 3), composed by the REAL
// composeSkuMovementScopeEvidence, then EXACTLY what sku-movement.release.js resolveBundle stamps into params.serveToken.
function routeServe(w, acct, brandParam) {
  const ceiling = new Date(NOW_MS).toISOString().slice(0, 10);
  const cov = w.coverage.filter((r) => r.organization_fingerprint === ORG && r.connection_id === "primary" && r.source_key === "order-line-items" && r.status === "succeeded" && r.account_id === acct);
  const skuCoverage = cov.map((r) => ({ account_id: r.account_id, covered_from: r.covered_from, covered_to: r.covered_to, source_refreshed_at: toUs(r.source_refreshed_at), updated_at: toUs(r.updated_at) }))
    .sort((x, y) => (x.covered_from < y.covered_from ? -1 : 1));
  const skuOpunits = [];
  if (cov.length) {
    const maxTo = cov.map((r) => r.covered_to).sort().pop();
    const eff = maxTo < ceiling ? maxTo : ceiling;
    const from = monthBackStr(eff, 3);
    const rows = w.opunits.filter((u) => u.organization_fingerprint === ORG && u.connection_id === "primary" && u.account_id === acct && u.sale_date >= from && u.sale_date <= eff);
    const maxUpd = rows.map((u) => u.updated_at).sort().pop();
    skuOpunits.push({ account_id: acct, eff_as_of: eff, window_from: from, unit_rows: rows.length, max_updated_at: maxUpd ? toUs(maxUpd) : null });
  }
  const p = w.catalogPointer;
  const rowsByName = { sku_coverage: skuCoverage, sku_opunits: skuOpunits, sku_catalog: [{ payload_sha: p.payload_sha, source_request_hash: p.source_request_hash, validated_at: toUs(p.validated_at) }], sku_brands: [] };
  const ev = SKW.composeSkuMovementScopeEvidence(rowsByName, { now: NOW_MS, organizationFingerprint: ORG, accountIds: [acct], directory: DIRECTORY }).get(acct);
  const brand = EVI.skuServeCanonicalBrand(brandParam);
  if (!ev || ev.ineligibleReason) return { brand, token: null, reason: ev ? ev.ineligibleReason : "missing" };
  return { brand, effectiveAsOf: ev.effectiveAsOf, token: EVI.computeSkuServeToken({ effectiveAsOf: ev.effectiveAsOf, coverageWindows: ev.windows, catalogPayloadSha: ev.catalog.payloadSha, opunits: ev.opunits, brand }) };
}

// A live row as the route publishes it (identity { asOf, brand }; stored-only extras; stamped at the cycle) and a LEGACY
// materializer row (params { reportVersion, asOf, brand } only).
const routeRow = (acct, brand, eff, serveToken, extra = {}) => ({
  id: "live-" + acct + "-" + brand, report_key: KEY, account_id: acct, params_hash: paramsHashFor(VERSION, { asOf: eff, brand }),
  params: { reportVersion: VERSION, asOf: eff, brand, evidenceToken: "sm1:" + "e".repeat(64), serveToken, manifestToken: "smm1:" + "f".repeat(64), ...extra },
  payload: { effectiveAsOf: eff, rows: [{ asin: "B0ACME1", dailyUnits: { [eff]: 3 } }], brandFiltered: brand !== "ALL" },
  payload_storage_path: null, source_refreshed_at: "2026-09-24T06:00:00.000Z", updated_at: "2026-09-24T06:00:01.000Z",
});
const legacyRow = (acct, brand, eff, sra) => ({
  id: "legacy-" + acct + "-" + brand, report_key: KEY, account_id: acct, params_hash: paramsHashFor(VERSION, { asOf: eff, brand }),
  params: { reportVersion: VERSION, asOf: eff, brand }, payload: { effectiveAsOf: eff, rows: [{ asin: "B0ACME1", dailyUnits: { [eff]: 3 } }], brandFiltered: brand !== "ALL" },
  payload_storage_path: null, source_refreshed_at: sra, updated_at: "2026-09-24T00:00:01.000Z",
});

// The serve under test (the CURRENT extracted one, or the PRE-WP10 one) over injected readers: the coverage + stats reads
// are the REAL supabase.js readers (through the PostgREST emulator); the catalog pointer, the stored row, identifiers,
// the completeness augment and the read-only re-derive are fakes (the re-derive is a recording stub).
class FixedDate extends Date {
  constructor(...a) { if (a.length === 0) super(NOW_MS); else super(...a); }
  static now() { return NOW_MS; }
}
const refuse = (name) => async () => { throw new Error("unexpected reader call: " + name); };
async function runSkuServe(kind, { acct, brand, stored }) {
  const captured = []; const rederived = []; const readLog = [];
  const scope = {
    projectSkuMovementPayload: (p) => p, organizationFingerprint: () => ORG,
    getSourceOliHistoryRows: refuse("getSourceOliHistoryRows"), getSourceCoverageWindows: SB.getSourceCoverageWindows,
    getSourceSnapshot: async (args) => { readLog.push("catalog:" + args.sourceKey + ":" + args.scopeKey); return { snapshot: clone(world.catalogPointer), read: "ok", error: null }; },
    getSourceSnapshotPayload: refuse("getSourceSnapshotPayload"), getSourceOliOperationalUnitRows: refuse("getSourceOliOperationalUnitRows"),
    getOliSkuAsinResolutionRows: refuse("getOliSkuAsinResolutionRows"), getAccountDirectorySnapshotAccounts: refuse("getAccountDirectorySnapshotAccounts"),
    makeCompletenessAugment: () => async () => ({ completeness: { state: "final" } }), getOliCompleteness: refuse("getOliCompleteness"),
    getSourceOliSalesEstimateRows: refuse("getSourceOliSalesEstimateRows"),
    getSkuMovementIdentifiers: async () => ({ B0ACME1: "ID-1" }),
    SKU_MOVEMENT_OLI_SOURCE_KEY: apiConst("SKU_MOVEMENT_OLI_SOURCE_KEY"), SKU_MOVEMENT_CATALOG_SOURCE_KEY: apiConst("SKU_MOVEMENT_CATALOG_SOURCE_KEY"),
    SKU_MOVEMENT_ORG_SCOPE: apiConst("SKU_MOVEMENT_ORG_SCOPE"),
    skuMovementProvenDates: RDR.skuMovementProvenDates, skuMovementRefreshedAt: RDR.skuMovementRefreshedAt,
    getLatestReportSnapshotForScope: async (args) => { readLog.push("stored:" + args.reportKey + ":" + args.reportVersion + ":" + J(args.scope)); return stored ? clone(stored) : null; },
    skuServeOpunitsWindow: EVI.skuServeOpunitsWindow, getSourceOliOperationalUnitStats: SB.getSourceOliOperationalUnitStats,
    computeSkuServeToken: EVI.computeSkuServeToken, paramsHashFor, stripStoredExtras: EVI.stripStoredExtras,
    skuMovementStoredIsCurrent: (a) => { captured.push(a.serveToken); return EVI.skuMovementStoredIsCurrent(a); },
    rederiveSkuMovement: async (args) => {
      rederived.push({ accountId: args.accountId, brand: args.brand, ceiling: args.ceiling });
      const b = EVI.skuServeCanonicalBrand(args.brand);
      return { payload: { effectiveAsOf: EFF, rows: [{ asin: "B0RDRV", dailyUnits: {} }], brandFiltered: b !== "ALL" }, effectiveParams: { asOf: EFF, brand: b }, sourceRefreshedAt: "2026-09-24T05:00:00.000Z" };
    },
    Date: FixedDate,
  };
  const body = kind === "old" ? OLD_API.serveSelfHealingSkuMovement : NEW.serveSelfHealingSkuMovement;
  const serve = compileApi(body, scope, "serveSelfHealingSkuMovement");
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(x) { this.body = x; return this; } };
  const n0 = net.calls.length;
  await serve({
    res, legacyShared: { reportKey: KEY, reportVersion: VERSION, accountId: acct, params: { brand }, label: "SKU Movement" },
    accountScope: { accountIds: [acct] }, connections: [{ id: "primary", apiKey: "k", organizationFingerprint: ORG }], userScope: null,
  });
  const calls = net.calls.slice(n0);
  return {
    res, captured, rederived, readLog, calls,
    statsCalls: calls.filter((c) => c.includes("/rest/v1/source_oli_operational_units")).length,
    servedStored: rederived.length === 0 && !!(res.body && res.body.snapshot && !res.body.snapshot.rederived && !res.body.updating),
  };
}

// =====================================================================================================================
// R. the supabase.js readers
// =====================================================================================================================
{
  world = makeSkuWorld();
  let n0 = net.calls.length;
  const cov = await SB.getSourceCoverageWindows({ organizationFingerprint: ORG, connectionId: "primary", accountId: A, sourceKey: "order-line-items" });
  const c0 = net.calls[n0] || "";
  ok("R1 getSourceCoverageWindows selects covered_from,covered_to,updated_at (status=succeeded + order covered_from.asc unchanged) and maps each row to { from, to, updatedAt } (PostgREST text, untouched)",
    cov.read === "ok" && J(cov.windows) === J([{ from: "2026-01-01", to: "2026-09-23", updatedAt: "2026-09-24T01:00:00+00:00" }])
    && /select=covered_from%2Ccovered_to%2Cupdated_at(&|$)/.test(c0) && /status=eq\.succeeded/.test(c0) && /order=covered_from\.asc/.test(c0) && /account_id=eq\.acct-a-0001/.test(c0));
  world.fail.coverage = true;
  const bad = await SB.getSourceCoverageWindows({ organizationFingerprint: ORG, connectionId: "primary", accountId: A, sourceKey: "order-line-items" });
  world.fail.coverage = null;
  ok("R1 ... a failed read keeps its typed shape ({ windows: [], read: 'read-failed' })", bad.read === "read-failed" && J(bad.windows) === "[]" && bad.error === "SOURCE_COVERAGE_READ_FAILED");

  const win = EVI.skuServeOpunitsWindow(EFF);
  n0 = net.calls.length;
  const st = await SB.getSourceOliOperationalUnitStats({ organizationFingerprint: ORG, connectionId: "primary", accountId: A, from: win.from, to: win.to });
  const c1 = net.calls[n0] || ""; const h1 = net.headers[n0] || {};
  ok("R2 getSourceOliOperationalUnitStats: ONE read-only GET (select=updated_at, order=updated_at.desc, limit=1, sale_date gte AND lte, org / connection / account eq) with Prefer: count=exact -> EXACTLY the wp10Serve model's { windowFrom, windowTo, rows, maxUpdatedAt }",
    net.calls.length - n0 === 1 && /^GET \/rest\/v1\/source_oli_operational_units\?/.test(c1) && /select=updated_at(&|$)/.test(c1) && /order=updated_at\.desc/.test(c1) && /limit=1(&|$)/.test(c1)
    && /sale_date=gte\.2026-06-01/.test(c1) && /sale_date=lte\.2026-09-23/.test(c1) && /organization_fingerprint=eq\.org-fp-test/.test(c1) && /connection_id=eq\.primary/.test(c1) && /account_id=eq\.acct-a-0001/.test(c1)
    && h1.Prefer === "count=exact" && !/additive|explicit_zero|pending/.test(c1)
    && J(st) === J(restOpunitsStats(world, A, win.from, win.to)) && st.rows === 1 && st.maxUpdatedAt === "2026-09-24T01:00:00+00:00");
  world.opunits.push({ ...world.opunits[0], sku: "C-1", updated_at: "2026-09-24T09:30:00.123Z" }, { ...world.opunits[0], sku: "OLD", sale_date: "2026-05-31", updated_at: "2026-09-25T00:00:00.000Z" });
  const st2 = await SB.getSourceOliOperationalUnitStats({ organizationFingerprint: ORG, accountId: A, from: win.from, to: win.to });
  ok("R2 ... several rows (a PostgREST 206 partial page): the EXACT total from Content-Range + the newest updated_at inside the window (a row outside the window is not counted)",
    st2.rows === 2 && st2.maxUpdatedAt === "2026-09-24T09:30:00.123+00:00" && J(st2) === J(restOpunitsStats(world, A, win.from, win.to)));
  const st0 = await SB.getSourceOliOperationalUnitStats({ organizationFingerprint: ORG, accountId: BB, from: "2026-06-01", to: EFF_B });
  ok("R2 ... ZERO rows ('*/0'): { rows: 0, maxUpdatedAt: null } (a token-valid empty window)", J(st0) === J({ windowFrom: "2026-06-01", windowTo: EFF_B, rows: 0, maxUpdatedAt: null }));
  const throwsWith = async (fail, args = { organizationFingerprint: ORG, accountId: A, from: win.from, to: win.to }) => {
    world.fail.opunits = fail;
    try { await SB.getSourceOliOperationalUnitStats(args); return null; } catch (e) { return e; } finally { world.fail.opunits = null; }
  };
  const eMissing = await throwsWith("no-range"); const eMismatch = await throwsWith("mismatch"); const e404 = await throwsWith("http404");
  ok("R3 fail closed: an absent exact total, a total that disagrees with the returned row, or a non-2xx (a missing table) THROWS (never a guessed count)",
    eMissing && eMissing.code === "OLI_OPUNITS_STATS_UNREADABLE" && eMismatch && eMismatch.code === "OLI_OPUNITS_STATS_UNREADABLE" && e404 && e404.status === 404 && e404.code === "PGRST205");
  n0 = net.calls.length;
  const argErrs = await Promise.all([
    { accountId: A, from: win.from, to: win.to }, { organizationFingerprint: ORG, accountId: " ", from: win.from, to: win.to },
    { organizationFingerprint: ORG, accountId: A, from: "2026-6-1", to: win.to }, { organizationFingerprint: ORG, accountId: A, from: win.to, to: win.from },
  ].map((a) => SB.getSourceOliOperationalUnitStats(a).then(() => null, (e) => e)));
  ok("R3 ... a malformed argument (no org, a blank account, a non-date, from > to) throws with ZERO network", argErrs.every((e) => e instanceof Error) && net.calls.length === n0);
  ok("R4 the stats reader is a GET-only reader: its source never issues a write verb or an RPC",
    (() => { const b = extractFunction(src("lib/server/supabase.js"), "export async function getSourceOliOperationalUnitStats("); return !!b && /method: "GET"/.test(b) && !/POST|PATCH|DELETE|\/rpc\//.test(b); })());
}

// =====================================================================================================================
// K. the ADDITIVE updatedAt is ignored by every pure coverage consumer
// =====================================================================================================================
{
  const plain = [{ from: "2026-01-01", to: "2026-05-01" }, { from: "2026-05-02", to: "2026-09-23" }, { from: "2026-09-25", to: "2026-09-25" }];
  const stamped = plain.map((w, i) => ({ ...w, updatedAt: "2026-09-24T0" + i + ":00:00+00:00" }));
  const checks = {
    mergeCoverageWindows: (w) => SDM.mergeCoverageWindows(w),
    windowsProve: (w) => [SDM.windowsProve(w, "2026-02-01", "2026-09-23"), SDM.windowsProve(w, "2026-02-01", "2026-09-25")],
    missingCoverageWindows: (w) => SDM.missingCoverageWindows(w, "2026-01-01", "2026-09-30"),
    resolveEffectivePublishAsOf: (w) => SDM.resolveEffectivePublishAsOf({ coverageByAccountId: { X: w }, accountIds: ["X"], from: "2026-01-01", refreshAsOf: "2026-09-24" }),
    latestProvenDailyTo: (w) => DDR.latestProvenDailyTo({ oliWindows: w, from: "2026-03-01", ceiling: "2026-09-30" }),
    skuMovementProvenDates: (w) => RDR.skuMovementProvenDates(w, "2026-09-24"),
    oliCoverageProvesWindow: (w) => [FPL.oliCoverageProvesWindow(w, "2026-02-01", "2026-09-23"), FPL.oliCoverageProvesWindow(w, "2026-02-01", "2026-09-24")],
    normalizeCoverageWindows: (w) => LHL.normalizeCoverageWindows(w),
  };
  const diffs = Object.entries(checks).filter(([, f]) => J(f(plain)) !== J(f(stamped))).map(([k]) => k);
  ok("K1 every pure coverage consumer (merge / prove / gaps / publish as-of / Daily horizon / SKU proven dates / FBA proof / LHv3 normalize) returns BYTE-IDENTICAL output with or without the additive updatedAt: " + (diffs.join(",") || "none differ"),
    diffs.length === 0 && J(checks.mergeCoverageWindows(stamped)) === J([{ from: "2026-01-01", to: "2026-09-23" }, { from: "2026-09-25", to: "2026-09-25" }]));
}

// =====================================================================================================================
// S. SKU Movement serve-token PARITY: serve == route == wp10Serve model (S6 cases, T4, T5)
// =====================================================================================================================
{
  world = makeSkuWorld();
  const cases = [[A, "ALL", EFF], [A, "Acme", EFF], [A, "Caruso Italy", EFF], [BB, "ALL", EFF_B], [A, "", EFF]];
  const results = [];
  for (const [acct, brand, eff] of cases) {
    const route = routeServe(world, acct, brand);
    const model = modelServe(world, acct, brand);
    const run = await runSkuServe("new", { acct, brand, stored: routeRow(acct, route.brand, eff, route.token) });
    results.push({ acct, brand, eff, route, model, run });
  }
  ok("S6 serve-token PARITY: for every published unit (A ALL / Acme / Caruso Italy, BB ALL, A blank -> ALL) the REAL serve's token (its REST reads, PostgREST '+00:00' instants) == the route's stored serveToken (its SQL evidence, to_char 'Z' instants, composeSkuMovementScopeEvidence) == the wp10Serve model's",
    results.every((r) => /^sms2:[0-9a-f]{64}$/.test(r.route.token) && r.route.token === r.model.token && J(r.run.captured) === J([r.route.token]) && r.route.effectiveAsOf === r.eff && r.model.effectiveAsOf === r.eff)
    && new Set(results.slice(0, 4).map((r) => r.route.token)).size === 4 && results[4].route.token === results[0].route.token);
  ok("S6 ... so the serve SERVES the stored route row (no re-derive) with the CANONICAL response paramsHash paramsHashFor(version, { asOf, brand })",
    results.every((r) => r.run.servedStored && r.run.res.statusCode === 200 && r.run.res.body.paramsHash === paramsHashFor(VERSION, { asOf: r.eff, brand: r.route.brand }) && r.run.statsCalls === 1
      && r.run.res.body.rows[0].identifier === "ID-1" && r.run.res.body.completeness && r.run.res.body.snapshot.shared === true));
  const oldOnRoute = await runSkuServe("old", { acct: A, brand: "ALL", stored: routeRow(A, "ALL", EFF, results[0].route.token) });
  ok("S6 (why WP10 must deploy first) the PRE-WP10 serve re-derives the SAME route row read-only (its legacy predicate compares the cycle stamp with the catalog/effectiveAsOf provenance)",
    oldOnRoute.rederived.length === 1 && oldOnRoute.res.body.snapshot.rederived === true && oldOnRoute.statsCalls === 0);

  // T4: a same-effectiveAsOf OLI correction (coverage updated_at re-acknowledged) moves serve == route == model.
  const t0 = results[0].route.token;
  Object.assign(world.coverage[0], { source_refreshed_at: "2026-09-24T07:00:00.000Z", updated_at: "2026-09-24T07:00:00.000Z" });
  const r4 = routeServe(world, A, "ALL"); const m4 = modelServe(world, A, "ALL");
  const stale4 = await runSkuServe("new", { acct: A, brand: "ALL", stored: routeRow(A, "ALL", EFF, t0) });
  const fresh4 = await runSkuServe("new", { acct: A, brand: "ALL", stored: routeRow(A, "ALL", EFF, r4.token) });
  ok("T4 a same-effectiveAsOf OLI correction moves the token IDENTICALLY on all three sides; the serve no longer serves the older row (read-only re-derive) and serves the republished one",
    r4.token !== t0 && r4.token === m4.token && r4.effectiveAsOf === EFF && J(stale4.captured) === J([r4.token]) && stale4.rederived.length === 1 && stale4.res.body.snapshot.readOnly === true
    && fresh4.servedStored && J(fresh4.captured) === J([r4.token]));
  // T5: a standalone operational-units backfill (count) and a same-count rewrite (max(updated_at) only).
  const tC0 = routeServe(world, A, "Caruso Italy").token;
  world.opunits.push({ ...world.opunits[0], sku: "C-1", child_asin: "B0CARU1", pending_units: 4, updated_at: "2026-09-24T09:00:00.000Z" });
  const r5 = routeServe(world, A, "Caruso Italy"); const m5 = modelServe(world, A, "Caruso Italy");
  const stale5 = await runSkuServe("new", { acct: A, brand: "Caruso Italy", stored: routeRow(A, "Caruso Italy", EFF, tC0) });
  world.opunits[world.opunits.length - 1].updated_at = "2026-09-24T09:30:00.000Z";
  const r6 = routeServe(world, A, "Caruso Italy"); const m6 = modelServe(world, A, "Caruso Italy");
  const stale6 = await runSkuServe("new", { acct: A, brand: "Caruso Italy", stored: routeRow(A, "Caruso Italy", EFF, r5.token) });
  const fresh6 = await runSkuServe("new", { acct: A, brand: "Caruso Italy", stored: routeRow(A, "Caruso Italy", EFF, r6.token) });
  ok("T5 an operational-units backfill (count) and a same-count rewrite (only max(updated_at)) each move the token IDENTICALLY on all three sides; the serve re-derives the older row and serves the current one",
    r5.token !== tC0 && r5.token === m5.token && r6.token !== r5.token && r6.token === m6.token
    && J(stale5.captured) === J([r5.token]) && stale5.rederived.length === 1 && J(stale6.captured) === J([r6.token]) && stale6.rederived.length === 1 && fresh6.servedStored);
}

// =====================================================================================================================
// P. the serve predicate + response identity; LEGACY rows unchanged byte-for-byte with ZERO extra reads
// =====================================================================================================================
{
  world = makeSkuWorld();
  const tok = routeServe(world, A, "ALL").token;
  const prov = modelServe(world, A, "ALL").provenance;
  const mismatch = await runSkuServe("new", { acct: A, brand: "ALL", stored: routeRow(A, "ALL", EFF, "sms2:" + "0".repeat(64)) });
  ok("P1 a route row whose 'sms2:' token does NOT equal the recomputed one re-derives READ-ONLY (rederived + readOnly, the stored row is not served)",
    J(mismatch.captured) === J([tok]) && mismatch.rederived.length === 1 && mismatch.res.body.snapshot.rederived === true && mismatch.res.body.snapshot.readOnly === true && mismatch.res.body.rows[0].asin === "B0RDRV");
  const sms1Row = { ...routeRow(A, "ALL", EFF, "sms1:" + "a".repeat(64)), source_refreshed_at: prov };
  const sms1 = await runSkuServe("new", { acct: A, brand: "ALL", stored: sms1Row });
  const sms1Old = await runSkuServe("old", { acct: A, brand: "ALL", stored: sms1Row });
  ok("P2 a retired 'sms1:' route row is NEVER current -- even when its stamp equals the legacy provenance (which the pre-WP10 serve WOULD have served)",
    sms1.rederived.length === 1 && sms1Old.servedStored === true && prov === "2026-09-23T00:00:00.000Z");
  const blank = await runSkuServe("new", { acct: A, brand: "ALL", stored: { ...routeRow(A, "ALL", EFF, ""), source_refreshed_at: prov } });
  const nul = await runSkuServe("new", { acct: A, brand: "ALL", stored: { ...routeRow(A, "ALL", EFF, null), source_refreshed_at: prov } });
  ok("P2 a present-but-blank / null serveToken is never current (it never falls back to the legacy predicate)", blank.rederived.length === 1 && nul.rederived.length === 1);
  const statFail = [];
  for (const f of ["http404", "no-range", "mismatch"]) {
    world.fail.opunits = f;
    statFail.push(await runSkuServe("new", { acct: A, brand: "ALL", stored: routeRow(A, "ALL", EFF, tok) }));
  }
  world.fail.opunits = null;
  ok("P3 a FAILED operational-units stats read (missing table / no exact total / an inconsistent total) is NO token -> the correct route row is NOT served (read-only re-derive), never a guessed token",
    statFail.every((r) => J(r.captured) === J([null]) && r.rederived.length === 1 && r.statsCalls === 1));
  world.fail.coverage = true;
  const covFail = await runSkuServe("new", { acct: A, brand: "ALL", stored: routeRow(A, "ALL", EFF, tok) });
  world.fail.coverage = null;
  ok("P3 an unreadable coverage read -> no effectiveAsOf -> no stats read, no token -> re-derive", J(covFail.captured) === J([null]) && covFail.statsCalls === 0 && covFail.rederived.length === 1);

  // Stored extras never leak into the response identity.
  const withExtras = await runSkuServe("new", { acct: A, brand: "ALL", stored: routeRow(A, "ALL", EFF, tok, { depFingerprint: "d".repeat(40) }) });
  const extrasParams = routeRow(A, "ALL", EFF, tok, { depFingerprint: "d".repeat(40) }).params;
  const oldExpr = paramsHashFor(VERSION, Object.fromEntries(Object.entries(extrasParams).filter(([k]) => k !== "reportVersion")));
  ok("P4 a route row with stored extras (evidenceToken / serveToken / manifestToken / depFingerprint) is served with paramsHash == paramsHashFor(version, { asOf, brand }) (the pre-WP10 expression would have hashed the extras in)",
    withExtras.servedStored && withExtras.res.body.paramsHash === paramsHashFor(VERSION, { asOf: EFF, brand: "ALL" }) && oldExpr !== withExtras.res.body.paramsHash
    && J(EVI.stripStoredExtras(extrasParams)) === J({ asOf: EFF, brand: "ALL" }));

  // LEGACY rows: the pre-route predicate verbatim, the pre-WP10 response byte-for-byte, and ZERO stats reads.
  const legacyCases = [
    ["current (stamp == provenance)", { acct: A, brand: "ALL", stored: legacyRow(A, "ALL", EFF, prov) }, null],
    ["named brand current", { acct: A, brand: "Acme", stored: legacyRow(A, "Acme", EFF, prov) }, null],
    ["stale stamp", { acct: A, brand: "ALL", stored: legacyRow(A, "ALL", EFF, "2026-09-22T00:00:00.000Z") }, null],
    ["older effectiveAsOf", { acct: A, brand: "ALL", stored: legacyRow(A, "ALL", "2026-09-22", prov) }, null],
    ["nothing stored", { acct: A, brand: "ALL", stored: null }, null],
    ["coverage unreadable", { acct: A, brand: "ALL", stored: legacyRow(A, "ALL", EFF, prov) }, "coverage"],
  ];
  const legacy = [];
  for (const [label, args, fail] of legacyCases) {
    if (fail === "coverage") world.fail.coverage = true;
    const now = await runSkuServe("new", args);
    const before = await runSkuServe("old", args);
    world.fail.coverage = null;
    legacy.push({ label, now, before });
  }
  const sameResp = (x) => x.now.res.statusCode === x.before.res.statusCode && J(x.now.res.body) === J(x.before.res.body) && J(x.now.rederived) === J(x.before.rederived) && J(x.now.readLog) === J(x.before.readLog) && J(x.now.calls) === J(x.before.calls);
  ok("P5 LEGACY rows (no serveToken): the response, the re-derive decision, every reader call and every REST request are BYTE-IDENTICAL to the pre-WP10 serve (" + legacy.map((x) => x.label).join(" / ") + "), with ZERO operational-units stats reads",
    legacy.every(sameResp) && legacy.every((x) => x.now.statsCalls === 0 && J(x.now.captured) === J([null]))
    && legacy[0].now.servedStored && legacy[1].now.servedStored && legacy[2].now.rederived.length === 1 && legacy[3].now.rederived.length === 1 && legacy[5].now.rederived.length === 1);
  ok("P6 the serve stays READ-ONLY: its source names no snapshot write / lock / publish and no DataDoe transport",
    !/\b(saveReportSnapshot|claimRefreshLock|releaseRefreshLock|publishSnapshotUpdate|insertReportSnapshotIfAbsent|casUpdateReportSnapshotByRev|createExport|ddFetch|fetchExportRows)\s*\(/.test(NEW.serveSelfHealingSkuMovement));
}

// =====================================================================================================================
// M. sharedSnapshotBrandAccounts: the shared membership module, byte-identical to the pre-WP10 serve
// =====================================================================================================================
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const U4 = "44444444-4444-4444-8444-444444444444";
const U5 = "55555555-5555-4555-8555-555555555555";
const U6 = "66666666-6666-4666-8666-666666666666";
const DDS = "dd-secondary:77777777-7777-4777-8777-777777777777";
const salesRows = (brands, field = "product_brand") => brands.map((b, i) => ({ date: "2026-09-2" + (i % 3), [field]: b, total_sales: 10 + i }));
function membershipWorld() {
  const rows = new Map(); const storage = new Map(); const log = [];
  const put = (rk, acct, payload, extra = {}) => rows.set(rk + "|" + acct, { id: rk + "@" + acct, report_key: rk, account_id: acct, params_hash: "h-" + rk + "-" + acct, params: { reportVersion: rk + "-v1" }, payload, payload_storage_path: null, source_refreshed_at: "2026-09-24T01:00:00.000Z", updated_at: "2026-09-24T01:00:0" + (rows.size % 10) + ".000Z", ...extra });
  put("brand-catalog", U1, { catalogSyncStatus: "complete", catalogBrands: ["Acme", "Zeta", "Omega"] });
  put("brand-sales", U1, { rows: salesRows(["Acme", "Unassigned", "Acme"]) });
  put("brand-sales", U2, null, { payload_storage_path: "obj/U2/brand-sales.json" }); // OUT-OF-LINE (hydrated storage-first)
  storage.set("obj/U2/brand-sales.json", { rows: salesRows(["ACME", "Beta"]) });
  put("fba-plan", U3, { rows: salesRows(["Gamma"], "brand") }); // still loading: no brand-sales, no catalog -> selector fallback only
  put("brand-catalog", U4, { catalogSyncStatus: "unavailable", catalogSyncCode: "PRODUCT_CATALOG_EMPTY" });
  put("brand-sales", U4, { rows: salesRows(["acme ", " Delta"]) }); // unknown country (ZZ); case / whitespace variants
  put("brand-catalog", U5, { catalogSyncStatus: "unavailable", catalogSyncCode: "RAW_DATADOE_BODY {secret}" }); // inactive / settingUp
  put("brand-sales", U5, { rows: salesRows(["Delta"]) });
  put("brand-sales", U6, { catalogBrands: ["Kappa", " "], rows: salesRows(["Lambda"], "brand") });
  put("brand-sales", DDS, { rows: salesRows(["Omega"]) }); // a dd-secondary id never pins membership
  put("sku-pl", U3, { rows: salesRows(["Gamma2"], "brand") });
  const readLatest = async ({ reportKey, accountId }) => { log.push("latest:" + reportKey + ":" + accountId); return clone(rows.get(reportKey + "|" + accountId) || null); };
  const readStorage = async (p) => { log.push("storage:" + p); return storage.has(p) ? clone(storage.get(p)) : null; };
  return { rows, storage, log, hydrated: (args) => SB.getLatestReportSnapshotHydrated(args, { readLatest, readStorage }) };
}
const SAFE_CODES = new Set(["PRODUCT_CATALOG_SOURCE_UNAVAILABLE", "PRODUCT_CATALOG_EMPTY", "PRODUCT_CATALOG_ATTEMPT_PENDING"]);
function directoryScope(mw, extra = {}) {
  return {
    isSupabaseConfigured: () => true, primaryAccountIdsOnly: BM.primaryAccountIdsOnly, getLatestReportSnapshotHydrated: mw.hydrated,
    BRAND_CATALOG_REPORT_KEY: apiConst("BRAND_CATALOG_REPORT_KEY"), BRAND_SALES_REPORT_KEY: apiConst("BRAND_SALES_REPORT_KEY"),
    selectorBrandsForAccount: BM.selectorBrandsForAccount, membershipFingerprint: BM.membershipFingerprint, brandKey: BM.brandKey, brandDisplay: BM.brandDisplay,
    SAFE_CATALOG_CODES: SAFE_CODES, CATALOG_ATTEMPT_PENDING: "PRODUCT_CATALOG_ATTEMPT_PENDING", CATALOG_SOURCE_UNAVAILABLE: "PRODUCT_CATALOG_SOURCE_UNAVAILABLE",
    BRAND_DIRECTORY_SNAPSHOT_KEYS: ["brand-catalog", "brand-sales", "fba-plan", "sku-pl", "listing-health"], defaultGetCatalogAttemptState: async () => null,
    ...extra,
  };
}
const oldDirectory = (mw) => compileApi(OLD_API.snapshotBrandNames + "\n" + OLD_API.sharedSnapshotBrandAccounts, directoryScope(mw, { buildBrandAccountMembership: BM.buildBrandAccountMembership }), "sharedSnapshotBrandAccounts");
const newDirectory = (mw) => compileApi(NEW.sharedSnapshotBrandAccounts, directoryScope(mw, { snapshotBrandNames: MEM.snapshotBrandNames, computeBrandDirectoryMembership: MEM.computeBrandDirectoryMembership }), "sharedSnapshotBrandAccounts");
const dumpDirectory = (d) => J({
  membership: [...d.membership.entries()].map(([k, v]) => [k, v.display, [...v.accounts]]),
  selectorEntries: d.selectorEntries, fingerprint: d.fingerprint,
  covered: [...d.coveredAccountIds], pending: [...d.catalogPendingAccountIds],
  unavailable: [...d.catalogUnavailable.entries()], actionFailures: [...d.catalogActionFailures.entries()],
  serialised: BM.serialiseBrandAccountMembership(d.membership, d.selectorEntries),
});
{
  const ids = [U1, " " + U1 + " ", U2, U3, U4, U5, U6, DDS, U1, ""];
  const attempts = { [U2]: { status: "failed", code: "PRODUCT_CATALOG_EMPTY" }, [U3]: { status: "attempting" }, [U1]: { status: "complete" }, [U4]: { status: "failed", code: "RAW {body}" } };
  const getAttemptState = async (id, actionId) => (actionId === "act-1" ? attempts[id] || null : null);
  const mwOld = membershipWorld(); const mwNew = membershipWorld();
  const before = await oldDirectory(mwOld)(ids);
  const after = await newDirectory(mwNew)(ids);
  const mwOld2 = membershipWorld(); const mwNew2 = membershipWorld();
  const beforeA = await oldDirectory(mwOld2)(ids, { actionId: "act-1", getAttemptState });
  const afterA = await newDirectory(mwNew2)(ids, { actionId: "act-1", getAttemptState });
  ok("M1 sharedSnapshotBrandAccounts (shared snapshotBrandNames + computeBrandDirectoryMembership) is BYTE-IDENTICAL to the pre-WP10 serve -- membership (keys, display labels, account sets, order), selector entries, fingerprint, covered / pending / unavailable / action-failure sets, the serialised directory -- and reads the SAME rows in the SAME order (with and without an action's attempt states)",
    dumpDirectory(before) === dumpDirectory(after) && dumpDirectory(beforeA) === dumpDirectory(afterA) && J(mwOld.log) === J(mwNew.log) && J(mwOld2.log) === J(mwNew2.log));
  const m = after.membership;
  ok("M1 ... over the fixture edge cases: 'Unassigned' is a membership brand; the OUT-OF-LINE brand-sales account (hydrated storage-first) pins ACME + Beta; case / whitespace variants merge under 'acme' (display 'ACME'); the still-loading account pins nothing (selector-only Gamma); the dd-secondary / duplicate / whitespace / blank ids never add an account",
    m.has("unassigned") && J([...m.get("acme").accounts].sort()) === J([U1, U2, U4].sort()) && m.get("acme").display === "ACME" && [...m.get("beta").accounts][0] === U2
    && !m.has("gamma") && after.selectorEntries.some((e) => e.key === "gamma") && !m.has("omega") && m.has("kappa") && m.has("lambda") && m.has("delta")
    && ![...m.values()].some((e) => [...e.accounts].some((a) => a.includes(":") || a !== a.trim() || a === "")) && mwNew.log.includes("storage:obj/U2/brand-sales.json"));
  const accountsById = { [U1]: { country: "IN" }, [U2]: { country: "IN" }, [U4]: { country: "ZZ" }, [U5]: { country: "IN" }, [U6]: { country: "AU" } };
  ok("M2 the region portfolio members over the before / after membership are identical (the unknown-country account drops out fail-closed; inactive U5 stays a member like the serve)",
    J(MEM.regionPortfolioMembers(before.membership, accountsById, "india")) === J(MEM.regionPortfolioMembers(after.membership, accountsById, "india"))
    && J(MEM.regionPortfolioMembers(after.membership, accountsById, "india").find((e) => e.key === "acme").members) === J([U1, U2].sort())
    && MEM.regionPortfolioMembers(after.membership, accountsById, "india").some((e) => e.key === "delta" && e.members.includes(U5)));
}

// =====================================================================================================================
// F. brandViewDepFingerprintReaders: the shared factory, byte-identical to the pre-WP10 inline readers
// =====================================================================================================================
function depFakes({ failCatalog = false, catalog = { validated_at: "2026-09-20T00:00:00.000Z", payload_sha: "cat-sha" } } = {}) {
  const calls = [];
  const bad = (id) => String(id).startsWith("BAD");
  return {
    calls,
    getLatestReportSnapshotMeta: async ({ reportKey, accountId }) => { calls.push(["meta", reportKey, accountId]); if (bad(accountId)) throw new Error("meta"); return { params_hash: "h-" + reportKey + accountId, source_refreshed_at: "2026-09-24T01:00:00+00:00", updated_at: "2026-09-24T01:00:01+00:00" }; },
    getDailyAdsCoverage: async (accountId, sourceKey) => { calls.push(["ads", accountId, sourceKey]); if (bad(accountId)) throw new Error("ads"); return { windows: [{ from: "2026-06-01", to: "2026-09-22" }], status: "succeeded", latestMetricDate: "2026-09-22", contentRev: "rev-" + accountId, read: "ok", error: null }; },
    getCampaignBrandMappings: async (args) => { calls.push(["map", args.organizationFingerprint, args.connectionId, args.accountId]); if (bad(args.accountId)) throw new Error("map"); return [{ ad_campaign_id: "c-1", canonical_brand_key: "acme", brand_display_name: "Acme", updated_at: "2026-09-20T00:00:00+00:00", marketplace: "IN", ads_profile_id: "", mapping_source: "MANUAL" }]; },
    getSourceSnapshot: async (args) => { calls.push(["catalog", args.organizationFingerprint, args.connectionId, args.sourceKey, args.scopeKey]); if (failCatalog) throw new Error("catalog"); return { snapshot: catalog, read: "ok", error: null }; },
    getInventorySnapshotCandidates: async (args) => {
      calls.push(["inv", args.reportKey, args.accountId, args.reportVersion]);
      if (bad(args.accountId)) throw new Error("inv");
      return [
        { id: "av-" + args.accountId, report_key: "brand-inventory", account_id: args.accountId, params_hash: "p1", params: { reportVersion: args.reportVersion, to: "2026-09-22" }, payload: { accountId: args.accountId, inventoryAvailable: true, inventoryDate: "2026-09-22", inventoryByBrandCountry: [] }, source_refreshed_at: "2026-09-23T00:00:00+00:00", updated_at: "2026-09-23T00:00:00+00:00" },
        { id: "ph-" + args.accountId, report_key: "brand-inventory", account_id: args.accountId, params_hash: "p2", params: { reportVersion: args.reportVersion, to: "2026-09-23" }, payload: { accountId: args.accountId, inventoryAvailable: false, inventoryByBrandCountry: [] }, source_refreshed_at: "2026-09-24T00:00:00+00:00", updated_at: "2026-09-24T00:00:00+00:00" },
      ];
    },
  };
}
function depScope(f, org) {
  return {
    primaryOrgFingerprintOrNull: () => org, getCampaignBrandMappings: f.getCampaignBrandMappings, getLatestReportSnapshotMeta: f.getLatestReportSnapshotMeta,
    getDailyAdsCoverage: f.getDailyAdsCoverage, ACTIVE_ADS_SOURCE_KEY, campaignMappingRevision, getSourceSnapshot: f.getSourceSnapshot,
    getInventorySnapshotCandidates: f.getInventorySnapshotCandidates, BRAND_INVENTORY_SNAPSHOT_KEY: BV.BRAND_INVENTORY_SNAPSHOT_KEY,
    BRAND_INVENTORY_REPORT_VERSION: BV.BRAND_INVENTORY_REPORT_VERSION, selectAuthoritativeInventorySnapshot: BV.selectAuthoritativeInventorySnapshot,
    makeBrandViewDepReaders: DEPR.makeBrandViewDepReaders,
  };
}
const oldDepReaders = (f, org) => compileApi(OLD_API.campaignMappingsReader + "\n" + OLD_API.brandViewDepFingerprintReaders, depScope(f, org), "brandViewDepFingerprintReaders()");
const newDepReaders = (f, org) => compileApi(NEW.campaignMappingsReader + "\n" + NEW.brandViewDepFingerprintReaders, depScope(f, org), "brandViewDepFingerprintReaders()");
async function exerciseDeps(readers) {
  const o = {};
  for (const acct of ["IN1", "IN2", "BAD1"]) {
    o[acct] = {
      meta: await Promise.all(["brand-sales", "fba-plan", "listing-health"].map((rk) => readers.getSnapshotMeta({ reportKey: rk, accountId: acct }))),
      ads: await readers.getAdsCoverage(acct), rev: await readers.getMappingRev(acct), inv: await readers.getInventorySelected(acct),
    };
  }
  o.catalog = await readers.getCatalogValidatedAt();
  o.fpAccount = await FPM.collectBrandViewDependencyFingerprint({ scope: "account", brand: "Acme", accountIds: ["IN1"], reportVersion: BV.BRAND_VIEW_VERSION, readers });
  o.fpPortfolio = await FPM.collectBrandViewDependencyFingerprint({ scope: "portfolio", brand: "Acme", accountIds: ["IN1", "IN2", "BAD1"], reportVersion: BV.BRAND_VIEW_PORTFOLIO_VERSION, readers });
  return o;
}
{
  const variants = [
    ["org", "org-fp-test", {}], ["no primary org", null, {}], ["catalog read throws", "org-fp-test", { failCatalog: true }],
    ["catalog without validated_at (payload_sha)", "org-fp-test", { catalog: { validated_at: null, payload_sha: "sha-only" } }], ["no catalog pointer", "org-fp-test", { catalog: null }],
  ];
  const rows = [];
  for (const [label, org, opt] of variants) {
    const fOld = depFakes(opt); const fNew = depFakes(opt);
    const before = await exerciseDeps(oldDepReaders(fOld, org));
    const after = await exerciseDeps(newDepReaders(fNew, org));
    rows.push({ label, same: J(before) === J(after) && J(fOld.calls) === J(fNew.calls), before, after });
  }
  ok("F1 brandViewDepFingerprintReaders (makeBrandViewDepReaders over the serve's REST readers) is BYTE-IDENTICAL to the pre-WP10 inline readers -- every reader result (incl. fail-soft nulls / [] for throwing reads), every underlying call + argument, and the account + portfolio fingerprints -- for: " + rows.map((r) => r.label).join(" / "),
    rows.every((r) => r.same) && /^[0-9a-f]{40}$/.test(rows[0].after.fpAccount) && rows[0].after.fpAccount !== rows[1].after.fpAccount
    && rows[0].after.BAD1.ads === null && rows[0].after.BAD1.inv === null && rows[0].after.IN1.inv.id === "av-IN1" && rows[2].after.catalog === null && rows[3].after.catalog === "sha-only");
}

// =====================================================================================================================
// D. Brand View directory hydration: serve rebuild == brand-view-brands route derive (storage-first, typed failures)
// =====================================================================================================================
function directoryWorld() {
  const rows = new Map(); const saved = new Map(); const storage = new Map(); const storageFail = new Set(); const log = [];
  let seq = 0;
  const put = (rk, acct, payload, { path: p = null } = {}) => {
    seq += 1;
    const at = new Date(Date.UTC(2026, 8, 24, 1, 0, seq)).toISOString();
    rows.set(rk + "|" + acct, { id: rk + "-" + acct + "-" + seq, report_key: rk, account_id: acct, params_hash: "h-" + rk + "-" + acct + "-" + seq, params: { reportVersion: rk + "-shared-v1" }, payload, payload_storage_path: p, source_refreshed_at: at, updated_at: at });
  };
  const ns = {
    getLatestReportSnapshot: async ({ reportKey, accountId }) => { log.push("latest:" + reportKey); return clone(rows.get(reportKey + "|" + accountId) || null); },
    getReportSnapshot: async ({ reportKey, accountId, paramsHash }) => { log.push("exact:" + reportKey); return clone(saved.get(reportKey + "|" + accountId + "|" + paramsHash) || null); },
    getReportSnapshotStoragePayload: async (p) => { log.push("storage:" + p); if (storageFail.has(p)) throw new Error("storage read failed"); return storage.has(p) ? clone(storage.get(p)) : null; },
    inlinePayloadUsable: SB.inlinePayloadUsable,
  };
  // The REAL storage-first reader over the fake latest read (the caller's readStorage, when given, wins -- as in supabase.js).
  ns.getLatestReportSnapshotHydrated = (args, opts = {}) => SB.getLatestReportSnapshotHydrated(args, { ...opts, readLatest: ns.getLatestReportSnapshot, readStorage: opts.readStorage || ns.getReportSnapshotStoragePayload });
  // The route's evidence SQL (LATEST_ROWS_SQL) over the same rows: the latest row per (report, account), to_char instants.
  const pgReadOnly = async (text, values) => {
    if (text !== BVB_W.LATEST_ROWS_SQL) throw new Error("unknown evidence SQL");
    const [keys, accts] = values;
    const o = [];
    for (const rk of keys) for (const a of accts) {
      const r = rows.get(rk + "|" + a);
      if (r) o.push({ report_key: rk, account_id: a, id: r.id, params_hash: r.params_hash, source_refreshed_at: toUs(r.source_refreshed_at), updated_at: toUs(r.updated_at), report_version: r.params.reportVersion, inv_available: null, inv_date: null, inv_snapshot_date: null, inv_ibbc_type: null });
    }
    return o;
  };
  return { rows, saved, storage, storageFail, log, ns, put, pgReadOnly };
}
const DIR_MSG = (API.match(/^const BRAND_VIEW_DIRECTORY_UNAVAILABLE_MESSAGE = "([^"]+)";/m) || [])[1];
const dirScope = (dw, extra = {}) => ({
  paramsHashFor, BRAND_VIEW_BRANDS_VERSION: BV.BRAND_VIEW_BRANDS_VERSION, BRAND_VIEW_BRANDS_REPORT_KEY: BV.BRAND_VIEW_BRANDS_REPORT_KEY,
  getReportSnapshot: dw.ns.getReportSnapshot, getLatestReportSnapshot: dw.ns.getLatestReportSnapshot,
  // production: supabase.js getLatestReportSnapshotHydrated (its readLatest = the REST latest read, here the fake).
  getLatestReportSnapshotHydrated: (args, opts = {}) => SB.getLatestReportSnapshotHydrated(args, { ...opts, readLatest: dw.ns.getLatestReportSnapshot }),
  getReportSnapshotStoragePayload: dw.ns.getReportSnapshotStoragePayload, buildBrandViewBrandDirectory: BV.buildBrandViewBrandDirectory,
  BRAND_VIEW_DIRECTORY_UNAVAILABLE_MESSAGE: DIR_MSG, ...extra,
});
const newServeDir = (dw) => compileApi(NEW.brandViewDirectory + "\n" + NEW.respondBrandViewDirectoryUnavailable, dirScope(dw), "{ brandViewDirectory, respondBrandViewDirectoryUnavailable }");
const oldServeDir = (dw) => compileApi(OLD_API.brandViewDirectory, dirScope(dw), "brandViewDirectory");
async function routeDerive(dw, acct) {
  const rt = BVB_C.default.build({ sb: REL.readOnlySupabase(dw.ns), pgReadOnly: dw.pgReadOnly, computeHash: paramsHashFor });
  const b = await rt.resolveBundle({ targetId: acct });
  if (!b.eligible) return { notReady: true, reason: "ineligible:" + b.reason };
  return rt.derive(b.bundle, {});
}
{
  const dw = directoryWorld();
  const IN1 = "IN1"; const IN2 = "IN2";
  dw.put("brand-sales", IN1, { rows: salesRows(["Acme", "Zeta", "Unassigned"]) });
  dw.put("fba-plan", IN1, { rows: salesRows(["Beta"], "brand") });
  dw.put("sku-pl", IN1, { rows: salesRows(["Zeta"], "brand") });
  // IN2: an OUT-OF-LINE brand-sales payload (inline stub null, the full payload in storage).
  dw.put("brand-sales", IN2, null, { path: "obj/IN2/brand-sales.json" });
  dw.storage.set("obj/IN2/brand-sales.json", { rows: salesRows(["Acme", "Kappa"]) });
  dw.put("sku-pl", IN2, { rows: salesRows(["Mu"], "brand") });
  const serve = newServeDir(dw); const serveOld = oldServeDir(dw);

  const s1 = await serve.brandViewDirectory(IN1, { rebuild: true });
  const o1 = await serveOld(IN1, { rebuild: true });
  const r1 = await routeDerive(dw, IN1);
  ok("D1 inline sources: the serve rebuild == the route derive == the pre-WP10 serve (byte-identical payloads: Acme, Beta, Zeta; 'Unassigned' dropped by the builder)",
    J(s1.payload) === J(r1.payload) && J(s1.payload) === J(o1.payload) && J(s1.payload.brands) === J(["Acme", "Beta", "Zeta"]) && s1.rederived === true && !s1.unavailable);

  const s2 = await serve.brandViewDirectory(IN2, { rebuild: true });
  const o2 = await serveOld(IN2, { rebuild: true });
  const r2 = await routeDerive(dw, IN2);
  ok("D2 an OUT-OF-LINE brand-sales payload now contributes its brands in BOTH the serve rebuild and the route derive (byte-identical: Acme, Kappa, Mu + its brand-sales source entry); the pre-WP10 serve read the stub and silently reduced the list to [Mu]",
    J(s2.payload) === J(r2.payload) && J(s2.payload.brands) === J(["Acme", "Kappa", "Mu"]) && s2.payload.sources.some((x) => x.reportKey === "brand-sales" && x.brandCount === 2)
    && J(o2.payload.brands) === J(["Mu"]) && !r2.notReady);

  dw.storage.delete("obj/IN2/brand-sales.json");
  const s3 = await serve.brandViewDirectory(IN2, { rebuild: true });
  const r3 = await routeDerive(dw, IN2);
  const res3 = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(x) { this.body = x; return this; } };
  serve.respondBrandViewDirectoryUnavailable(res3, s3);
  ok("D3 an ABSENT storage object (path set, inline unusable, hydration null): the serve is typed UNAVAILABLE ('storage-missing:brand-sales', NO payload -> a 503, never a list) and the route derive DEFERS 'storage-missing:brand-sales'",
    s3.payload === null && s3.unavailable && s3.unavailable.reason === "storage-missing:brand-sales" && res3.statusCode === 503 && res3.body.unavailable === true
    && res3.body.reason === "storage-missing:brand-sales" && res3.body.error === DIR_MSG && !("brands" in res3.body) && res3.body.reportKey === "brand-view-brands"
    && r3.notReady === true && r3.reason === "storage-missing:brand-sales" && !r3.payload);

  dw.storage.set("obj/IN2/brand-sales.json", { rows: salesRows(["Acme", "Kappa"]) });
  dw.storageFail.add("obj/IN2/brand-sales.json");
  const s4 = await serve.brandViewDirectory(IN2, { rebuild: true });
  const r4 = await routeDerive(dw, IN2);
  ok("D4 a storage load that THROWS: the serve is typed UNAVAILABLE 'hydrate-failed:brand-sales' and the route defers 'hydrate-failed:brand-sales' (never the inline stub)",
    s4.payload === null && s4.unavailable && s4.unavailable.reason === "hydrate-failed:brand-sales" && r4.notReady === true && r4.reason === "hydrate-failed:brand-sales");
  dw.storageFail.clear();

  // A storage path with a USABLE inline payload is read inline on both sides (the object is never fetched).
  dw.put("brand-sales", IN2, { rows: salesRows(["Acme"]) }, { path: "obj/IN2/brand-sales.json" });
  const mark = dw.log.length;
  const s5 = await serve.brandViewDirectory(IN2, { rebuild: true });
  const r5 = await routeDerive(dw, IN2);
  ok("D5 a storage path with a USABLE inline payload is read INLINE by both (the storage object is never fetched): [Acme, Mu] on both sides",
    J(s5.payload) === J(r5.payload) && J(s5.payload.brands) === J(["Acme", "Mu"]) && !dw.log.slice(mark).some((x) => x.startsWith("storage:")));

  // The cache-first path is untouched: a saved directory is served with ZERO source reads.
  const hash = paramsHashFor(BV.BRAND_VIEW_BRANDS_VERSION, { accountId: IN1 });
  dw.saved.set("brand-view-brands|" + IN1 + "|" + hash, { id: "bvb-1", payload: { accountId: IN1, brands: ["Saved"], sources: [], message: null }, source_refreshed_at: "2026-09-24T02:00:00.000Z", updated_at: "2026-09-24T02:00:01.000Z" });
  const mark6 = dw.log.length;
  const s6 = await serve.brandViewDirectory(IN1);
  ok("D6 the cache-first read is unchanged: the saved exact { accountId } directory is served (shared) with ZERO source / storage reads",
    J(s6.payload.brands) === J(["Saved"]) && s6.shared === true && s6.savedAt === "2026-09-24T02:00:00.000Z" && J(dw.log.slice(mark6)) === J(["exact:brand-view-brands"]));

  // The two api/datadoe.js call sites answer the typed unavailable directory with the 503 (never a list / a 400 refusal).
  const bvbBlock = API.slice(API.indexOf('if (action === "brand-view-brands") {'), API.indexOf('if (action === "brand-view") {'));
  const bvBlock = API.slice(API.indexOf('if (action === "brand-view") {'), API.indexOf('if (action === "brand-view-portfolio") {'));
  ok("D7 both serve call sites guard the typed UNAVAILABLE directory before reading .brands (brand-view-brands answers 503; brand-view never turns it into a 'not a brand of this account' refusal)",
    /const brandDirectory = await brandViewDirectory\(accountId, \{ rebuild: wantsRefresh\(req\) \}\);\s*[\s\S]{0,300}?if \(brandDirectory\.unavailable\) \{ respondBrandViewDirectoryUnavailable\(res, brandDirectory\); return; \}/.test(bvbBlock)
    && /if \(!brandDirectory\.unavailable && !brandDirectory\.payload\.brands\.includes\(brand\)\)/.test(bvBlock)
    && /if \(brandDirectory\.unavailable\) \{ respondBrandViewDirectoryUnavailable\(res, brandDirectory\); return; \}\s*const directory = brandDirectory\.payload;/.test(bvBlock));
  ok("D8 the serve rebuild stays READ-ONLY and zero-export (no snapshot write / lock / publish / DataDoe in brandViewDirectory)",
    !/\b(saveReportSnapshot|claimRefreshLock|publishSnapshotUpdate|insertReportSnapshotIfAbsent|createExport|ddFetch|fetchExportRows)\s*\(/.test(NEW.brandViewDirectory + NEW.respondBrandViewDirectoryUnavailable));
}

ok("Z zero DataDoe / zero writes: every network request was a GET on the two emulated PostgREST tables; nothing was refused", net.refused.length === 0
  && net.calls.every((c) => /^GET \/rest\/v1\/(source_coverage|source_oli_operational_units)\?/.test(c)));

out(`\nserve-route-parity: ${passed} passed`);
