// Regional scheduler ROUTING + deterministic 5-seller BATCHING + a zero-create dry-run PLANNER.
//
// PURE + offline-testable: no I/O, no DataDoe, no side effects. This is the groundwork for the future regional
// scheduler (Phase 5) and the mandatory pre-create dry-run gate; it computes account->region assignment, deterministic
// <=5-seller batches (regardless of marketplace), source applicability and the exact export count / maximum token
// spend for a run. It NEVER creates an export -- the create is a separate, human-authorized step.
//
// It is dormant: nothing here is wired into an active scheduler in this phase.

const S = (v) => (v == null ? "" : String(v).trim().toUpperCase());

export const REGIONS = Object.freeze({ INDIA: "india", EUROPE_AU: "europe-au", US_CA: "us-ca", UNASSIGNED: "unassigned" });

// Region membership by marketplace (canonical uppercase). GB and UK are the same marketplace; both route to Europe/AU.
const REGION_MARKETPLACES = Object.freeze({
  [REGIONS.INDIA]: ["IN"],
  [REGIONS.EUROPE_AU]: ["GB", "UK", "DE", "FR", "IT", "ES", "NL", "BE", "SE", "PL", "IE", "AT", "AU"],
  [REGIONS.US_CA]: ["US", "CA"],
});
const MARKETPLACE_TO_REGION = (() => {
  const m = new Map();
  for (const [region, mkts] of Object.entries(REGION_MARKETPLACES)) for (const mkt of mkts) m.set(mkt, region);
  return m;
})();

// The regional triggers (UTC). primary + a watchdog 20 minutes later. No schedule is activated by this module.
// The primary minutes are DELIBERATELY off the congested :00/:30 boundaries (moved 2026-09-10 after a missed
// GitHub cron delivery on a :00 boundary): GitHub's scheduled-cron delivery is best-effort and is most often
// delayed or dropped exactly at the top-of-hour / half-hour where the most repos schedule. The +20-min watchdog
// tracks the primary (Cloudflare-owned; Codex updates the external cron to match this spec).
export const REGION_SCHEDULE = Object.freeze({
  [REGIONS.INDIA]: { label: "India", primaryUtc: "03:07", watchdogUtc: "03:27", primaryCron: "7 3 * * *", watchdogCron: "27 3 * * *", istPrimary: "08:37", istWatchdog: "08:57" },
  [REGIONS.EUROPE_AU]: { label: "Europe + UK + Australia", primaryUtc: "08:37", watchdogUtc: "08:57", primaryCron: "37 8 * * *", watchdogCron: "57 8 * * *", istPrimary: "14:07", istWatchdog: "14:27" },
  [REGIONS.US_CA]: { label: "US + Canada", primaryUtc: "16:37", watchdogUtc: "16:57", primaryCron: "37 16 * * *", watchdogCron: "57 16 * * *", istPrimary: "22:07", istWatchdog: "22:27" },
});

// The Campaign Ads window plan (days), from the source spec. Used by the planner + the future scheduler.
export const CAMPAIGN_WINDOWS = Object.freeze({ initialDays: 56, dailyDays: 21, monthlyCorrectionDays: 49 });
export const CAMPAIGN_SOURCE_ID = "08cdc77d3dc24a7651553e2e926f598188c66172f64cd6512265900af6073a6c";
export const MAX_SELLERS_PER_BATCH = 5;

// One marketplace -> its region (UNASSIGNED for an unknown/blank marketplace; the scheduler must alert + skip it).
export function regionForMarketplace(marketplace) {
  const mkt = S(marketplace);
  if (!mkt) return REGIONS.UNASSIGNED;
  return MARKETPLACE_TO_REGION.get(mkt) || REGIONS.UNASSIGNED;
}

