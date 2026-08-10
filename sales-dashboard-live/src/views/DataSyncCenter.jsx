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

function latestTarget(targets, reportKey, accountId) {
  const rows = (targets || []).filter((row) => row.report_key === reportKey
    && (!accountId || row.account_id === accountId));
  return rows.sort((a, b) => String(b.last_attempt_at || "").localeCompare(String(a.last_attempt_at || "")))[0] || null;
}

export default function DataSyncCenter({ accessToken }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [bucket, setBucket] = useState("non-us");
  const [accountId, setAccountId] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try { setData(await adminFetch("/api/admin/sync", accessToken)); }
    catch (err) { setError(err.message); }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  const accounts = useMemo(() => (data?.accounts || []).filter((account) => {
    const rowBucket = account.sync_bucket || "unknown";
    return rowBucket === bucket;
  }), [data, bucket]);

  useEffect(() => {
    if (accountId && !accounts.some((account) => account.account_id === accountId)) setAccountId("");
  }, [accountId, accounts]);

  const setSchedule = async (report, enabled) => {
    setBusyKey(`setting:${report.reportKey}`);
    setError(""); setNotice("");
    try {
      const next = await adminFetch("/api/admin/sync", accessToken, {
        method: "PATCH",
        body: JSON.stringify({ reportKey: report.reportKey, scheduleEnabled: enabled }),
      });
      setData(next);
      setNotice(`${report.label} schedule ${enabled ? "enabled" : "paused"}.`);
    } catch (err) { setError(err.message); }
    finally { setBusyKey(""); }
  };

  const syncNow = async (report) => {
    setBusyKey(`sync:${report.reportKey}`);
    setError(""); setNotice("");
    try {
      const response = await adminFetch("/api/admin/sync", accessToken, {
        method: "POST",
        body: JSON.stringify({ reportKey: report.reportKey, bucket, accountId: accountId || null }),
      });
      setData(response.status);
      const result = response.result || {};
      setNotice(`${report.label}: ${result.counts?.succeeded || 0} synced, ${result.counts?.failed || 0} failed${result.drained ? "." : "; more work remains."}`);
    } catch (err) { setError(err.message); }
    finally { setBusyKey(""); }
  };

  return (
    <main className="container sync-center">
      <div className="page-head sync-center-head">
        <div>
          <div className="page-title">Data Sync Center</div>
          <div className="page-sub">Admin-only report scheduling and token-controlled manual sync.</div>
        </div>
        <button type="button" className="plan-export-btn" onClick={load} disabled={!!busyKey}>
          <RefreshCw size={14} aria-hidden="true" /> Reload status
        </button>
      </div>

      <div className="data-alert warning sync-center-note">
        <DatabaseZap size={17} aria-hidden="true" />
        <div><strong>Automatic kickoff is paused during Scheduler v2 review.</strong><div>{data?.schedule?.note || "Controls are safe to configure, but no automatic DataDoe run starts until rollout approval."}</div></div>
      </div>

      <div className="panel sync-scope-panel">
        <label><span>Marketplace schedule</span><select value={bucket} onChange={(event) => setBucket(event.target.value)}><option value="non-us">Non-US · 07:30 IST</option><option value="us">US · 16:00 IST</option></select></label>
        <label><span>Manual sync account</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">All accounts in this bucket</option>{accounts.map((account) => <option key={account.account_id} value={account.account_id}>{account.name} · {account.marketplace_country_code}</option>)}</select></label>
        <div className="sync-token-note">Manual sync calls DataDoe only for the selected report and scope. Selecting all accounts can still create multiple exports because DataDoe allows at most five IDs per request.</div>
      </div>

      {error && <div className="data-alert error"><strong>Sync control failed</strong><div>{error}</div></div>}
      {notice && <div className="data-alert success"><strong>{notice}</strong></div>}

      {!data ? <div className="panel sync-loading">Loading report controls…</div> : (
        <div className="sync-report-grid">
          {data.reports.map((report) => {
            const status = latestTarget(data.targets, report.reportKey, accountId);
            const settingBusy = busyKey === `setting:${report.reportKey}`;
            const syncBusy = busyKey === `sync:${report.reportKey}`;
            return (
              <section className={`panel sync-report-card${report.ready ? "" : " locked"}`} key={report.reportKey}>
                <div className="sync-report-title"><div><strong>{report.label}</strong><span>{report.domain}</span></div>{report.ready ? <span className={`status-badge ${report.scheduleEnabled ? "good" : "neutral"}`}>{report.scheduleEnabled ? "Enabled" : "Paused"}</span> : <LockKeyhole size={16} aria-label="Not ready" />}</div>
                <div className="sync-report-meta"><span>Last status</span><strong>{status?.last_status || "Never run"}</strong><span>Last success</span><strong>{status?.last_success_at ? new Date(status.last_success_at).toLocaleString() : "—"}</strong></div>
                {status?.last_error && <div className="sync-last-error">{status.last_error}</div>}
                {!report.ready && <div className="sync-readiness">{report.readinessReason}</div>}
                <div className="sync-report-actions">
                  <button type="button" className="plan-export-btn" disabled={!report.ready || !!busyKey} onClick={() => setSchedule(report, !report.scheduleEnabled)}>
                    {report.scheduleEnabled ? <PauseCircle size={14} /> : <PlayCircle size={14} />}{settingBusy ? "Saving…" : report.scheduleEnabled ? "Pause" : "Enable"}
                  </button>
                  <button type="button" className="cache-refresh-btn" disabled={!report.ready || !!busyKey} onClick={() => syncNow(report)}>
                    <RefreshCw size={14} className={syncBusy ? "spin" : ""} />{syncBusy ? "Syncing…" : "Sync now"}
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
