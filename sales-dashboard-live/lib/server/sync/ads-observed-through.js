// EXPORT COMPLETED vs DATA OBSERVED for Campaign Ads (India 2026-10-07). ads_sync_coverage records the window an export
// was REQUESTED for; ads_sync_state.latest_metric_date is the newest day the provider actually sent a row for. A day in
// between has NO row received -- delayed data or genuinely no ad activity, the provider does not say which -- so it is
// unknown in every report (never zero) and is requested again by the next rolling window.
// PURE (no I/O): the scheduled Campaign refresh feeds it the region's states and prints the result.

const CAMPAIGN_SOURCE_KEY = "campaign-performance-v1";
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * { accountIds, states, requestedAsOf } -> {
 *   reportedThrough: [id]                     -- the account's rows reach requestedAsOf
 *   noRowForDate:    [{ id, observedThrough }] -- its last sync succeeded but no row was received for requestedAsOf
 *   noRows:          [id]                     -- no Campaign row has ever been saved (no advertising recorded)
 *   failed:          [id]                     -- the last Campaign sync failed (last-known-good kept; reported elsewhere)
 * }
 * An account without a state row counts as noRows. Ids are returned as given (callers print 8-character prefixes).
 */
export function campaignObservedThrough({ accountIds = [], states = [], requestedAsOf } = {}) {
  const out = { reportedThrough: [], noRowForDate: [], noRows: [], failed: [] };
  if (!isDay(requestedAsOf)) return out;
  const byId = new Map();
  for (const st of Array.isArray(states) ? states : []) {
    if (st && String(st.source_key) === CAMPAIGN_SOURCE_KEY && st.account_id != null) byId.set(String(st.account_id), st);
  }
  for (const raw of accountIds) {
    const id = String(raw);
    const st = byId.get(id);
    if (st && String(st.last_status) === "failed") { out.failed.push(id); continue; }
    const latest = st && isDay(String(st.latest_metric_date || "").slice(0, 10)) ? String(st.latest_metric_date).slice(0, 10) : null;
    if (!latest) { out.noRows.push(id); continue; }
    if (latest >= requestedAsOf) out.reportedThrough.push(id);
    else out.noRowForDate.push({ id, observedThrough: latest });
  }
  return out;
}