// Route a dynamically-discovered account list into regions. Each account: { accountId, marketplace|country }. Returns
// { byRegion: { region: [account] }, unassigned: [account] }. Deterministic (sorted by accountId). A newly connected
// seller auto-routes on its next run because routing is recomputed from the live list every time.
export function routeAccounts(accounts) {
  const byRegion = { [REGIONS.INDIA]: [], [REGIONS.EUROPE_AU]: [], [REGIONS.US_CA]: [] };
  const unassigned = [];
  const sorted = [...(Array.isArray(accounts) ? accounts : [])]
    .filter((a) => a && a.accountId)
    .sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));
  for (const a of sorted) {
    const region = regionForMarketplace(a.marketplace ?? a.country);
    if (region === REGIONS.UNASSIGNED) unassigned.push({ ...a, region });
    else byRegion[region].push({ ...a, region });
  }
  return { byRegion, unassigned };
}

// Deterministically chunk one region's accounts into batches of <=`size` sellers (regardless of marketplace), each
// batch carrying an explicit seller allowlist (the exact accountIds the download rows must belong to).
export function batchAccounts(accounts, size = MAX_SELLERS_PER_BATCH) {
  const sorted = [...(Array.isArray(accounts) ? accounts : [])]
    .filter((a) => a && a.accountId)
    .sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));
  const batches = [];
  for (let i = 0; i < sorted.length; i += size) {
    const slice = sorted.slice(i, i + size);
    batches.push({ index: batches.length, accounts: slice, allowlist: slice.map((a) => String(a.accountId)) });
  }
  return batches;
}

// DETERMINISTIC binary split of ONE failed batch's seller allowlist, preserving the original stable ordering. A batch
// that DataDoe rejected create-time (a non-transient 4xx on the multi-seller request) is split into two ordered halves
// so the failing seller is isolated with the FEWEST child creates; the caller recurses until a single seller remains
// (then isolates it as SOURCE_ACCOUNT_REJECTED). A single seller cannot be split -> returns [] (signal: isolate it).
// Every returned sub-batch is <= the input size, so a <=5-seller batch never yields an oversized child.
export function splitBatchAllowlist(allowlist) {
  const list = (Array.isArray(allowlist) ? allowlist : []).map((x) => String(x == null ? "" : x)).filter(Boolean);
  if (list.length <= 1) return [];
  const mid = Math.ceil(list.length / 2);
  return [list.slice(0, mid), list.slice(mid)];
}

// A ZERO-CREATE dry-run plan for ONE run kind. Returns per-region batches + the exact export count and the maximum
// token spend, so the human can authorize the spend against a proven balance BEFORE any create. Never creates.
//   accounts    : the dynamically-discovered [{accountId, marketplace}] list
//   runKind     : "initial" | "daily" | "monthly"  (chooses the window; presentational only here)
//   tokenPrice  : the CONFIRMED per-export token price (NEVER assumed -- caller passes the value read from DataDoe)
export function planCampaignRun({ accounts, runKind = "initial", tokenPrice = null } = {}) {
  const { byRegion, unassigned } = routeAccounts(accounts);
  const windowDays = runKind === "daily" ? CAMPAIGN_WINDOWS.dailyDays : runKind === "monthly" ? CAMPAIGN_WINDOWS.monthlyCorrectionDays : CAMPAIGN_WINDOWS.initialDays;
  const regions = [];
  let totalExports = 0;
  for (const region of [REGIONS.INDIA, REGIONS.EUROPE_AU, REGIONS.US_CA]) {
    const batches = batchAccounts(byRegion[region]);
    totalExports += batches.length; // ONE Campaign export per batch (mixed marketplaces allowed, <=5 sellers)
    regions.push({
      region, label: REGION_SCHEDULE[region].label, schedule: REGION_SCHEDULE[region],
      accountCount: byRegion[region].length, batchCount: batches.length,
      batches: batches.map((b) => ({ index: b.index, sellers: b.allowlist })),
    });
  }
  const maxTokenSpend = tokenPrice == null ? null : totalExports * Number(tokenPrice);
  return {
    runKind, windowDays, source: { id: CAMPAIGN_SOURCE_ID, key: "campaign-performance-v1" },
    regions, unassigned: unassigned.map((a) => ({ accountId: a.accountId, marketplace: S(a.marketplace ?? a.country) })),
    exportCount: totalExports,
    tokenPrice: tokenPrice == null ? null : Number(tokenPrice),
    maxTokenSpend,
    // The caller MUST prove balance >= maxTokenSpend before any create; unproven price => refuse.
    createReady: tokenPrice != null,
  };
}
