import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, DatabaseZap, History, LockKeyhole, MinusCircle, PauseCircle, PlayCircle, RefreshCw, XCircle } from "lucide-react";

async function adminFetch(path, accessToken, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

const fmtTs = (value) => (value ? new Date(value).toLocaleString() : "—");
const fmtCeiling = (spent, ceiling) => (ceiling == null ? `${spent} / —` : `${spent} / ${ceiling}`);
const DASHBOARD_LABELS = { "daily-reporting": "Daily Reporting", "brand-view": "Brand View" };

// ---- Report Delivery Status (read-only) ---------------------------------------------------------------------
const DELIVERY_REGION_OPTIONS = [
  { value: "india", label: "India" },
  { value: "europe-au", label: "Europe / Australia" },
  { value: "us-ca", label: "US / Canada" },
];
// Status is ALWAYS icon + text (never colour alone): each state maps to a lucide icon, a tone class, and a label.
const DELIVERY_STATUS_META = {
  Yes: { tone: "good", Icon: CheckCircle2 },
  No: { tone: "bad", Icon: XCircle },
  Waiting: { tone: "neutral", Icon: Clock },
  // LKG: a terminal cycle retained a previous-cycle last-known-good; the current cycle did NOT publish this report.
  // Warn tone (not neutral "in progress", not "bad" -- data IS live, just not current) with a distinct history icon.
  LKG: { tone: "warn", Icon: History },
  Unavailable: { tone: "warn", Icon: AlertTriangle },
  "Not applicable": { tone: "neutral", Icon: MinusCircle },
};
function DeliveryChip({ prefix, status, suffix }) {
  const meta = DELIVERY_STATUS_META[status] || DELIVERY_STATUS_META.Unavailable;
  const Icon = meta.Icon;
  return (
    <span className={`status-badge ${meta.tone} delivery-chip`} title={`${prefix}: ${status}${suffix ? ` (${suffix})` : ""}`}>
      <Icon size={13} aria-hidden="true" />
      <span>{prefix}: {status}{suffix ? ` · ${suffix}` : ""}</span>
    </span>
  );
}

function SourceCard({ card, busyKey, onPause, onSyncMissing }) {
  const s = card.status;
  const pauseBusy = busyKey === `pause:${card.sourceKey}`;
  const syncBusy = busyKey === `sync:${card.sourceKey}`;
  const statusTone = s.lastStatus === "succeeded" ? "good" : (card.paused || s.lastStatus === "never" ? "neutral" : "warn");
  return (
    <section className={`panel sync-report-card${card.paused ? " locked" : ""}`}>
      <div className="sync-report-title">
        <div><strong>{card.label}</strong><span>{card.tokenClass === "premium" ? "premium · 5 tokens/export" : "standard · 2 tokens/export"}</span></div>
        <span className={`status-badge ${statusTone}`}>{card.paused ? "Paused" : s.lastStatus}</span>
      </div>
      <div className="sync-report-meta">
        <span>Last attempt</span><strong>{fmtTs(s.lastAttemptAt)}</strong>
        <span>Last success</span><strong>{fmtTs(s.lastSuccessAt)}</strong>
        <span>Used by</span><strong>{card.usedBy.join(", ")}</strong>
        <span>Covered</span><strong>{s.coveredFrom && s.coveredTo ? `${s.coveredFrom} → ${s.coveredTo}` : "—"}</strong>
        <span>Accounts</span><strong>{`${s.accountsCompleted} ok / ${s.accountsFailed} failed / ${s.accountsTotal} total`}</strong>
        <span>Stable batches</span><strong>{s.batchCount}</strong>
        <span>Creates vs ceiling</span><strong>{fmtCeiling(s.createsSpent, s.createsCeiling)}</strong>
        <span>Tokens vs ceiling</span><strong>{fmtCeiling(s.tokensSpent, s.tokensCeiling)}</strong>
      </div>
      {s.safeErrorCode && <div className="sync-last-error">{s.safeErrorCode}{s.safeErrorStage ? ` · ${s.safeErrorStage}` : ""}</div>}
      <div className="sync-report-actions">
        <button type="button" className="plan-export-btn" disabled={!!busyKey} onClick={() => onPause(card)}>
          {card.paused ? <PlayCircle size={14} /> : <PauseCircle size={14} />}
          {pauseBusy ? "Saving…" : card.paused ? "Resume" : "Pause"}
        </button>
        <button type="button" className="cache-refresh-btn" disabled={!!busyKey || card.paused} onClick={() => onSyncMissing(card)} title="Admin only: spend DataDoe tokens to sync this source">
          <RefreshCw size={14} className={syncBusy ? "spin" : ""} />
          {syncBusy ? "Syncing…" : "Sync source"}
        </button>
      </div>
    </section>
  );
}

export default function DataSyncCenter({ accessToken }) {
  const [data, setData] = useState(null);
  const [reportData, setReportData] = useState(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [bucket, setBucket] = useState("non-us");
  const [notice, setNotice] = useState("");
  const [showReports, setShowReports] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  // Report Delivery Status (read-only) local state — all hooks stay above every early return (Rules of Hooks).
  const [showDelivery, setShowDelivery] = useState(false);
  const [delivery, setDelivery] = useState(null);
  const [deliveryError, setDeliveryError] = useState("");
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [deliveryRegion, setDeliveryRegion] = useState("india");
  const [deliveryCycle, setDeliveryCycle] = useState("");
  const [deliveryFailuresOnly, setDeliveryFailuresOnly] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [sources, reports] = await Promise.all([
        adminFetch("/api/admin/sources", accessToken),
        adminFetch("/api/admin/sync", accessToken).catch(() => null),
      ]);
      setData(sources);
      setReportData(reports);
    } catch (err) { setError(err.message); }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  // Read-only delivery-status fetch. GET only (never POST/PATCH) — it reads durable evidence and spends zero tokens.
  const loadDelivery = useCallback(async () => {
    setDeliveryLoading(true);
    setDeliveryError("");
    try {
      const qs = new URLSearchParams({ view: "delivery", region: deliveryRegion });
      if (deliveryCycle) qs.set("cycle", deliveryCycle);
      if (deliveryFailuresOnly) qs.set("failuresOnly", "true");
      const next = await adminFetch(`/api/admin/sync?${qs.toString()}`, accessToken);
      setDelivery(next);
    } catch (err) { setDeliveryError(err.message); setDelivery(null); }
    finally { setDeliveryLoading(false); }
  }, [accessToken, deliveryRegion, deliveryCycle, deliveryFailuresOnly]);

  // Load (and reload) the matrix only while the section is open and whenever a control changes. Lazy: nothing is
  // fetched until an admin opens the section.
  useEffect(() => { if (showDelivery) void loadDelivery(); }, [showDelivery, loadDelivery]);

  const bucketData = useMemo(() => data?.buckets?.[bucket] || null, [data, bucket]);

  const setPaused = async (card) => {
    setBusyKey(`pause:${card.sourceKey}`);
    setError(""); setNotice("");
    try {
      const next = await adminFetch("/api/admin/sources", accessToken, {
        method: "PATCH",
        body: JSON.stringify({ sourceKey: card.sourceKey, paused: !card.paused }),
      });
      setData(next);
      setNotice(`${card.label} ${card.paused ? "resumed" : "paused"}. Durable data and last-known-good snapshots are preserved.`);
    } catch (err) { setError(err.message); }
    finally { setBusyKey(""); }
  };

  // ONE trusted operation per click: the route runs bounded slices (sync the selected source, then derive +
  // publish every affected dashboard from the same evidence, safe-closing controls per slice); the UI POLLS the
  // typed continuation automatically until terminal -- the user never has to re-click, and busyKey guards a
  // double click from starting a second operation. Success is claimed ONLY after the route's live read-back.
  const syncMissing = async (card) => {
    if (busyKey) return; // double-click guard: one operation at a time
    setBusyKey(`sync:${card.sourceKey}`);
    setError(""); setNotice("");
    const startedBucket = bucket;
    try {
      const MAX_POLLS = 40;
      let terminalNote = null;
      for (let poll = 1; poll <= MAX_POLLS; poll += 1) {
        const response = await adminFetch("/api/admin/sources", accessToken, {
          method: "POST",
          body: JSON.stringify({ bucket: startedBucket, sourceKey: card.sourceKey }),
        });
        if (response.status) setData(response.status);
        const op = response.operation || null;
        if (op) {
          if (op.phase === "complete" && op.ok === true) {
            terminalNote = `${card.label}: source synced, dashboards updated (${op.published} accounts published + read back live).`;
            break;
          }
          if (op.continuationRequired === true) {
            setNotice(`${card.label}: ${op.phase === "sync" ? "syncing the source" : "publishing dashboards"}… (step ${poll}, continuing automatically)`);
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          terminalNote = `${card.label}: source synced, dashboard publication pending — ${op.phase} reported: ${(op.problems || []).join("; ") || "typed failure"}. Saved data is preserved.`;
          break;
        }
        // Legacy (non-orchestrated) result shape.
        const result = response.result || {};
        terminalNote = result.stopped
          ? `${card.label}: stopped: ${result.stopReason?.code || "unknown"}`
          : (result.globalDrained ? `${card.label}: sync complete.` : `${card.label}: more work remains; run again.`);
        break;
      }
      setNotice(terminalNote || `${card.label}: still running — reopen this page to continue the operation (no duplicate exports are possible).`);
    } catch (err) { setError(err.message); }
    finally { setBusyKey(""); }
  };

  const setSchedule = async (report, enabled) => {
    setBusyKey(`setting:${report.reportKey}`);
    setError(""); setNotice("");
    try {
      const next = await adminFetch("/api/admin/sync", accessToken, {
        method: "PATCH",
        body: JSON.stringify({ reportKey: report.reportKey, scheduleEnabled: enabled }),
      });
      setReportData(next);
      setNotice(`${report.label} schedule ${enabled ? "enabled" : "paused"}.`);
    } catch (err) { setError(err.message); }
    finally { setBusyKey(""); }
  };

  return (
    <main className="container sync-center">
      <div className="page-head sync-center-head">
        <div>
          <div className="page-title">Data Sync Center</div>
          <div className="page-sub">Source-level controls: one card per canonical DataDoe source family.</div>
        </div>
        <button type="button" className="plan-export-btn" onClick={load} disabled={!!busyKey}>
          <RefreshCw size={14} aria-hidden="true" /> Reload status
        </button>
      </div>

      <div className="data-alert warning sync-center-note">
        <DatabaseZap size={17} aria-hidden="true" />
        <div><strong>Automatic kickoff stays paused.</strong><div>{data?.note || "Every source schedule defaults OFF; enabling one requires a reviewed durable change."}</div></div>
      </div>

      <div className="panel sync-scope-panel">
        <label><span>Marketplace bucket</span><select value={bucket} onChange={(event) => setBucket(event.target.value)}><option value="non-us">Non-US · 07:30 IST</option><option value="us">US · 16:00 IST</option></select></label>
        <div className="sync-token-note">"Sync missing data" runs one bounded, coverage-driven pass for this bucket: at most five compatible accounts per export, and already-proven historical coverage is never re-exported.</div>
      </div>

      {error && <div className="data-alert error"><strong>Source control failed</strong><div>{error}</div></div>}
      {notice && <div className="data-alert success"><strong>{notice}</strong></div>}

      {bucketData && (
        <div className="panel sync-scope-panel">
          <strong>Dashboard readiness ({bucket})</strong>
          {bucketData.readiness?.unavailable ? (
            <div className="sync-token-note">Readiness evidence unavailable: {bucketData.readiness.unavailable}</div>
          ) : (
            ["daily", "brandView"].map((key) => {
              const r = bucketData.readiness?.[key];
              if (!r) return null;
              const label = DASHBOARD_LABELS[key === "daily" ? "daily-reporting" : "brand-view"];
              const blockers = (r.blockedBy || []).map((b) => `${b.sourceKey}${b.accountId ? ` [${b.accountId}]` : ""} · ${b.reason}`);
              return (
                <div key={key} className="sync-token-note">
                  {r.ready
                    ? `${label}: durable evidence proven${r.adsReady ? "" : " (ads coverage incomplete — ads half withheld)"}`
                    : `${label}: blocked by ${blockers.join(", ")}`}
                </div>
              );
            })
          )}
          {(bucketData.cardSummary || []).map((r) => (
            <div key={r.dashboard} className="sync-token-note">
              Card summary — {DASHBOARD_LABELS[r.dashboard] || r.dashboard}: {r.ready ? "sources healthy" : `blocked by ${r.blockedBy.map((b) => `${b.sourceKey} · ${b.reason}`).join(", ")}`}
            </div>
          ))}
        </div>
      )}

      {bucketData && Array.isArray(bucketData.oliQuality) && bucketData.oliQuality.length > 0 && (
        <div className="panel sync-scope-panel">
          <button type="button" className="plan-export-btn" onClick={() => setShowQuality((v) => !v)}>
            {showQuality ? "Hide" : "Show"} OLI data quality (per account)
          </button>
          {showQuality && (
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                <thead>
                  <tr style={{ textAlign: "left", opacity: 0.75 }}>
                    <th style={{ padding: "4px 8px" }}>Account</th>
                    <th style={{ padding: "4px 8px", textAlign: "right" }}>Explicit 0-value units</th>
                    <th style={{ padding: "4px 8px", textAlign: "right" }}>Cancelled units</th>
                    <th style={{ padding: "4px 8px", textAlign: "right" }}>Cancelled rows</th>
                    <th style={{ padding: "4px 8px" }}>Latest dimensional date</th>
                  </tr>
                </thead>
                <tbody>
                  {bucketData.oliQuality.map((q) => (
                    <tr key={q.accountId} style={{ borderTop: "1px solid var(--border, #eee)" }}>
                      <td style={{ padding: "4px 8px" }}>{String(q.accountId).slice(0, 8)}…</td>
                      <td style={{ padding: "4px 8px", textAlign: "right" }}>{q.unavailable ? "—" : Number(q.explicitZeroUnits || 0).toLocaleString("en-US")}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right" }}>{q.unavailable ? "—" : Number(q.cancelledUnits || 0).toLocaleString("en-US")}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right" }}>{q.unavailable ? "—" : Number(q.cancelledRows || 0).toLocaleString("en-US")}</td>
                      <td style={{ padding: "4px 8px" }}>{q.unavailable ? `unavailable (${q.unavailable})` : (q.latestDimensionalDate || "—")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="sync-token-note" style={{ marginTop: 6 }}>
                Explicit 0-value units (non-cancelled, order value present and exactly zero) and cancelled units are audit-only — excluded from Sales and Units Sold, kept separate from genuinely missing/blocked windows. Read-only; this never triggers a sync.
              </div>
            </div>
          )}
        </div>
      )}

      {!data ? <div className="panel sync-loading">Loading source controls…</div> : (
        <div className="sync-report-grid">
          {(bucketData?.cards || []).map((card) => (
            <SourceCard key={card.sourceKey} card={card} busyKey={busyKey} onPause={setPaused} onSyncMissing={syncMissing} />
          ))}
        </div>
      )}

      <div className="panel sync-scope-panel">
        <button type="button" className="plan-export-btn" onClick={() => setShowReports((v) => !v)}>
          {showReports ? "Hide" : "Show"} report schedules (legacy report-level controls)
        </button>
        {showReports && reportData && (
          <div className="sync-report-grid">
            {reportData.reports.map((report) => (
              <section className={`panel sync-report-card${report.ready ? "" : " locked"}`} key={report.reportKey}>
                <div className="sync-report-title"><div><strong>{report.label}</strong><span>{report.domain}</span></div>{report.ready ? <span className={`status-badge ${report.scheduleEnabled ? "good" : "neutral"}`}>{report.scheduleEnabled ? "Enabled" : "Paused"}</span> : <LockKeyhole size={16} aria-label="Not ready" />}</div>
                {!report.ready && <div className="sync-readiness">{report.readinessReason}</div>}
                <div className="sync-report-actions">
                  <button type="button" className="plan-export-btn" disabled={!report.ready || !!busyKey} onClick={() => setSchedule(report, !report.scheduleEnabled)}>
                    {report.scheduleEnabled ? <PauseCircle size={14} /> : <PlayCircle size={14} />}{busyKey === `setting:${report.reportKey}` ? "Saving…" : report.scheduleEnabled ? "Pause" : "Enable"}
                  </button>
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <div className="panel sync-scope-panel delivery-panel">
        <button type="button" className="plan-export-btn" onClick={() => setShowDelivery((v) => !v)}>
          {showDelivery ? "Hide" : "Show"} report delivery status (read-only, per account)
        </button>
        {showDelivery && (
          <>
            <div className="delivery-controls">
              <label><span>Region</span>
                <select value={deliveryRegion} onChange={(e) => { setDeliveryRegion(e.target.value); setDeliveryCycle(""); }}>
                  {DELIVERY_REGION_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
              <label><span>Scheduler cycle</span>
                <select value={deliveryCycle} onChange={(e) => setDeliveryCycle(e.target.value)}>
                  <option value="">Latest completed</option>
                  {(delivery?.availableCycleDates || []).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <label className="delivery-toggle"><input type="checkbox" checked={deliveryFailuresOnly} onChange={(e) => setDeliveryFailuresOnly(e.target.checked)} /><span>Failures only</span></label>
              <button type="button" className="plan-export-btn" onClick={loadDelivery} disabled={deliveryLoading}>
                <RefreshCw size={14} aria-hidden="true" className={deliveryLoading ? "spin" : ""} /> Reload status
              </button>
            </div>

            {deliveryError && <div className="data-alert error"><strong>Delivery status unavailable</strong><div>{deliveryError}</div></div>}
            {(delivery?.notes || []).map((n, i) => <div key={i} className="sync-token-note">{n}</div>)}

            {delivery?.summary && (
              <div className="delivery-summary">
                <span className="status-badge neutral">Accounts: {delivery.summary.accountCount}</span>
                <span className="status-badge neutral">Cycle: {delivery.cycleDate || "—"}{delivery.cycleAsOf ? ` (data as-of ${delivery.cycleAsOf})` : ""}{delivery.cycleStatus ? ` · ${delivery.cycleStatus}` : ""}</span>
                <span className={`status-badge ${delivery.summary.exportTotal > 0 && delivery.summary.exportYes === delivery.summary.exportTotal ? "good" : (delivery.summary.exportTotal === 0 ? "neutral" : "warn")}`}>Exported: {delivery.summary.exportYes} / {delivery.summary.exportTotal}</span>
                <span className={`status-badge ${delivery.summary.publishTotal > 0 && delivery.summary.publishYes === delivery.summary.publishTotal ? "good" : (delivery.summary.publishTotal === 0 ? "neutral" : "warn")}`}>Published: {delivery.summary.publishYes} / {delivery.summary.publishTotal}</span>
                {delivery.summary.failedCount > 0 && <span className="status-badge bad">Needs attention: {delivery.summary.failedCount}</span>}
                {delivery.summary.lkgCount > 0 && <span className="status-badge warn">Last-known-good retained: {delivery.summary.lkgCount}</span>}
                {delivery.summary.waitingCount > 0 && <span className="status-badge neutral">Waiting: {delivery.summary.waitingCount}</span>}
              </div>
            )}

            {deliveryLoading && !delivery ? <div className="sync-loading">Loading delivery status…</div> : null}
            {delivery && delivery.accounts.length === 0 ? <div className="sync-token-note">No accounts to show for this region and filter.</div> : null}

            {delivery && delivery.accounts.length > 0 && (
              <div className="delivery-table-wrap">
                <table className="delivery-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      {(delivery.accounts[0].reports || []).map((r) => <th key={r.sourceKey}>{r.label}</th>)}
                      <th>Remark</th>
                    </tr>
                  </thead>
                  <tbody>
                    {delivery.accounts.map((a) => (
                      <tr key={a.accountId} className={a.eligible ? "" : "delivery-ineligible"}>
                        <td className="delivery-acct">
                          <strong>{a.accountName || a.accountId}</strong>
                          <span className="delivery-ts">{String(a.accountId).slice(0, 10)} · {a.marketplace || "—"}{a.eligible ? "" : " · not eligible"}</span>
                        </td>
                        {a.reports.map((r) => (
                          <td key={r.sourceKey} title={r.dependentReports && r.dependentReports.length ? `Dashboards: ${r.dependentReports.join(", ")}` : undefined}>
                            <div className="delivery-cell">
                              <DeliveryChip prefix="Export" status={r.exportStatus} suffix={r.exportMode === "validated-reuse" ? "reuse" : null} />
                              <DeliveryChip prefix="Publish" status={r.publishStatus} suffix={r.publishStatus === "LKG" ? `${r.publicationCount}/${r.publicationExpected} · as-of ${r.publishLkgAsOf || "?"}` : (r.publicationExpected ? `${r.publicationCount}/${r.publicationExpected}` : null)} />
                              <div className="delivery-ts">{r.validatedAt ? fmtTs(r.validatedAt) : (r.sourceAsOf ? `as of ${r.sourceAsOf}` : "—")}{r.safeCode ? ` · ${r.safeCode}` : ""}</div>
                            </div>
                          </td>
                        ))}
                        <td className="delivery-remark">{a.remark}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="sync-token-note">Read-only: this view only reads durable evidence. It never triggers an export, a sync, or a publication, and spends zero DataDoe tokens.</div>
          </>
        )}
      </div>
    </main>
  );
}
