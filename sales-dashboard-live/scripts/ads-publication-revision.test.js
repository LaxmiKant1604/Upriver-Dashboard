// PURE tests for the durable Campaign-Ads revision + dependent-report registry (the Ads analog of
// oli/fba-publication-revision tests). No I/O. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { computeAdsAccountRevision, adsContentProvenanceToken, ADS_REVISION_STATUS } from "../lib/server/sync/ads-publication-revision.js";
import {
  ADS_LINEAGE_DEPENDS_ON, ADS_SOURCE_KEYS, ADS_PRIMARY_SOURCE_KEY,
  adsDependentLiveReportKeys, isAdsDependentLiveReport, adsGrainsForReport, assertAdsDependentReportsConsistency,
  ADS_CAMPAIGN_SOURCE_KEY, ADS_TARGETING_SOURCE_KEY, ADS_SEARCH_TERMS_SOURCE_KEY,
} from "../lib/server/sync/ads-dependent-reports.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "ads-publication-revision\n");

const ORG = "org-1", A = "A01", ASOF = "2026-09-10";
const grain = (over = {}) => ({ contentRev: "rev-c1", latestMetricDate: "2026-09-10", coveredThrough: "2026-09-10", read: "ok", ...over });
const base = (over = {}) => ({ organizationFingerprint: ORG, connectionId: "primary", accountId: A, marketplace: "US", requestedAsOf: ASOF, grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain(), ...over } });

// ---- registry ----
ok("registry: exactly daily-reporting + ppc-performance are Ads-dependent", adsDependentLiveReportKeys().join(",") === "daily-reporting,ppc-performance");
ok("registry: daily depends on campaign ONLY", adsGrainsForReport("daily-reporting").join(",") === ADS_CAMPAIGN_SOURCE_KEY);
ok("registry: ppc depends on all three grains", adsGrainsForReport("ppc-performance").join(",") === [ADS_CAMPAIGN_SOURCE_KEY, ADS_SEARCH_TERMS_SOURCE_KEY, ADS_TARGETING_SOURCE_KEY].sort().join(","));
ok("registry: isAdsDependentLiveReport true for both, false for brand-inventory", isAdsDependentLiveReport("daily-reporting") && isAdsDependentLiveReport("ppc-performance") && !isAdsDependentLiveReport("brand-inventory"));
ok("registry: campaign is the required primary grain", ADS_PRIMARY_SOURCE_KEY === ADS_CAMPAIGN_SOURCE_KEY && ADS_SOURCE_KEYS.length === 3);
ok("registry: a report without the required campaign grain fails consistency (fail closed)", (() => { try { assertAdsDependentReportsConsistency({ "x": [ADS_TARGETING_SOURCE_KEY] }); return false; } catch { return true; } })());

// ---- eligibility (campaign covered through D-1 + content_rev) ----
const r1 = computeAdsAccountRevision(base());
ok("eligible: campaign covered-through-D-1 with content_rev -> AVAILABLE + 32-hex revision + one content token", r1.eligible === true && r1.status === ADS_REVISION_STATUS.AVAILABLE && /^[0-9a-f]{32}$/.test(r1.revisionId) && r1.deps.length === 0 && r1.contentDeps.length === 1);

// ---- unavailable / defer paths (missing/unproven -> never a fabricated zero) ----
ok("defer: no campaign grain at all -> ineligible (unavailable)", computeAdsAccountRevision({ ...base(), grains: {} }).eligible === false);
ok("defer: campaign coverage does NOT reach requestedAsOf -> ineligible", computeAdsAccountRevision(base({ [ADS_CAMPAIGN_SOURCE_KEY]: grain({ coveredThrough: "2026-09-09" }) })).eligible === false);
ok("defer: campaign content_rev blank -> ineligible", computeAdsAccountRevision(base({ [ADS_CAMPAIGN_SOURCE_KEY]: grain({ contentRev: "" }) })).eligible === false);
ok("defer: campaign read not ok -> ineligible", computeAdsAccountRevision(base({ [ADS_CAMPAIGN_SOURCE_KEY]: grain({ read: "read-failed" }) })).eligible === false);
ok("defer: incomplete account boundary (blank asOf) -> ineligible", computeAdsAccountRevision({ ...base(), requestedAsOf: "" }).eligible === false);

