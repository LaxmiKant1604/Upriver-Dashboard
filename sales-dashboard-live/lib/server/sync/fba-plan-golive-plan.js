// FBA Shipment Plan first-time GO-LIVE planning helpers (PURE, zero I/O). The token-spending refresh + publish
// runs in GitHub Actions (the DataDoe key lives only there); these helpers let the operator compute the honest
// go-live as-of + the exact bounded token cost with ZERO creates, so the plan is provable before any spend.

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Resolve the SINGLE go-live as-of date: the LATEST date (<= ceiling = server D-1) such that all but at most
 * `maxBlocked` target accounts have durable OLI coverage proving through it. Accounts whose durable OLI does not
 * reach the chosen as-of are honestly BLOCKED (they fail closed at derive -- never fabricated -- and publish on a
 * later run once their OLI catches up). A single as-of is required so the batched FBA Health/AWD exports share one
 * window (one identity per batch); each account is still independently coverage-checked in the durable loader.
 *
 * `provenByAccount`: [{ accountId, provenTo }] -- provenTo = the account's latest proven durable OLI date (or null).
 * Returns { asOf, included: [accountId], blocked: [{accountId, provenTo}] } (asOf null when none qualify).
 */
export function resolveGoLiveAsOf(provenByAccount, { ceiling, maxBlocked = 2 } = {}) {
  if (!isDate(ceiling)) throw new Error("resolveGoLiveAsOf requires a YYYY-MM-DD ceiling (server D-1).");
  const rows = (Array.isArray(provenByAccount) ? provenByAccount : [])
    .map((r) => ({ accountId: String(r.accountId || "").trim(), provenTo: isDate(r.provenTo) ? r.provenTo : null }))
    .filter((r) => r.accountId);
  const dated = rows.filter((r) => r.provenTo).map((r) => r.provenTo).sort(); // ascending
  if (!dated.length) return { asOf: null, included: [], blocked: rows.map((r) => ({ accountId: r.accountId, provenTo: r.provenTo })) };
  // Drop the `maxBlocked` lowest proven dates; the smallest of what remains is the most recent date all the KEPT
  // accounts still cover. Cap at the ceiling so we never claim a date past server D-1.
  const kept = dated.slice(Math.min(maxBlocked, dated.length));
  let asOf = kept.length ? kept[0] : dated[dated.length - 1];
  if (asOf > ceiling) asOf = ceiling;
  const included = [];
  const blocked = [];
  for (const r of rows) {
    if (r.provenTo && r.provenTo >= asOf) included.push(r.accountId);
    else blocked.push({ accountId: r.accountId, provenTo: r.provenTo });
  }
  return { asOf, included: included.sort(), blocked: blocked.sort((a, b) => a.accountId.localeCompare(b.accountId)) };
}

// The DataDoe token cost of a set of deduplicated planned source jobs: fba-plan's owned sources (FBA Inventory
// Health + AWD/listings) are PREMIUM (5 tokens); an already-adoptable job (in the cache) is 0. `adoptable` is the
// set/predicate of request_hashes already satisfiable with zero creates.
export const FBA_PREMIUM_TOKENS = 5;
export function fbaGoLiveTokenCost(sourceJobs, isAdoptable = () => false) {
  let creates = 0;
  let tokens = 0;
  const byFamily = {};
  for (const j of Array.isArray(sourceJobs) ? sourceJobs : []) {
    const hash = j.requestHash ?? j.request_hash;
    const family = j.sourceKey ?? j.source_key ?? "";
    byFamily[family] = byFamily[family] || { creates: 0, adoptable: 0 };
    if (isAdoptable(hash)) { byFamily[family].adoptable += 1; continue; }
    creates += 1;
    tokens += FBA_PREMIUM_TOKENS;
    byFamily[family].creates += 1;
  }
  return { creates, tokens, byFamily };
}
