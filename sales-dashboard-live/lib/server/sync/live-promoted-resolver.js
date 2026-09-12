// The SHARED strict live-promoted-snapshot proof body. ONE implementation of "is this live report_snapshots row a
// genuine, exact-identity, storage-hydrated, contract-valid promotion?", used by BOTH the reconciler's post-publish
// read-back (buildLiveReadback, which discards the payload) AND the serve resolver (which needs the payload to send).
//
// The proof chain (fail-closed, in order): a live contract exists for reportKey; liveReportKey === contract.liveReportKey;
// paramsHash nonblank; the EXACT-identity row read (report_key + account_id + params_hash -- NEVER a latest-pointer);
// the ROW's own column identity echoes (report_key/account_id/params_hash); the stored params carry the exact live
// report version + contract-derived live params and RE-derive paramsHash (a mutated-after-save row fails provenance);
// a nonblank source_refreshed_at; STORAGE-FIRST payload hydration (a nonblank payload_storage_path is authoritative --
// a dangling storage object fails, and there is NEVER a partial inline fallback when a storage path is present; inline
// is used ONLY when the path is blank); and the REAL frontend payload contract (validatePayload true + not
// dataUnavailable). The AbortSignal threads through the row read AND the storage hydration. Returns { ok, reason?,
// payload? } -- `payload` is the hydrated payload on ok (undefined otherwise). PURE of transport: every read is injected.
// 7-bit ASCII, LF.

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

export function buildLivePromotedResolver({ getReportSnapshot, loadStoragePayload, liveContracts, reportDerivations, computeHash } = {}) {
  for (const [name, fn] of [["getReportSnapshot", getReportSnapshot], ["loadStoragePayload", loadStoragePayload], ["computeHash", computeHash]]) {
    if (typeof fn !== "function") throw new Error(`buildLivePromotedResolver requires ${name} (fail closed).`);
  }
  if (!liveContracts || !reportDerivations) throw new Error("buildLivePromotedResolver requires liveContracts + reportDerivations (fail closed).");
  return async ({ reportKey, liveReportKey, accountId, paramsHash, signal = null }) => {
    const contract = liveContracts[reportKey];
    if (!contract) return { ok: false, reason: "no-live-contract" };
    if (liveReportKey !== contract.liveReportKey) return { ok: false, reason: "live-report-key-mismatch" };
    if (!nb(paramsHash)) return { ok: false, reason: "blank-params-hash" };
    const snap = await getReportSnapshot({ reportKey: liveReportKey, accountId, paramsHash }, { signal });
    if (!snap) return { ok: false, reason: "no-live-snapshot" };
    if (S(snap.report_key) !== S(liveReportKey)) return { ok: false, reason: "identity-report-key" };
    if (S(snap.account_id) !== S(accountId)) return { ok: false, reason: "identity-account" };
    if (S(snap.params_hash) !== S(paramsHash)) return { ok: false, reason: "identity-hash" };
    const params = snap.params && typeof snap.params === "object" && !Array.isArray(snap.params) ? snap.params : null;
    if (!params || params.reportVersion !== contract.liveReportVersion) return { ok: false, reason: "live-version" };
    const liveParams = contract.liveParams(params);
    if (!liveParams || computeHash(contract.liveReportVersion, liveParams) !== paramsHash) return { ok: false, reason: "params-provenance" };
    if (!nb(snap.source_refreshed_at)) return { ok: false, reason: "blank-refresh" };
    let payload;
    const path = S(snap.payload_storage_path).trim();
    if (path) { try { payload = await loadStoragePayload(path, { signal }); } catch { payload = null; } if (payload == null) return { ok: false, reason: "payload-dangling" }; }
    else { payload = snap.payload; if (payload == null) return { ok: false, reason: "payload-unavailable" }; }
    const entry = reportDerivations[reportKey];
    if (!entry || typeof entry.validatePayload !== "function" || entry.validatePayload(payload) !== true || (payload && payload.dataUnavailable === true)) return { ok: false, reason: "payload-contract" };
    // OPTIONAL per-report SEMANTIC identity: prove the payload's OWN account/date/window agree with the requested
    // account + the live params.to. A report contract with no hook is byte-for-byte unchanged (OLI/FBA/Ads); only
    // listing-health-v3 defines one today. A structurally-valid but wrong-account / wrong-day / wrong-window payload
    // fails here (it can never masquerade as this account's exact-D-1 promotion).
    if (typeof contract.semanticIdentity === "function") {
      const sem = contract.semanticIdentity(payload, { accountId, to: liveParams.to });
      if (!sem || sem.ok !== true) return { ok: false, reason: "semantic-identity:" + S(sem && sem.reason) };
    }
    return { ok: true, payload };
  };
}
