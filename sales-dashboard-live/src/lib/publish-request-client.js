/* =====================================================================
   publish-request-client -- the "Publish from saved data" control's PURE state
   =====================================================================

   Turns what the endpoint (api/datadoe.js action=publish-request) answered into the one line the control shows.
   Honest states only: Queued (and WHY it waits), Publishing, Published and verified, Already current, Source data
   unavailable, Failed (with the reason). "Published" is shown only when the executor read the exact dashboard-served row
   back and it matched the saved evidence -- the server never records it otherwise. Pure and framework-free. */

export const ACTIVE_STATUSES = Object.freeze(["queued", "publishing"]);
export const isActiveStatus = (s) => ACTIVE_STATUSES.includes(String(s || ""));

// POLLING (only while this scope has an ACTIVE request): 5 s, 5 s, 15 s, 15 s, 30 s, then every 60 s; every 60 s at
// once when the request says it is WAITING (a scheduler run can take hours). The control also pauses while the tab is
// hidden. -> milliseconds, or null (stop: no active request).
const POLL_STEPS_MS = Object.freeze([5000, 5000, 15000, 15000, 30000]);
export const POLL_MAX_MS = 60000;
export function nextPollDelayMs({ request = null, consecutive = 0 } = {}) {
  if (!request || !isActiveStatus(request.status)) return null;
  if (request.waiting) return POLL_MAX_MS;
  const n = Math.max(0, Math.floor(Number(consecutive) || 0));
  return n < POLL_STEPS_MS.length ? POLL_STEPS_MS[n] : POLL_MAX_MS;
}
/** What a status GET answer does to the last good state: apply it, clear it (the scope is no longer valid for this
 *  user / date), or KEEP it (a transient 5xx / 429 / network failure -- the poll simply tries again). */
export function statusUpdateFor(httpStatus) {
  const h = Number(httpStatus);
  if (h >= 200 && h < 300) return "apply";
  if ([400, 401, 403, 404, 409].includes(h)) return "clear";
  return "keep";
}

// Why a queued request is waiting (the executor's load gates; reason 'waiting:<code>').
const WAITING_TEXT = Object.freeze({
  "scheduler-running": "waiting for today's scheduled refresh to finish",
  "control-lease-held": "waiting for another publication to finish",
  "control-plane-open": "waiting for another publication to close",
  "controls-unresolved": "waiting for another publication to close",
  "database-slow": "waiting: the database is busy",
  "auth-slow": "waiting: the database is busy",
  "gate-probe-failed": "waiting: the database is busy",
  "control-state-unreadable": "waiting: the database is busy",
  "cron-present": "waiting for an operator check",
});
export function waitingText(code) {
  const c = String(code || "");
  const base = c.split(":")[0];
  return WAITING_TEXT[base] || (c ? "waiting to retry" : "");
}

// Plain-language reasons for the terminal states (the code stays visible for support).
const REASON_TEXT = Object.freeze({
  "brand-not-in-saved-directory": "this brand is not in the account's saved data",
  "brand-not-sold": "the saved sales do not include this brand",
  "no-sales-snapshot": "no saved sales are available for this account",
  "brand-directory-unpublished": "the account's saved brand list is not available yet",
  "ads-rows-evidence-missing": "the saved advertising data is not available",
  "account-not-in-durable-directory": "the account is not in the saved account list",
  "as-of-rolled": "the report date changed before publishing; request it again",
  "superseded-newer-live": "a newer report was published meanwhile",
  "zero-export-violation": "stopped for safety",
});
export function reasonText(reason) {
  const r = String(reason || "");
  for (const [k, v] of Object.entries(REASON_TEXT)) if (r === k || r.startsWith(k + ":") || r.includes(k)) return v;
  if (r.startsWith("attempts-exhausted")) return "it could not be completed after several attempts";
  return "";
}

/**
 * The control's display state from the latest status body (GET) and/or the last POST answer.
 * -> { phase, label, detail, tone: 'neutral'|'busy'|'good'|'warn'|'bad', active }
 */
export function describePublishState({ request = null, executorOnline = true, local = null } = {}) {
  if (local && local.phase === "already_current") {
    return { phase: "already_current", label: "Already current", detail: local.salesLatestDate ? `Saved data through ${local.salesLatestDate} is already on the dashboard.` : "The dashboard already shows the latest saved data.", tone: "good", active: false };
  }
  if (local && local.phase === "error") return { phase: "error", label: "Not published", detail: local.message || "The request could not be recorded.", tone: "bad", active: false };
  if (!request) return { phase: "idle", label: "", detail: "", tone: "neutral", active: false };
  const s = String(request.status || "");
  const who = request.requestedByMe ? "" : " (requested by another user)";
  if (s === "queued") {
    const why = request.waiting ? waitingText(request.waiting) : "";
    const offline = executorOnline === false ? "the publisher is offline; it will run when the publisher is back" : "";
    return { phase: "queued", label: "Queued", detail: [why || offline, who.trim()].filter(Boolean).join(" ") || "Waiting for the publisher.", tone: "busy", active: true };
  }
  if (s === "publishing") return { phase: "publishing", label: "Publishing", detail: `Publishing this brand from saved data${who}.`, tone: "busy", active: true };
  if (s === "published") {
    const through = request.served && request.served.salesLatestDate ? ` Saved data through ${request.served.salesLatestDate}.` : "";
    return { phase: "published", label: "Published and verified", detail: `The dashboard now serves the report built from saved data.${through}`, tone: "good", active: false };
  }
  if (s === "already_current") return { phase: "already_current", label: "Already current", detail: "The dashboard already shows the latest saved data.", tone: "good", active: false };
  if (s === "missing_evidence") {
    const t = reasonText(request.reason);
    return { phase: "missing_evidence", label: "Source data unavailable", detail: `Nothing was published: ${t || "the saved data needed for this report is missing"}. The previous report stays on screen.`, tone: "warn", active: false };
  }
  if (s === "failed") {
    const t = reasonText(request.reason);
    return { phase: "failed", label: "Failed", detail: `The publication could not be verified${t ? ": " + t : ""}. The dashboard keeps showing its last published report.`, tone: "bad", active: false };
  }
  return { phase: "unknown", label: "", detail: "", tone: "neutral", active: false };
}
