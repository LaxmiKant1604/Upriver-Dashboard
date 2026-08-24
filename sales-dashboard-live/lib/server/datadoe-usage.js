// Scheduler v2 -- READ-ONLY DataDoe token-balance helpers for the pre-create token-confirmation gate.
//
// DataDoe exposes no dedicated balance endpoint, but every /usage-logs row records the pool balances AFTER that
// event (balanceAfter + extraTokensAfter + bundleTokensAfter). The LATEST row therefore carries the current
// usable balance. Reading the log spends ZERO tokens. Auth header is `datadoe-api-key` (NOT Bearer), matching
// lib/server/datadoe.js. The apiKey is never logged.

// Kept in sync with DATADOE_BASE in lib/server/datadoe.js (decoupled here so this read-only helper pulls none of
// the export/poll machinery).
const DATADOE_BASE = "https://api.datadoe.com/api/v1";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Read the CURRENT usable DataDoe token balance from the most recent usage-log row. Returns
 * { read: "ok", usable, pools:{ balance, extra, bundle }, asOf } on success, or { read: "empty"|"error", usable: null }
 * when the balance cannot be established (fail-closed for the gate). Injectable fetchImpl for offline tests.
 */
export async function getDataDoeTokenBalance({ apiKey, fetchImpl = fetch, signal = null } = {}) {
  if (!apiKey) throw new Error("getDataDoeTokenBalance requires an apiKey (fail closed).");
  let res;
  try {
    res = await fetchImpl(`${DATADOE_BASE}/usage-logs?pageSize=100`, { headers: { "datadoe-api-key": apiKey }, ...(signal ? { signal } : {}) });
  } catch (e) {
    return { read: "error", usable: null, reason: "usage-logs-fetch-failed" };
  }
  if (!res || !res.ok) return { read: "error", usable: null, reason: "usage-logs-http-" + (res ? res.status : "no-response") };
  let body;
  try { body = await res.json(); } catch { return { read: "error", usable: null, reason: "usage-logs-bad-json" }; }
  const rows = Array.isArray(body && body.data) ? body.data : (Array.isArray(body) ? body : []);
  if (!rows.length) return { read: "empty", usable: null, reason: "no-usage-rows" };
  // The most recent event by usedAt carries the live pool balances.
  const latest = rows.slice().sort((a, b) => String(b && b.usedAt).localeCompare(String(a && a.usedAt)))[0];
  const pools = { balance: num(latest.balanceAfter), extra: num(latest.extraTokensAfter), bundle: num(latest.bundleTokensAfter) };
  return { read: "ok", usable: pools.balance + pools.extra + pools.bundle, pools, asOf: String(latest.usedAt || "") };
}

export const COMBINED_DAILY_TOKEN_CEILING = 30; // OLI+Catalog (<=16) + ASIN Ads (<=14)

/**
 * Confirm at least `required` usable tokens BEFORE the first create. FAIL-CLOSED: a null / failed / empty balance
 * read is NOT a confirmation (never assume tokens exist). Returns { confirmed, usable, required, reason? }.
 */
export function confirmUsableTokens(balance, required = COMBINED_DAILY_TOKEN_CEILING) {
  const ok = balance && balance.read === "ok" && Number.isFinite(balance.usable);
  if (!ok) return { confirmed: false, usable: null, required, reason: (balance && balance.reason) || "unreadable-balance" };
  return { confirmed: balance.usable >= required, usable: balance.usable, required, reason: balance.usable >= required ? null : "insufficient-tokens" };
}
