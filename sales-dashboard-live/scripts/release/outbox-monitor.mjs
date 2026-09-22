// DR2 OUTBOX MONITOR -- READ-ONLY health report for the transactional report_publication_outbox + its global gate.
// Emits queue age, per-status counts, retries/attempts, dead-letters, and rows carrying a last_error, so an operator (or
// the drain workflow) can watch publication lag and catch an accumulating backlog. It NEVER writes.
//
// SAFETY SIGNAL: exits NONZERO (so the drain workflow turns NON-GREEN and the breach is visible) when a hard invariant
// fails -- a DEAD-LETTER row (a poison publication that exhausted its retry budget and needs investigation), or a
// pending/claimed row OLDER than --alert-stale-minutes (default 180: the drain is not keeping up / is wedged). A healthy
// or empty queue exits 0. Transient signals (a few attempts, a recoverable last_error) are REPORTED but never fail.
//
// Usage: node scripts/release/outbox-monitor.mjs [--alert-stale-minutes=180]
import { loadReleaseEnv } from "./env-bootstrap.mjs";
loadReleaseEnv();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const staleMin = Number(argOf("alert-stale-minutes") || 180);
if (!(Number.isFinite(staleMin) && staleMin >= 10)) { console.error("STOP OUTBOX_MONITOR_STALE_MINUTES: --alert-stale-minutes must be a number >= 10; got " + staleMin); process.exit(2); }

const BASE = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !SVC) { console.error("STOP OUTBOX_MONITOR_SECRETS: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required (fail closed)."); process.exit(2); }
const q = async (path) => {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { headers: { apikey: SVC, authorization: `Bearer ${SVC}`, "content-type": "application/json" } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = null; }
  return { ok: r.ok, status: r.status, body: j, raw: t };
};

const ctl = await q("publication_outbox_control?select=enabled,updated_at");
const enabled = Array.isArray(ctl.body) && ctl.body[0] ? ctl.body[0].enabled === true : null;

// Read live rows (the table is source-grained + coalesced, so this stays small); page defensively.
const rows = [];
for (let off = 0; off < 20000; off += 1000) {
  const page = await q(`report_publication_outbox?select=id,status,account_id,source_key,requested_as_of,attempts,claimed_at,enqueued_at,updated_at,last_error&order=enqueued_at.asc&limit=1000&offset=${off}`);
  if (!page.ok || !Array.isArray(page.body)) { console.error("STOP OUTBOX_MONITOR_READ: report_publication_outbox read failed (status " + page.status + ")"); process.exit(2); }
  rows.push(...page.body); if (page.body.length < 1000) break;
}

const now = Date.now();
const byStatus = {};
let oldestOpenIso = null, oldestOpenAgeMin = 0, maxAttempts = 0, deadLetters = 0, withError = 0, claimedStuck = 0;
const OPEN = new Set(["pending", "claimed"]);
for (const r of rows) {
  byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  if (String(r.status) === "dead-letter") deadLetters += 1;
  if (r.last_error) withError += 1;
  if (Number(r.attempts) > maxAttempts) maxAttempts = Number(r.attempts);
  if (OPEN.has(String(r.status))) {
    const t = Date.parse(r.enqueued_at || r.updated_at || "");
    if (Number.isFinite(t)) {
      const ageMin = (now - t) / 60000;
      if (ageMin > oldestOpenAgeMin) { oldestOpenAgeMin = ageMin; oldestOpenIso = r.enqueued_at || r.updated_at; }
    }
  }
}

const staleBacklog = oldestOpenAgeMin > staleMin;
const breach = deadLetters > 0 || staleBacklog;
const result = {
  ok: !breach,
  outboxEnabled: enabled,
  liveRows: rows.length,
  byStatus,
  oldestOpenIso: oldestOpenIso || null,
  oldestOpenAgeMinutes: Math.round(oldestOpenAgeMin),
  maxAttempts, deadLetters, rowsWithError: withError,
  alertStaleMinutes: staleMin,
  breaches: [
    ...(deadLetters > 0 ? [`${deadLetters} dead-letter row(s) -- a publication exhausted its retry budget; investigate`] : []),
    ...(staleBacklog ? [`oldest open row is ${Math.round(oldestOpenAgeMin)}min old (> ${staleMin}min) -- the drain is not keeping up / is wedged`] : []),
  ],
};
console.log("OUTBOX_MONITOR " + JSON.stringify(result));
if (breach) { console.error("OUTBOX_MONITOR_ALERT: " + result.breaches.join("; ")); process.exit(1); }
console.log("outbox-monitor: healthy (enabled=" + enabled + ", liveRows=" + rows.length + ", oldestOpen=" + Math.round(oldestOpenAgeMin) + "min, deadLetters=0)");
process.exit(0);
