// Scheduler v2 -- the TRUSTED orchestration for a bounded "force latest" OLI re-fetch of the still-missing D-1
// rolling window. PURE control flow with every side effect INJECTED, so it is fully offline-testable and the
// operator/DSC wrappers only wire production collaborators.
//
// For each <=5-seller batch whose owners include a D-1-missing account, under the durable freshness reservation
// keyed to (operationKey, request_hash):
//   reserve -> 'reserved'      : this operation WON -> reopen the batch's OLI job to pending, then (once, after all
//                                reopens) run ONE forced fresh fetch (forceFreshOli skips stale-cache adoption), and
//                                record the resulting export id + 2 tokens.
//   reserve -> 'exists' + id   : this operation already forced this batch (a same-run replay) -> ADOPT (ZERO create).
//   reserve -> 'exists' no id  : a forced create is reserved but unrecorded (in-flight / commit-unknown) -> AMBIGUOUS;
//                                fail closed for this batch, NEVER a second create, NEVER a COMMIT_UNKNOWN retry.
// A forced fetch that does not end SUCCEEDED with an export id is left unrecorded (reservation stays 'reserved'); a
// later run for the SAME operationKey then sees 'exists' no id and fails closed -- so an ambiguous create is never
// blindly retried. A DIFFERENT authorized run_id (a new operationKey) may re-attempt the still-missing batch.

const S = (v) => (v == null ? "" : String(v));
const nb = (v) => S(v).trim() !== "";

/**
 * From the discovered D-1-MISSING accounts + the cycle's existing OLI jobs (each carrying its canonical
 * request_hash) + the owners (request_hash -> account ids), select the EXACT set of batch request_hashes that must
 * be re-fetched: a job whose owner set intersects the missing accounts. Returns [{ requestHash, accounts }] sorted,
 * deduped, so the same set is produced every run (deterministic). Only the missing batches -- never the whole bucket.
 */
export function planForceLatestBatches({ missingAccounts = [], oliJobs = [], owners = [] } = {}) {
  const missing = new Set((missingAccounts || []).map((a) => S(a && (a.accountId ?? a))).filter(nb));
  if (!missing.size) return [];
  const ownersByHash = new Map();
  for (const o of owners || []) {
    const h = S(o.request_hash ?? o.requestHash);
    const a = S(o.account_id ?? o.accountId);
    if (!nb(h) || !nb(a)) continue;
    if (!ownersByHash.has(h)) ownersByHash.set(h, new Set());
    ownersByHash.get(h).add(a);
  }
  const out = [];
  const seen = new Set();
  for (const j of oliJobs || []) {
    const h = S(j.request_hash ?? j.requestHash);
    if (!nb(h) || seen.has(h)) continue;
    const accts = ownersByHash.get(h) || new Set();
    const hit = [...accts].filter((a) => missing.has(a)).sort();
    if (hit.length) { seen.add(h); out.push({ requestHash: h, accounts: hit }); }
  }
  out.sort((a, b) => (a.requestHash < b.requestHash ? -1 : a.requestHash > b.requestHash ? 1 : 0));
  return out;
}

/**
 * Run the bounded force-latest re-fetch over the selected batches. deps:
 *   reserve(requestHash)      -> { disposition:'reserved'|'exists', exportId? }   (durable freshness reservation)
 *   reopenJob(requestHash)    -> { reopened:boolean, reason? }                    (cycle+job -> pending, guarded)
 *   runFreshOli()             -> any (runs ONE forced OLI pass; forceFreshOli skips stale-cache adoption)
 *   readJobExport(requestHash)-> { status, exportId }                             (the batch job's post-fetch state)
 *   record(requestHash, exportId, tokens) -> { disposition }                      (record the forced export)
 *   log(msg)                  -> optional
 * OLI standard export = 2 tokens. Returns { creates, tokens, adopted, ambiguous, reopened, fetched, problems }.
 */
export async function runOliForceLatest({ operationKey, batches, deps } = {}) {
  if (!nb(operationKey)) throw new Error("runOliForceLatest requires a non-blank operationKey (fail closed).");
  const { reserve, reopenJob, runFreshOli, readJobExport, record, log = () => {} } = deps || {};
  for (const [name, fn] of [["reserve", reserve], ["reopenJob", reopenJob], ["runFreshOli", runFreshOli], ["readJobExport", readJobExport], ["record", record]]) {
    if (typeof fn !== "function") throw new Error(`runOliForceLatest requires deps.${name} (fail closed).`);
  }
  const result = { creates: 0, tokens: 0, adopted: 0, ambiguous: 0, reopened: 0, fetched: 0, problems: [] };
  const toFetch = [];
  for (const b of batches || []) {
    const hash = S(b && (b.requestHash ?? b));
    if (!nb(hash)) { result.problems.push("blank-request-hash"); continue; }
    let res;
    try { res = await reserve(hash); } catch (e) { result.problems.push("reserve-error:" + hash.slice(0, 8)); continue; }
    const d = res && res.disposition;
    if (d === "exists" && nb(res.exportId)) { result.adopted += 1; log("adopt (idempotent replay) " + hash.slice(0, 8)); continue; }
    if (d === "exists") { result.ambiguous += 1; result.problems.push("ambiguous-reserved-unrecorded:" + hash.slice(0, 8)); log("AMBIGUOUS (reserved, unrecorded -- no second create) " + hash.slice(0, 8)); continue; }
    if (d !== "reserved") { result.problems.push("reserve-unexpected:" + S(d) + ":" + hash.slice(0, 8)); continue; }
    let re;
    try { re = await reopenJob(hash); } catch (e) { result.problems.push("reopen-error:" + hash.slice(0, 8)); continue; }
    if (!re || re.reopened !== true) { result.problems.push("reopen-refused:" + S(re && re.reason) + ":" + hash.slice(0, 8)); continue; }
    result.reopened += 1;
    toFetch.push(hash);
  }

  if (toFetch.length) {
    log("running ONE forced fresh OLI pass for " + toFetch.length + " reopened batch(es)");
    try { await runFreshOli(); } catch (e) { result.problems.push("fresh-oli-error:" + S(e && e.message)); }
    for (const hash of toFetch) {
      let j;
      try { j = await readJobExport(hash); } catch (e) { result.problems.push("job-read-error:" + hash.slice(0, 8)); continue; }
      // Only a job that ended SUCCEEDED with a real export id records the forced attempt. Anything else (failed,
      // still pending/attempted, blank export) is left UNRECORDED so the reservation stays 'reserved' -> a same-op
      // replay is AMBIGUOUS (no blind retry). The next authorized run_id may re-attempt.
      if (!j || S(j.status) !== "succeeded" || !nb(j.exportId)) { result.problems.push("fetch-not-succeeded:" + S(j && j.status) + ":" + hash.slice(0, 8)); continue; }
      let rec;
      try { rec = await record(hash, j.exportId, 2); } catch (e) { result.problems.push("record-error:" + hash.slice(0, 8)); continue; }
      const rd = rec && rec.disposition;
      if (rd !== "recorded" && rd !== "already-recorded") { result.problems.push("record-" + S(rd) + ":" + hash.slice(0, 8)); continue; }
      result.creates += 1;
      result.tokens += 2;
      result.fetched += 1;
    }
  }
  return result;
}