// ---- same-date correction: campaign content_rev flips -> new revision + new token ----
const r2 = computeAdsAccountRevision(base({ [ADS_CAMPAIGN_SOURCE_KEY]: grain({ contentRev: "rev-c2" }) }));
ok("same-date campaign correction -> DIFFERENT revisionId + DIFFERENT content token", r2.eligible && r2.revisionId !== r1.revisionId && r2.contentDeps[0] !== r1.contentDeps[0]);

// ---- targeting-grain correction: composite changes (over-detection is SAFE) ----
const withTgt = computeAdsAccountRevision(base({ [ADS_TARGETING_SOURCE_KEY]: grain({ contentRev: "t1" }) }));
const withTgt2 = computeAdsAccountRevision(base({ [ADS_TARGETING_SOURCE_KEY]: grain({ contentRev: "t2" }) }));
ok("targeting-grain correction flips the composite token (ppc detected; daily re-derive is a safe idempotent no-op)", withTgt.eligible && withTgt2.eligible && withTgt.contentDeps[0] !== withTgt2.contentDeps[0]);
ok("an UNPROVEN targeting grain (not covered through D-1) is NOT folded into the token", computeAdsAccountRevision(base({ [ADS_TARGETING_SOURCE_KEY]: grain({ coveredThrough: "2026-09-09" }) })).contentDeps[0] === r1.contentDeps[0]);

// ---- covered-empty vs unavailable honesty ----
const empty = computeAdsAccountRevision(base({ [ADS_CAMPAIGN_SOURCE_KEY]: grain({ latestMetricDate: "" }) }));
ok("covered-through-D-1 but empty (blank latest metric date) -> COVERED_EMPTY (a genuine available-zero, still eligible)", empty.eligible === true && empty.status === ADS_REVISION_STATUS.COVERED_EMPTY);

// ---- account / marketplace / org isolation ----
ok("cross-account isolation: different accountId -> different revision + token", (() => { const r = computeAdsAccountRevision({ ...base(), accountId: "A02" }); return r.eligible && r.revisionId !== r1.revisionId && r.contentDeps[0] !== r1.contentDeps[0]; })());
ok("cross-marketplace isolation: different marketplace -> different revision + token", (() => { const r = computeAdsAccountRevision({ ...base(), marketplace: "CA" }); return r.eligible && r.revisionId !== r1.revisionId && r.contentDeps[0] !== r1.contentDeps[0]; })());
ok("cross-org isolation: different organizationFingerprint -> different revision", computeAdsAccountRevision({ ...base(), organizationFingerprint: "org-2" }).revisionId !== r1.revisionId);

// ---- token determinism + grain-order independence ----
ok("token is deterministic + grain-order independent", adsContentProvenanceToken({ accountId: A, marketplace: "US", grainRevs: [{ sourceKey: ADS_TARGETING_SOURCE_KEY, contentRev: "t1", coveredThrough: ASOF }, { sourceKey: ADS_CAMPAIGN_SOURCE_KEY, contentRev: "c1", coveredThrough: ASOF }] }) === adsContentProvenanceToken({ accountId: A, marketplace: "US", grainRevs: [{ sourceKey: ADS_CAMPAIGN_SOURCE_KEY, contentRev: "c1", coveredThrough: ASOF }, { sourceKey: ADS_TARGETING_SOURCE_KEY, contentRev: "t1", coveredThrough: ASOF }] }));

writeSync(1, `\nads-publication-revision: ${passed} assertions passed\n`);
