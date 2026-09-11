// PURE tests for the REPORT-SPECIFIC durable Campaign-Ads revision + strict coverage evaluator + dependent-report
// registry (Codex blockers 4 + 5). No I/O. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  computeAdsReportRevision, adsContentProvenanceToken, coverageProvesContinuousRange, subUtcDaysStr, addUtcDaysStr,
  ADS_REVISION_STATUS,
} from "../lib/server/sync/ads-publication-revision.js";
import {
  ADS_SOURCE_KEYS, ADS_PRIMARY_SOURCE_KEY, ADS_CAMPAIGN_SOURCE_KEY, ADS_TARGETING_SOURCE_KEY, ADS_SEARCH_TERMS_SOURCE_KEY,
  adsDependentLiveReportKeys, isAdsDependentLiveReport, adsGrainsForReport, adsRequiredCoverageDays,
  assertAdsDependentReportsConsistency,
} from "../lib/server/sync/ads-dependent-reports.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
writeSync(1, "ads-publication-revision\n");

const ORG = "org-1", A = "A01", ASOF = "2026-09-10";
const REQ_DAILY = subUtcDaysStr(ASOF, adsRequiredCoverageDays("daily-reporting") - 1); // 7-day -> 2026-09-04
const REQ_PPC = subUtcDaysStr(ASOF, adsRequiredCoverageDays("ppc-performance") - 1);   // 30-day
// A grain durably + CONTINUOUSLY covered from well before the window through D-1, with activity.
const grain = (over = {}) => ({ contentRev: "rev-c1", latestMetricDate: ASOF, windows: [{ from: "2026-07-01", to: ASOF }], read: "ok", ...over });
const daily = (over = {}) => ({ organizationFingerprint: ORG, connectionId: "primary", accountId: A, marketplace: "US", requestedAsOf: ASOF, requiredFrom: REQ_DAILY, requiredGrains: [ADS_CAMPAIGN_SOURCE_KEY], grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain() }, ...over });
const ppc = (over = {}) => ({ organizationFingerprint: ORG, connectionId: "primary", accountId: A, marketplace: "US", requestedAsOf: ASOF, requiredFrom: REQ_PPC, requiredGrains: [ADS_CAMPAIGN_SOURCE_KEY, ADS_TARGETING_SOURCE_KEY, ADS_SEARCH_TERMS_SOURCE_KEY], grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain(), [ADS_TARGETING_SOURCE_KEY]: grain({ contentRev: "t1" }), [ADS_SEARCH_TERMS_SOURCE_KEY]: grain({ contentRev: "s1" }) }, ...over });

// ---- registry (blocker 5 shape) ----
ok("registry: daily-reporting + ppc-performance are Ads-dependent", adsDependentLiveReportKeys().join(",") === "daily-reporting,ppc-performance");
ok("registry: daily requires campaign ONLY; ppc requires all three", adsGrainsForReport("daily-reporting").join(",") === ADS_CAMPAIGN_SOURCE_KEY && adsGrainsForReport("ppc-performance").length === 3);
ok("registry: required coverage windows (daily 7, ppc 30)", adsRequiredCoverageDays("daily-reporting") === 7 && adsRequiredCoverageDays("ppc-performance") === 30);
ok("registry: consistency assertion passes for the real map", (() => { try { assertAdsDependentReportsConsistency(); return true; } catch { return false; } })());

// ---- strict continuous coverage evaluator (blocker 4) ----
ok("coverage: a single window spanning [from..to] proves it", coverageProvesContinuousRange([{ from: "2026-09-01", to: ASOF }], REQ_DAILY, ASOF) === true);
ok("coverage: adjacent windows (next.from = prev.to+1) merge to prove it", coverageProvesContinuousRange([{ from: "2026-09-04", to: "2026-09-06" }, { from: "2026-09-07", to: ASOF }], REQ_DAILY, ASOF) === true);
ok("coverage: a GAP inside [from..to] fails EVEN when a later window ends at `to`", coverageProvesContinuousRange([{ from: "2026-09-01", to: "2026-09-05" }, { from: "2026-09-09", to: ASOF }], REQ_DAILY, ASOF) === false);
ok("coverage: MAX(covered_to) alone is not proof (gap ending at D-1 -> false)", coverageProvesContinuousRange([{ from: "2026-08-01", to: "2026-09-06" }, { from: "2026-09-09", to: ASOF }], REQ_DAILY, ASOF) === false);
ok("coverage: window ending before `to` fails", coverageProvesContinuousRange([{ from: "2026-08-01", to: "2026-09-09" }], REQ_DAILY, ASOF) === false);
ok("coverage: impossible/blank from|to -> false", coverageProvesContinuousRange([{ from: "2026-07-01", to: ASOF }], "2026-02-30", ASOF) === false && coverageProvesContinuousRange([{ from: "2026-07-01", to: ASOF }], "", ASOF) === false);
ok("date helper: UTC round-trip add/sub", addUtcDaysStr("2026-09-10", -6) === "2026-09-04" && subUtcDaysStr("2026-03-01", 1) === "2026-02-28");

