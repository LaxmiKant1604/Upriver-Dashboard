import React, { useCallback, useEffect, useMemo, useState } from "react";
import { DatabaseZap, LockKeyhole, PauseCircle, PlayCircle, RefreshCw } from "lucide-react";

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
        <button type="button" className="cache-refresh-btn" disabled={!!busyKey || card.paused} onClick={() => onSyncMissing(card)}>
          <RefreshCw size={14} className={syncBusy ? "spin" : ""} />
          {syncBusy ? "Syncing…" : "Sync missing data"}
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

  const syncMissing = async (card) => {
    setBusyKey(`sync:${card.sourceKey}`);
    setError(""); setNotice("");
    try {
      const response = await adminFetch("/api/admin/sources", accessToken, {
        method: "POST",
        body: JSON.stringify({ bucket, sourceKey: card.sourceKey }),
      });
      setData(response.status);
      const result = response.result || {};
      const note = result.stopped ? `stopped: ${result.stopReason?.code || "unknown"}` : (result.globalDrained ? "complete." : "more work remains; run again.");
      setNotice(`${card.label}: sync missing data ${note} Proven historical coverage is never re-exported.`);
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
          {bucketData.readiness.map((r) => (
            <div key={r.dashboard} className="sync-token-note">
              {r.ready
                ? `${DASHBOARD_LABELS[r.dashboard] || r.dashboard}: sources healthy${r.degradedBy.length ? ` (degraded: ${r.degradedBy.map((d) => `${d.sourceKey} · ${d.reason}`).join(", ")})` : ""}`
                : `${DASHBOARD_LABELS[r.dashboard] || r.dashboard}: blocked by ${r.blockedBy.map((b) => `${b.sourceKey} · ${b.reason}`).join(", ")}`}
            </div>
          ))}
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
    </main>
  );
}
