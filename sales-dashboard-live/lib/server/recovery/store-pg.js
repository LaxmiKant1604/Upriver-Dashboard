// Publication recovery worker -- Postgres store: thin wrappers over the 20260934 RPCs + READ-ONLY metadata queries
// (evidence watermark tokens, scheduler/lease gates, detect-only observations). It NEVER writes report_snapshots, the
// control plane, sync tables, or any source table; it never loads a source payload (metadata columns only).

import pg from "pg";

const S = (v) => (v == null ? "" : String(v));
const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? "" : String(v));

/** Pure: compose per-family evidence tokens from metadata rows (exported for tests). */
export function composeEvidenceTokens({ oli = [], oliCompleteness = [], fba = [], ads = [], listings = [], catalog = null }) {
  const oliTok = new Map();
  const comp = new Map(oliCompleteness.map((r) => [S(r.account_id), iso(r.refreshed)]));
  for (const r of oli) oliTok.set(S(r.account_id), `cov:${S(r.covered_to)}@${iso(r.refreshed)}|cmp:${comp.get(S(r.account_id)) || "-"}`);
  const fbaTok = new Map(fba.map((r) => [S(r.account_id), `fba:${S(r.source_request_hash)}:${S(r.payload_sha)}`]));
  const adsTok = new Map(ads.map((r) => [S(r.account_id), `ads:${S(r.revs)}`]));
  const cat = catalog ? `cat:${S(catalog.payload_sha)}` : "cat:-";
  const lstTok = new Map();
  for (const r of listings) {
    const a = S(r.account_id);
    lstTok.set(a, `lst:${S(r.l_sha)}@${iso(r.l_at)}|raw:${S(r.r_sha) || "-"}@${iso(r.r_at) || "-"}|${fbaTok.get(a) || "fba:-"}|${cat}|${oliTok.get(a) || "oli:-"}`);
  }
  return { oli: oliTok, fba: fbaTok, ads: adsTok, listings: lstTok };
}

// A Postgres `date` (OID 1082) is returned as its exact 'YYYY-MM-DD' text. node-postgres' default parses it to a JS Date
// at LOCAL midnight, whose toISOString() is the PREVIOUS day on any host east of UTC -- which would make every claimed
// job look like an older as-of and be superseded. Scoped to this pool (never the global pg.types).
const DATE_OID = 1082;
export const recoveryPgTypes = Object.freeze({
  getTypeParser: (oid, format) => (oid === DATE_OID && format !== "binary" ? (v) => v : pg.types.getTypeParser(oid, format)),
});

/** Region a scheduler-v2 sync_cycles bucket belongs to (null for legacy us/non-us or unknown buckets). */
export function regionForCycleBucket(bucket) {
  const m = /^(?:listing-health-v3-|bootstrap-(?:fba-)?|priority-partial-)?(india|europe-au|us-ca)(?:-fba)?(?:-[0-9a-f]{16})?$/.exec(S(bucket));
  return m ? m[1] : null;
}

/**
 * The pooled connection string, exactly as the release scripts build it: sslmode FORCED to no-verify. The production
 * POSTGRES_URL carries sslmode=require, which pg-connection-string >= 2.x treats as verify-full -- the Supabase pooler
 * chain then fails with SELF_SIGNED_CERT_IN_CHAIN. A malformed URL throws a REDACTED error (Node's own ERR_INVALID_URL
 * would print the whole value, password included).
 */
export function recoveryConnectionString(connectionString) {
  let url;
  try { url = new URL(String(connectionString || "")); }
  catch { throw new Error("POSTGRES_URL is not a valid URL (value not printed; check for unencoded / # ? in the password, or stray quotes)"); }
  url.searchParams.set("sslmode", "no-verify");
  return url.toString();
}

