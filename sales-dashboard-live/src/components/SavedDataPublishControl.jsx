/* =====================================================================
   SavedDataPublishControl -- the shared "Publish from saved data" control
   =====================================================================

   Renders ONLY for a report whose registry entry declares a tested zero-export single-scope executor
   (report-status.js SAVED_DATA_PUBLISH, pinned to the server registry) AND only while the server says it is enabled for
   this exact scope. A click records ONE durable request (the server deduplicates repeated clicks and answers "Already
   current" straight from the dashboard-served row); the page then follows the request's real state, which every user
   authorized for the scope sees. Nothing here builds, publishes or calls DataDoe: the separate executor does the work,
   and "Published and verified" appears only after it read the served row back. When a request this page saw in flight
   is verified, the page re-reads the report (read-only) so the new copy shows. Polling runs only while a request is
   active, backs off (publish-request-client.js nextPollDelayMs), pauses while the tab is hidden, and keeps the last good
   state through a transient failure. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import { savedDataPublishRoute } from "../lib/report-status.js";
import { describePublishState, isActiveStatus, nextPollDelayMs, statusUpdateFor } from "../lib/publish-request-client.js";

const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

// call(method, params) -> Promise<{ status, ok, body }> (App.jsx publishRequestCall; Bearer-authenticated, never cached).
export default function SavedDataPublishControl({ report, accountId, brand, asOf, call, onVerified }) {
  const route = savedDataPublishRoute(report);
  const [status, setStatus] = useState(null);
  const [local, setLocal] = useState(null);
  const [posting, setPosting] = useState(false);
  const [tick, setTick] = useState(0);           // bumped after EVERY poll (success or failure) -> re-arms the next one
  const [visible, setVisible] = useState(!pageHidden());
  const pollCount = useRef(0);
  const seenActive = useRef(new Set());           // request ids this page saw queued / publishing
  const notified = useRef(new Set());
  const scopeRef = useRef("");

  const params = useMemo(() => (route && accountId && brand && asOf ? { report, ids: accountId, brand, asOf } : null), [route, report, accountId, brand, asOf]);
  const scopeKey = params ? [params.report, params.ids, params.brand, params.asOf].join("|") : "";

  const readStatus = useCallback(async (forScope) => {
    if (!params || typeof call !== "function") return;
    try {
      const r = await call("GET", params);
      if (scopeRef.current !== forScope) return; // the user switched account / brand meanwhile
      const what = statusUpdateFor(r && r.status);
      if (what === "apply") setStatus(r.body);
      else if (what === "clear") setStatus(null);
      // "keep": a transient 5xx / 429 -- the last good state stays and the next poll retries
    } catch { /* network failure: keep the last good state; the next poll retries */ }
    finally { if (scopeRef.current === forScope) setTick((t) => t + 1); }
  }, [params, call]);

  // A new scope starts clean (never shows another brand's request).
  useEffect(() => {
    scopeRef.current = scopeKey;
    pollCount.current = 0;
    setStatus(null);
    setLocal(null);
    if (scopeKey) readStatus(scopeKey);
  }, [scopeKey, readStatus]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVis = () => setVisible(!pageHidden());
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const request = status && status.request ? status.request : null;
  const active = !!(request && isActiveStatus(request.status));
  if (active && request.id) seenActive.current.add(request.id);

  // Follow an ACTIVE request until it is terminal: re-armed after every poll (tick), backed off, paused while hidden.
  useEffect(() => {
    if (!scopeKey || !visible) return undefined;
    const delay = nextPollDelayMs({ request, consecutive: pollCount.current });
    if (delay == null) { pollCount.current = 0; return undefined; }
    const t = setTimeout(() => { pollCount.current += 1; readStatus(scopeKey); }, delay);
    return () => clearTimeout(t);
  }, [tick, visible, scopeKey, request, readStatus]);

  // A request this page saw in flight that is now VERIFIED re-reads the report once (read-only). A request that was
  // already finished when the page opened never triggers a reload.
  useEffect(() => {
    if (!request || !request.id || notified.current.has(request.id) || !seenActive.current.has(request.id)) return;
    if (request.status === "published" || request.status === "already_current") {
      notified.current.add(request.id);
      if (typeof onVerified === "function") onVerified();
    }
  }, [request, onVerified]);

  const onClick = useCallback(async () => {
    if (!params || posting || active || typeof call !== "function") return;
    const forScope = scopeKey;
    setPosting(true);
    setLocal(null);
    try {
      const r = await call("POST", params);
      if (scopeRef.current !== forScope) return;
      const body = (r && r.body) || {};
      if (r && r.status === 200 && body.state === "already_current") {
        setLocal({ phase: "already_current", salesLatestDate: body.served && body.served.salesLatestDate ? body.served.salesLatestDate : null });
      } else if (r && r.status === 202 && body.request) {
        pollCount.current = 0;
        if (body.request.id) seenActive.current.add(body.request.id);
        setStatus((s) => ({ ...(s || {}), enabled: true, request: body.request, executorOnline: body.executorOnline }));
      } else {
        setLocal({ phase: "error", message: body.message || body.error || "The request could not be recorded." });
        if (body.state === "as-of-rolled" || body.state === "not-enabled") readStatus(forScope);
      }
    } catch (e) {
      if (scopeRef.current === forScope) setLocal({ phase: "error", message: (e && e.message) || "The request could not be recorded." });
    } finally {
      setPosting(false);
    }
  }, [params, posting, active, call, scopeKey, readStatus]);

  // ---- render (every hook is above this line) ----
  if (!route || !params || !status || status.enabled !== true) return null;
  const view = describePublishState({ request, executorOnline: status.executorOnline !== false, local });
  const busy = posting || active;
  return (
    <div className="psd-control">
      <button
        type="button"
        className="plan-export-btn"
        onClick={onClick}
        disabled={busy}
        title="Publish this brand's report from data already saved in the dashboard. No DataDoe export is created and no tokens are used; the current report stays on screen until the new one is verified."
      >
        <UploadCloud size={14} className={busy ? "spin" : ""} aria-hidden="true" />
        {posting ? "Requesting..." : active ? view.label : "Publish from saved data"}
      </button>
      {view.label && (
        <span className={`psd-status psd-${view.tone}`} role="status" aria-live="polite">
          <b>{view.label}</b>{view.detail ? " - " + view.detail : ""}
        </span>
      )}
    </div>
  );
}