// ---- daily-reporting revision (campaign only) ----
const d1 = computeAdsReportRevision(daily());
ok("daily eligible (campaign continuously covered) -> AVAILABLE + one content token, deps empty", d1.eligible === true && d1.status === ADS_REVISION_STATUS.AVAILABLE && /^[0-9a-f]{32}$/.test(d1.revisionId) && d1.deps.length === 0 && d1.contentDeps.length === 1);
ok("daily defer: campaign coverage gapped ending at D-1 -> unavailable", computeAdsReportRevision(daily({ grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain({ windows: [{ from: "2026-07-01", to: "2026-09-06" }, { from: "2026-09-09", to: ASOF }] }) } })).eligible === false);
ok("daily defer: campaign blank content_rev -> unavailable", computeAdsReportRevision(daily({ grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain({ contentRev: "" }) } })).eligible === false);
ok("daily defer: campaign read not ok -> unavailable", computeAdsReportRevision(daily({ grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain({ read: "read-failed" }) } })).eligible === false);
ok("daily defer: impossible requestedAsOf (2026-02-30) -> unavailable (real UTC calendar)", computeAdsReportRevision(daily({ requestedAsOf: "2026-02-30", requiredFrom: "2026-02-24" })).eligible === false);
ok("daily defer: BLANK marketplace -> unavailable (never a blank-market token)", computeAdsReportRevision(daily({ marketplace: "" })).eligible === false);

// ---- ppc-performance revision (all three grains) ----
const p1 = computeAdsReportRevision(ppc());
ok("ppc eligible (all three grains continuously covered)", p1.eligible === true && p1.contentDeps.length === 1);
ok("ppc defer: TARGETING grain missing -> unavailable (ppc requires it)", computeAdsReportRevision(ppc({ grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain(), [ADS_SEARCH_TERMS_SOURCE_KEY]: grain({ contentRev: "s1" }) } })).eligible === false);
ok("ppc defer: SEARCH-TERMS grain gapped -> unavailable", computeAdsReportRevision(ppc({ grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain(), [ADS_TARGETING_SOURCE_KEY]: grain({ contentRev: "t1" }), [ADS_SEARCH_TERMS_SOURCE_KEY]: grain({ contentRev: "s1", windows: [{ from: "2026-07-01", to: "2026-09-05" }, { from: "2026-09-09", to: ASOF }] }) } })).eligible === false);

// ---- REPORT ISOLATION (blocker 5): PPC-only grains never block daily; targeting-only correction never marks daily changed ----
ok("isolation: a missing TARGETING grain does NOT block daily-reporting (daily requires only campaign)", computeAdsReportRevision(daily()).eligible === true);
const dTgt1 = computeAdsReportRevision(daily());
const pTgt1 = computeAdsReportRevision(ppc({ grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain(), [ADS_TARGETING_SOURCE_KEY]: grain({ contentRev: "tX" }), [ADS_SEARCH_TERMS_SOURCE_KEY]: grain({ contentRev: "s1" }) } }));
const pTgt2 = computeAdsReportRevision(ppc({ grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain(), [ADS_TARGETING_SOURCE_KEY]: grain({ contentRev: "tY" }), [ADS_SEARCH_TERMS_SOURCE_KEY]: grain({ contentRev: "s1" }) } }));
ok("isolation: a TARGETING-only correction changes ppc's token but leaves daily's token UNCHANGED", pTgt1.contentDeps[0] !== pTgt2.contentDeps[0] && computeAdsReportRevision(daily()).contentDeps[0] === dTgt1.contentDeps[0]);
ok("isolation: daily's token folds ONLY campaign (no targeting/search grain names in it)", !dTgt1.contentDeps[0].includes(ADS_TARGETING_SOURCE_KEY) && !dTgt1.contentDeps[0].includes(ADS_SEARCH_TERMS_SOURCE_KEY) && dTgt1.contentDeps[0].includes(ADS_CAMPAIGN_SOURCE_KEY));

// ---- same-date campaign correction (affects BOTH reports) ----
ok("same-date campaign correction -> daily revision + token change", (() => { const r = computeAdsReportRevision(daily({ grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain({ contentRev: "rev-c2" }) } })); return r.eligible && r.revisionId !== d1.revisionId && r.contentDeps[0] !== d1.contentDeps[0]; })());

// ---- covered-empty vs unavailable ----
ok("covered-empty: continuous coverage + no activity (blank latest metric date) -> COVERED_EMPTY, still eligible", computeAdsReportRevision(daily({ grains: { [ADS_CAMPAIGN_SOURCE_KEY]: grain({ latestMetricDate: "" }) } })).status === ADS_REVISION_STATUS.COVERED_EMPTY);

// ---- isolation of identity ----
ok("cross-account isolation", computeAdsReportRevision(daily({ accountId: "A02" })).contentDeps[0] !== d1.contentDeps[0]);
ok("cross-marketplace isolation", computeAdsReportRevision(daily({ marketplace: "CA" })).contentDeps[0] !== d1.contentDeps[0]);
ok("cross-org isolation (revisionId)", computeAdsReportRevision(daily({ organizationFingerprint: "org-2" })).revisionId !== d1.revisionId);

// ---- token determinism + grain-order independence ----
ok("token deterministic + grain-order independent", adsContentProvenanceToken({ accountId: A, marketplace: "US", grainRevs: [{ sourceKey: ADS_TARGETING_SOURCE_KEY, contentRev: "t1" }, { sourceKey: ADS_CAMPAIGN_SOURCE_KEY, contentRev: "c1" }] }) === adsContentProvenanceToken({ accountId: A, marketplace: "US", grainRevs: [{ sourceKey: ADS_CAMPAIGN_SOURCE_KEY, contentRev: "c1" }, { sourceKey: ADS_TARGETING_SOURCE_KEY, contentRev: "t1" }] }));

writeSync(1, `\nads-publication-revision: ${passed} assertions passed\n`);