export function createRecoveryStore({ connectionString, max = 2, poolImpl = null, onError = () => {} }) {
  const pool = poolImpl || new pg.Pool({ connectionString: recoveryConnectionString(connectionString), max, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000, statement_timeout: 60000, types: recoveryPgTypes });
  // pg-pool re-emits an IDLE client's error (pooler restart, network drop) on the pool; without a listener that is an
  // uncaught exception that would kill the worker (and, via KillMode=mixed, a live child). Log the code only.
  if (typeof pool.on === "function") pool.on("error", (e) => { try { onError(String((e && e.code) || "error")); } catch { /* ignore */ } });
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0] || null;

  return {
    async control() {
      const r = await one("select enabled, live_families from public.publication_recovery_control where id = true");
      return { enabled: !!(r && r.enabled), liveFamilies: (r && r.live_families) || [] };
    },
    async enqueue({ family, region, accountId, asOf, token, origin, priority }) {
      const r = await one("select public.enqueue_publication_recovery_job($1,$2,$3,$4::date,$5,$6,$7::smallint) as d", [family, region, accountId, asOf, token, origin, priority]);
      return r && r.d;
    },
    async claim({ workerId, claimToken, limit, leaseSeconds, maxClaims }) {
      return q("select * from public.claim_publication_recovery_jobs($1,$2::uuid,$3,$4,$5)", [workerId, claimToken, limit, leaseSeconds, maxClaims]);
    },
    async renewClaim({ ids, claimToken, leaseSeconds }) {
      const r = await one("select public.renew_publication_recovery_claim($1::uuid[],$2::uuid,$3) as n", [ids, claimToken, leaseSeconds]);
      return Number(r && r.n) || 0;
    },
    async finish({ id, claimToken, outcome, cls, reason, backoff, maxAttempts, runToken, evaluatedToken }) {
      const r = await one("select public.finish_publication_recovery_job($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9) as d", [id, claimToken, outcome, cls, reason, backoff, maxAttempts, runToken, evaluatedToken]);
      return r && r.d;
    },
    async recordBaseline(rows) { if (!rows.length) return 0; const r = await one("select public.record_publication_recovery_baseline($1::jsonb) as n", [JSON.stringify(rows)]); return Number(r && r.n) || 0; },
    async recordObservations(rows) { if (!rows.length) return 0; const r = await one("select public.record_publication_recovery_observations($1::jsonb) as n", [JSON.stringify(rows)]); return Number(r && r.n) || 0; },
    async beat({ workerId, host, pid, version, mode, startedAt, lastErrorCode, stats }) {
      await q("select public.beat_publication_recovery_worker($1,$2,$3,$4,$5,$6::timestamptz,$7,$8::jsonb)", [workerId, host, pid, version, mode, startedAt, lastErrorCode, JSON.stringify(stats || {})]);
    },
    async tryBeginScan({ holder, leaseSeconds, minIntervalSeconds }) {
      const r = await one("select public.try_begin_publication_recovery_scan($1,$2,$3) as ok", [holder, leaseSeconds, minIntervalSeconds]); return !!(r && r.ok);
    },
    async renewScan({ holder, leaseSeconds }) { const r = await one("select public.renew_publication_recovery_scan($1,$2) as ok", [holder, leaseSeconds]); return !!(r && r.ok); },
    async finishScan({ holder, outcome, summary }) { const r = await one("select public.finish_publication_recovery_scan($1,$2,$3::jsonb) as ok", [holder, outcome, JSON.stringify(summary || {})]); return !!(r && r.ok); },
    async prune(keepDays) { const r = await one("select public.prune_publication_recovery($1) as n", [keepDays]); return Number(r && r.n) || 0; },
    async status(limit = 200) { const r = await one("select public.publication_recovery_status($1) as s", [limit]); return r && r.s; },

    /** The reconciler-scoped accounts the latest scan recorded for this as-of (the watermark pass watches ONLY these). */
    async readScope({ asOf }) {
      return q("select family, region, account_id, verified_token, observed_token from public.publication_recovery_state where requested_as_of = $1::date", [asOf]);
    },
    /** Open (pending/claimed/deferred) jobs for an as-of -- dependency ordering (fba/ads await oli). */
    async readOpenJobs({ asOf }) {
      return q("select family, region, account_id, status from public.publication_recovery_jobs where requested_as_of = $1::date and status in ('pending','claimed','deferred')", [asOf]);
    },
    /** METADATA-ONLY evidence tokens (no payload is ever loaded). */
    async readEvidenceTokens({ asOf, adsWorkerKeys }) {
      const [oli, oliCompleteness, fba, ads, listings, catalog] = await Promise.all([
        q("select account_id, max(covered_to)::text covered_to, max(source_refreshed_at) refreshed from public.source_coverage where connection_id = 'primary' and source_key = 'order-line-items' and status = 'succeeded' group by account_id"),
        q("select account_id, max(refreshed_at) refreshed from public.source_oli_completeness where connection_id = 'primary' and sale_date between ($1::date - 3) and $1::date group by account_id", [asOf]),
        q("select scope_key account_id, source_request_hash, payload_sha from public.source_snapshots where connection_id = 'primary' and source_key = 'fba-inventory-health'"),
        q("select account_id, string_agg(source_key || '=' || coalesce(content_rev, '') || '@' || coalesce(latest_metric_date::text, ''), ',' order by source_key) revs from public.ads_sync_state where source_key = any($1) group by account_id", [adsWorkerKeys]),
        q("select l.account_id, l.payload_sha l_sha, l.validated_at l_at, r.payload_sha r_sha, r.validated_at r_at from public.source_listings_snapshot l left join public.source_listings_raw_snapshot r on r.organization_fingerprint = l.organization_fingerprint and r.connection_id = l.connection_id and r.account_id = l.account_id where l.connection_id = 'primary'"),
        one("select payload_sha from public.source_snapshots where connection_id = 'primary' and source_key = 'product-catalog' order by validated_at desc limit 1"),
      ]);
      return composeEvidenceTokens({ oli, oliCompleteness, fba, ads, listings, catalog });
    },
    /** Regions whose scheduler-v2 cycle (natural, -fba, LHv3, bootstrap-*, priority-partial-*) is in flight (its newer
     *  jobs are not yet promotable -> false STALE window). */
    async readBusyRegions() {
      const rows = await q(`select bucket from public.sync_cycles
        where status in ('pending','running') and coalesce(started_at, created_at) > now() - interval '4 hours'`);
      const out = new Set();
      for (const r of rows) { const reg = regionForCycleBucket(r.bucket); if (reg) out.add(reg); }
      return out;
    },
    /** The global control-plane lease (READ-ONLY): held by a live owner right now? */
    async readControlLease() {
      const r = await one("select owner_token, operation_key, expires_at, (expires_at is not null and expires_at > now()) live from public.control_plane_lease limit 1");
      return { held: !!(r && S(r.owner_token) && r.live), operationKey: r ? S(r.operation_key) : "", expiresAt: r && r.expires_at ? iso(r.expires_at) : null };
    },
    /** Detect-only observations (no zero-export publisher): metadata comparison only; never acted on. */
    async readDetectOnly({ region, asOf, accounts, materializedKeys }) {
      if (!accounts.length) return [];
      const fbaPlan = await q(`with j as (select distinct on (rj.account_id) rj.account_id, sc.created_at cyc_created, rj.validated
               from public.sync_report_jobs rj join public.sync_cycles sc on sc.id = rj.cycle_id
              where rj.report_key = 'fba-plan' and rj.account_id = any($1) and rj.save_status = 'succeeded'
              order by rj.account_id, rj.created_at desc),
             l as (select distinct on (account_id) account_id, source_refreshed_at from public.report_snapshots
              where report_key = 'fba-plan' and account_id = any($1) order by account_id, updated_at desc)
        select a.id account_id, j.cyc_created, j.validated, l.source_refreshed_at live_refreshed
          from unnest($1::text[]) a(id) left join j on j.account_id = a.id left join l on l.account_id = a.id`, [accounts]);
      const out = [];
      for (const r of fbaPlan) {
        const state = !r.live_refreshed ? "live-missing" : (r.cyc_created && new Date(r.cyc_created) > new Date(new Date(r.live_refreshed).getTime() + 60000) ? "saved-not-live" : "current");
        out.push({ region, account_id: S(r.account_id), report_key: "fba-plan", requested_as_of: asOf, family: "detect", state, reason_code: "detect-only:no-zero-export-publisher" });
      }
      if (materializedKeys.length) {
        const mat = await q(`with up as (select account_id, max(source_refreshed_at) up_at from public.report_snapshots
                where report_key in ('brand-sales','brand-inventory') and account_id = any($1) group by account_id),
               m as (select report_key, account_id, max(updated_at) m_at from public.report_snapshots
                where report_key = any($2) and account_id = any($1) group by report_key, account_id)
          select k.key report_key, a.id account_id, m.m_at, up.up_at
            from unnest($1::text[]) a(id) cross join unnest($2::text[]) k(key)
            left join m on m.account_id = a.id and m.report_key = k.key left join up on up.account_id = a.id`, [accounts, materializedKeys]);
        for (const r of mat) {
          const state = !r.m_at ? "no-account-row" : (r.up_at && new Date(r.m_at) < new Date(r.up_at) ? "behind-upstream" : "current-or-newer");
          out.push({ region, account_id: S(r.account_id), report_key: S(r.report_key), requested_as_of: asOf, family: "detect", state, reason_code: "detect-only:scheduler-materialized" });
        }
      }
      return out;
    },
    async close() { try { await pool.end(); } catch { /* ignore */ } },
  };
}
