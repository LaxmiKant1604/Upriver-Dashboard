// Returns-ONLY exports proof (DESIGN-v2 3.4-3.6, 4.1, 6): the daily Returns source can create NOTHING but "Returns (FBA &
// FBM)" exports and write NOTHING but the Returns event-source RPCs -- offline, through the REAL production composition.
//   A. IN-PROCESS: lib/server/sync/returns-event-runner.js with EVERY production default (the export-eligible discovery,
//      the public spec, the compatible-sources preflight, the token balance, the export listing, the shared ads-sync
//      transport createExport / downloadExport, and the real supabase.js wrappers: run lease, create slot, states,
//      coverage, replace, read-back count, confirm, failure, status row). Only the clock and the sleep are injected. ONE
//      recording global fetch sits under all of it: DataDoe may receive ONLY POST /api/v1/exports whose sourceId is
//      RETURNS.id plus the free GETs; Supabase may receive ONLY the reads + RPCs of the Returns source (every RPC body is
//      checked key-for-key against the 20260942 SQL signature, so a wrapper / runner parameter drift fails here); ANY
//      other request throws and is recorded as a violation. Drives: initial (60 days), rolling (14 days), > 5 sellers, a
//      capped export split, an ambiguous create (adopt-only reconcile), a completed-export reuse, --no-adopt-list, a
//      rejected multi-seller create, a dry-run. Every create: 1..5 sellers, limit 50000, skip 0, exactly the 24 columns,
//      raw rows (no grouping) -- never a Settlements / OLI / other create.
//   B. SELF-CHECK: the same recording fetch really refuses (and records) a Settlements / OLI create through the same
//      transport and a legacy Returns / Settlements history write through the same supabase.js -- the proof is not vacuous.
//   C. THE CLI (scripts/release/scheduled-returns-refresh.mjs) in child processes with the SAME fake preloaded (--import):
//      strict usage STOPs that never echo a value, the typed configuration gate, the controls gate (unreadable / missing /
//      paused / schedule off), a scheduled paid run end to end (rows_written=true in $GITHUB_OUTPUT; RESULT, step summary
//      and status row redacted), an operator canary (--accounts, --no-adopt-list, --evidence-file written OUTSIDE the work
//      tree), a dry-run, an out-of-range --as-of and a systemic failure (exit 1, rows_written=false).
//   D. STATIC IMPORT CLOSURE: neither the CLI nor the runner reaches the legacy returns-operation.js /
//      returns-leakage-golive.mjs pair (the scanner is proven to find that edge from the legacy operator itself).
// Zero real network, zero database, zero DataDoe, no secrets: every credential is a fake and every child environment is
// built from scratch (credential variables set explicitly, so no env file can fill them). 7-bit ASCII, LF.

import assert from "node:assert/strict";
import { writeSync, readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));        // <app>/scripts
const APP = resolve(HERE, "..");                             // <app>
const CLI = join(APP, "scripts", "release", "scheduled-returns-refresh.mjs");
const SB_URL = "http://supabase.returns-only.test";
const SB_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
const FAKE_SB_KEY = ["fake", "svc", "role"].join("-");
const FAKE_DD_KEY = ["dd", "returns", "only", "fake"].join("_");
// Set BEFORE any lib/server import (supabase.js captures its credentials at module evaluation); unconditional on purpose.
process.env.SUPABASE_URL = SB_URL;
process.env[SB_KEY_ENV] = FAKE_SB_KEY;
process.env.DATADOE_API_KEY = FAKE_DD_KEY;
process.env.DATADOE_API_KEY_SECONDARY = "";

const out = (s) => { try { writeSync(1, s + "\n"); } catch { /* ignore */ } };
let passed = 0; const tests = []; const test = (name, fn) => tests.push({ name, fn });

// =====================================================================================================================
// The recording fake. SELF-CONTAINED: it is serialized with Function.prototype.toString() into the child-process preload
// of section C, so it references NOTHING outside its own body except globals (Response, URL, JSON, Date, TypeError).
// =====================================================================================================================
function installReturnsFakeHttp(cfg) {
  const DD = "https://api.datadoe.com/api/v1";
  const SB_ORIGIN = new URL(cfg.supabaseUrl).origin;
  const clock = () => (cfg.nowIso ? Date.parse(cfg.nowIso) : Date.now());
  const iso = (ms) => new Date(ms).toISOString();
  const log = { violations: [], ddGets: [], ddPosts: [], sbGets: [], rpc: [], statusRows: [], failures: [], listings: 0 };
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const dataset = cfg.dataset || {};
  const states = new Map(Object.entries(cfg.states || {}).map(([a, s]) => [a, { account_id: a, ...s }]));
  const coverage = new Map(Object.entries(cfg.coverage || {}).map(([a, ws]) => [a, ws.map((w) => ({ from: w.from, to: w.to }))]));
  const events = new Map(Object.entries(cfg.events || {}).map(([a, es]) => [a, es.map((e) => ({ ...e }))]));
  const exportsById = new Map((cfg.listed || []).map((x) => [x.id, { ...x, capped: false, rowCount: (x.rows || []).length }]));
  const leases = new Map();
  const slots = new Map(Object.entries(cfg.slotsUsed || {})); // "<region>|<UTC claim day YYYY-MM-DD>" -> creates claimed
  let seq = 0; let posts = 0; let leaseGen = 40; let balance = cfg.balance == null ? 1000 : cfg.balance;
  const addDays = (day, n) => { const x = new Date(day + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const reply = (status, body, headers) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(headers || {}) } });
  const refuse = (what) => { log.violations.push(what); throw new TypeError("fetch failed: refused by the returns-only fake (" + what + ")"); };
  const raise = (fn, code) => reply(400, { code: "P0001", message: fn + ": " + code, details: null, hint: null });
  const inWin = (d, from, to) => typeof d === "string" && d >= from && d <= to;
  const eqOf = (v) => String(v || "").replace(/^eq\./, "");
  const removeCoverage = (a, from, to) => {
    const keep = [];
    for (const w of coverage.get(a) || []) {
      if (w.to < from || w.from > to) { keep.push(w); continue; }
      if (w.from < from) keep.push({ from: w.from, to: addDays(from, -1) });
      if (w.to > to) keep.push({ from: addDays(to, 1), to: w.to });
    }
    coverage.set(a, keep);
  };
  const addCoverage = (a, from, to) => {
    let nf = from; let nt = to; const keep = [];
    for (const w of coverage.get(a) || []) {
      if (addDays(w.to, 1) >= nf && w.from <= addDays(nt, 1)) { if (w.from < nf) nf = w.from; if (w.to > nt) nt = w.to; } else keep.push(w);
    }
    keep.push({ from: nf, to: nt });
    coverage.set(a, keep.sort((x, y) => (x.from < y.from ? -1 : 1)));
  };
  // DESIGN 3.7 rules (a) + (c), recomputed like the replace RPC's b2 cross-check (a 'clear' window must not be ambiguous).
  const ambiguousIn = (evs) => {
    const counts = new Map();
    for (const e of evs) {
      const id = e.fulfillment_channel === "FBA" ? e.license_plate_number : e.fulfillment_channel === "FBM" ? e.rma_id : null;
      const k = id != null && String(id).trim() !== "" ? "k|" + [e.amazon_order_id, e.sku, String(id).trim()].join("|") : "u|" + e.event_key;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.values()].some((n) => n >= 2);
  };
  const BODY_KEYS = ["sourceId", "sellerOrVendorIds", "columns", "from", "to", "limit", "skip", "outputType", "orderByColumn", "orderByDirection", "groupBy", "aggregations"];
  const listingOf = (x) => { const o = { id: x.id, status: x.status, createdAt: x.createdAt, expiresAt: x.expiresAt }; for (const k of BODY_KEYS) if (x[k] !== undefined) o[k] = x[k]; return o; };
  const rowsFor = (b) => {
    if ((cfg.cappedWindows || []).some((w) => w.from === b.from && w.to === b.to)) return null;
    const ids = new Set((b.sellerOrVendorIds || []).map(String));
    return Object.entries(dataset).flatMap(([s, rows]) => (ids.has(s) ? rows : [])).filter((r) => inWin(r.date, b.from, b.to));
  };
  const rawOf = (x) => {
    if (!x.capped) return JSON.stringify(x.rows || []);
    const t = {}; for (const c of x.columns) t[c] = null;
    t.date = x.from; t.seller_or_vendor_id = x.sellerOrVendorIds[0];
    return "[" + new Array(50000).fill(JSON.stringify(t)).join(",") + "]";
  };

  function datadoe(method, path, query, init) {
    if (method === "GET") {
      log.ddGets.push(path.startsWith("/exports/") && path !== "/exports/sources" ? path.replace(/^\/exports\/[^/]+/, "/exports/{id}") : path);
      if (path === "/spec/data-scheme") {
        const cols = [...(cfg.specColumns || cfg.columns), "amazon_return_extra_note"].map((name) => ({ name, type: "TEXT", nullable: true }));
        return reply(200, { sources: [
          { id: cfg.returnsId, name: "Returns (FBA & FBM)", isPremium: cfg.specPremium === true, columns: cols },
          { id: "0".repeat(64), name: "Settlements", isPremium: false, columns: [{ name: "date" }] },
        ] });
      }
      if (path === "/exports/sources") {
        const id = query.get("sellerOrVendorIds");
        const names = (cfg.incompatible || []).includes(id) ? [] : [{ name: "Returns (FBA & FBM)" }];
        return reply(200, { sources: [...names, { name: "Settlements" }, { name: "Order Line Items" }] });
      }
      if (path === "/usage-logs") return reply(200, { data: [{ usedAt: iso(clock()), balanceAfter: balance, extraTokensAfter: 0, bundleTokensAfter: 0 }] });
      if (path === "/util/sellers-and-vendors") {
        return reply(200, { data: accounts.map((a) => ({ id: a.id, name: "Seller " + a.id.slice(0, 4), marketplaceCountryCode: a.country, currency: a.currency || null,
          sellerCentralConnection: { initialLoadComplete: true, rowCount: 100 } })) });
      }
      if (path === "/exports") {
        log.listings += 1;
        const list = [...exportsById.values()].map(listingOf).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return reply(200, { data: list, meta: { hasNextPage: false } });
      }
      let m = /^\/exports\/([^/]+)$/.exec(path);
      if (m) { const x = exportsById.get(decodeURIComponent(m[1])); return x ? reply(200, { id: x.id, status: x.status, rowCount: x.rowCount }) : reply(404, { message: "not found" }); }
      m = /^\/exports\/([^/]+)\/raw$/.exec(path);
      if (m) { const x = exportsById.get(decodeURIComponent(m[1])); return x ? reply(200, { rawContent: rawOf(x) }) : reply(404, { message: "not found" }); }
      return refuse("GET datadoe " + path);
    }
    if (method === "POST" && path === "/exports") {
      let body = null;
      try { body = JSON.parse(String(init && init.body)); } catch { body = null; }
      if (!body || body.sourceId !== cfg.returnsId) return refuse("POST datadoe /exports with a non-Returns sourceId");
      posts += 1;
      log.ddPosts.push(body);
      if ((cfg.rejectSellers || []).some((s) => (body.sellerOrVendorIds || []).includes(s))) return reply(400, { message: "seller not exportable" });
      seq += 1;
      const id = "rx" + String(seq).padStart(6, "0") + "-feed-4000-8000-" + String(seq).padStart(12, "0");
      const rows = rowsFor(body);
      const x = { id, status: "COMPLETED", createdAt: iso(clock() - 30000), expiresAt: iso(clock() + 86400000), ...body, capped: rows === null, rows: rows || [] };
      x.rowCount = x.capped ? 50000 : x.rows.length;
      exportsById.set(id, x);
      balance -= 2;
      if ((cfg.landThenDrop || []).includes(posts)) throw new TypeError("fetch failed (the connection dropped after the create landed)");
      return reply(201, { id, status: "PENDING" });
    }
    return refuse(method + " datadoe " + path);
  }

  function replace(p) {
    const fn = "replace_returns_events_window";
    const l = leases.get(p.p_region);
    if (!l || l.owner !== p.p_owner_token || l.generation !== p.p_generation) return raise(fn, "RETURNS_LEASE_LOST");
    if (p.p_connection_id !== "primary" || p.p_account_id !== p.p_seller_or_vendor_id) return raise(fn, "RETURNS_BINDING_MISMATCH");
    if (!["initial", "rolling"].includes(p.p_mode) || p.p_attribution !== "as-delivered" || !["clear", "ambiguous"].includes(p.p_identity_status)) return raise(fn, "RETURNS_PARAM_INVALID");
    if (!Array.isArray(p.p_request_hashes) || !p.p_request_hashes.length || !p.p_request_hashes.every((h) => /^[0-9a-f]{64}$/.test(String(h)))) return raise(fn, "RETURNS_PARAM_INVALID");
    if (!Array.isArray(p.p_fragment_rows) || !p.p_fragment_rows.every((n) => Number.isInteger(n) && n >= 0 && n <= 49999)) return raise(fn, "RETURNS_PARAM_INVALID");
    if (!Array.isArray(p.p_export_ids) || !p.p_export_ids.every((x) => typeof x === "string" && x.length >= 1 && x.length <= 128)) return raise(fn, "RETURNS_PARAM_INVALID");
    if (typeof p.p_source_refreshed_at !== "string" || !Number.isFinite(Date.parse(p.p_source_refreshed_at))) return raise(fn, "RETURNS_PARAM_INVALID");
    const det = p.p_identity_detail;
    if (!det || typeof det !== "object" || Array.isArray(det) || !Object.values(det).every((v) => Number.isInteger(v) && v >= 0)) return raise(fn, "RETURNS_IDENTITY_INVALID");
    const a = p.p_account_id; const from = p.p_covered_from; const to = p.p_covered_to;
    const st = states.get(a) || { account_id: a, initial_status: "pending", identity_status: "clear", hold_reason: null, legacy_fence: true };
    if (st.hold_reason) return raise(fn, "RETURNS_ACCOUNT_HELD");
    if (p.p_mode === "rolling" && st.initial_status !== "complete") return raise(fn, "RETURNS_NOT_INITIALIZED");
    const evs = Array.isArray(p.p_events) ? p.p_events : null;
    if (!evs || evs.length !== p.p_expected_count) return raise(fn, "RETURNS_EVENTS_INVALID");
    const fields = [...cfg.eventFields].sort().join(",");
    let units = 0;
    for (const e of evs) {
      if (!e || typeof e !== "object" || Object.keys(e).sort().join(",") !== fields) return raise(fn, "RETURNS_EVENT_INVALID");
      if (e.seller_or_vendor_id !== p.p_seller_or_vendor_id) return raise(fn, "RETURNS_SELLER_MISMATCH");
      if (e.marketplace_country_code !== p.p_marketplace_country_code) return raise(fn, "RETURNS_MARKETPLACE_MISMATCH");
      if (!inWin(e.return_date, from, to)) return raise(fn, "RETURNS_ROW_OUTSIDE_WINDOW");
      if (!p.p_request_hashes.includes(e.source_request_hash)) return raise(fn, "RETURNS_EVENT_INVALID");
      if (e.export_id !== null && !p.p_export_ids.includes(e.export_id)) return raise(fn, "RETURNS_EVENT_INVALID");
      if (e.quantity !== null) units += Number(e.quantity);
    }
    if (units !== Number(p.p_expected_units)) return raise(fn, "RETURNS_UNITS_MISMATCH");
    if (p.p_identity_status === "clear" && ambiguousIn(evs)) return raise(fn, "RETURNS_IDENTITY_MISMATCH");
    const old = (events.get(a) || []).filter((e) => inWin(e.return_date, from, to));
    if (evs.length === 0 && old.length && p.p_allow_shrink !== true) return raise(fn, "RETURNS_ACCOUNT_SUDDEN_EMPTY");
    events.set(a, [...(events.get(a) || []).filter((e) => !inWin(e.return_date, from, to)), ...evs.map((e) => ({ ...e, order_owner: "unknown" }))]);
    addCoverage(a, from, to);
    const ns = { ...st, marketplace_country_code: p.p_marketplace_country_code, last_mode: p.p_mode, last_window_from: from, last_window_to: to, last_status: "replaced",
      last_event_count: evs.length, last_unit_sum: units, last_request_hashes: [...p.p_request_hashes], last_export_ids: [...p.p_export_ids], last_run_key: p.p_run_key,
      last_region: p.p_region, identity_status: p.p_identity_status, identity_detail: det, hold_reason: p.p_identity_status === "ambiguous" ? "RETURNS_IDENTITY_AMBIGUOUS" : null, legacy_fence: true };
    if (p.p_mode === "initial") Object.assign(ns, { initial_status: "loaded", initial_window_from: from, initial_window_to: to });
    states.set(a, ns);
    return reply(200, { eventsDeleted: old.length, eventsInserted: evs.length, unitsInserted: units, aggregatesDeleted: 0, aggregatesInserted: 0,
      ownerSelf: 0, ownerOther: 0, ownerUnknown: evs.length, oldCount: old.length, initialStatus: ns.initial_status });
  }

  function confirm(p) {
    const a = p.p_account_id; const st = states.get(a);
    if (!st || st.last_status !== "replaced" || st.last_window_from !== p.p_covered_from || st.last_window_to !== p.p_covered_to || st.last_mode !== p.p_mode
      || JSON.stringify(st.last_request_hashes) !== JSON.stringify(p.p_request_hashes)) return reply(200, { verified: false, reason: "superseded", counts: {}, initialStatus: st ? st.initial_status : null });
    const evs = (events.get(a) || []).filter((e) => inWin(e.return_date, p.p_covered_from, p.p_covered_to));
    const units = evs.reduce((t, e) => t + (e.quantity === null ? 0 : Number(e.quantity)), 0);
    const held = st.identity_status !== "clear";
    if (evs.length !== p.p_expected_count || units !== Number(p.p_expected_units)) {
      Object.assign(st, { last_status: "failed", last_error_code: "RETURNS_VERIFY_MISMATCH" });
      if (p.p_mode === "initial" && !held) st.initial_status = "pending";
      removeCoverage(a, p.p_covered_from, p.p_covered_to);
      return reply(200, { verified: false, reason: "mismatch", counts: { events: evs.length, units }, initialStatus: st.initial_status });
    }
    Object.assign(st, { last_status: "succeeded", last_success_at: iso(clock()) });
    if (p.p_mode === "initial") { if (!held) st.initial_status = "complete"; else removeCoverage(a, p.p_covered_from, p.p_covered_to); }
    return reply(200, { verified: true, reason: held ? "held" : "verified", counts: { events: evs.length, units }, initialStatus: st.initial_status });
  }

  function rpc(name, p) {
    const want = cfg.rpcParams && cfg.rpcParams[name];
    if (!want) return refuse("POST supabase rpc/" + name);
    if (Object.keys(p || {}).sort().join(",") !== [...want].sort().join(",")) return refuse("POST supabase rpc/" + name + " (body keys differ from the SQL signature)");
    log.rpc.push(name);
    if ((cfg.failRpc || []).includes(name)) return reply(500, { code: "XX000", message: "internal error" });
    const leaseOk = () => { const l = leases.get(p.p_region); return !!l && l.owner === p.p_owner_token && l.generation === p.p_generation; };
    if (name === "acquire_returns_run_lease") {
      if (cfg.leaseHeld || leases.has(p.p_region)) return reply(200, { granted: false, generation: null, holderRunKey: "returns-events/other", expiresAt: iso(clock() + 600000) });
      leaseGen += 1; leases.set(p.p_region, { owner: p.p_owner_token, generation: leaseGen });
      return reply(200, { granted: true, generation: leaseGen, expiresAt: iso(clock() + Number(p.p_ttl_seconds) * 1000), holderRunKey: p.p_run_key });
    }
    if (name === "renew_returns_run_lease") return reply(200, leaseOk() ? { renewed: true, expiresAt: iso(clock() + Number(p.p_ttl_seconds) * 1000) } : { renewed: false, expiresAt: null });
    if (name === "release_returns_run_lease") { const ok = leaseOk(); if (ok) leases.delete(p.p_region); return reply(200, { released: ok }); }
    if (name === "claim_returns_create_slot") {
      if (!leaseOk()) return raise(name, "RETURNS_LEASE_LOST");
      if (!/^[0-9a-f]{64}$/.test(String(p.p_request_hash)) || !Number.isInteger(p.p_max_creates)) return raise(name, "RETURNS_PARAM_INVALID");
      // Keyed like the RPC: (region, the UTC claim day of the fake DB clock) -- never the caller's as-of.
      const k = p.p_region + "|" + iso(clock()).slice(0, 10); const claimed = Number(slots.get(k) || 0);
      if (claimed >= p.p_max_creates) return reply(200, { granted: false, claimed, max: p.p_max_creates });
      slots.set(k, claimed + 1);
      return reply(200, { granted: true, claimed: claimed + 1, max: p.p_max_creates });
    }
    if (name === "replace_returns_events_window") return replace(p);
    if (name === "confirm_returns_events_window") return confirm(p);
    if (name === "record_returns_window_failure") {
      const det = p.p_detail;
      const safe = det && typeof det === "object" && !Array.isArray(det)
        && Object.values(det).every((v) => typeof v === "number" || typeof v === "boolean" || /^[A-Za-z0-9_-]{1,64}$/.test(String(v)));
      if (!safe) return refuse("POST supabase rpc/" + name + " (p_detail is not counts / codes / dates only)");
      if (!/^[A-Z0-9_]{1,64}$/.test(String(p.p_error_code))) return raise(name, "RETURNS_PARAM_INVALID");
      log.failures.push({ code: p.p_error_code, detail: det });
      const st = states.get(p.p_account_id) || { account_id: p.p_account_id, initial_status: "pending", identity_status: "clear", hold_reason: null, legacy_fence: true };
      Object.assign(st, { marketplace_country_code: p.p_marketplace_country_code, last_status: "failed", last_error_code: p.p_error_code });
      if (st.initial_status === "loaded" && !st.hold_reason) st.initial_status = "pending";
      states.set(p.p_account_id, st);
      return reply(200, { recorded: true, initialStatus: st.initial_status });
    }
    return refuse("POST supabase rpc/" + name);
  }

  function supabase(method, path, query, init) {
    if (method === "GET") {
      log.sbGets.push(path);
      if (path === "/rest/v1/source_controls") {
        if (cfg.controls === "unreadable") return reply(400, { code: "XX000", message: "controls unavailable" });
        const rows = [{ source_key: "ads-asin-date", paused: false, schedule_enabled: true, updated_at: iso(clock()) }];
        if (cfg.controls !== "missing") {
          const c = cfg.controls || { paused: false, schedule_enabled: true };
          rows.push({ source_key: "returns", paused: c.paused === true, schedule_enabled: c.schedule_enabled === true, updated_at: iso(clock()) });
        }
        return reply(200, rows);
      }
      if (path === "/rest/v1/account_onboarding") {
        return reply(200, accounts.map((a) => ({ account_id: a.id, connection_id: "primary", name: "Seller", marketplace_country_code: a.country, status: "ready" })));
      }
      if (path === "/rest/v1/report_snapshots") {
        if (query.get("report_key") !== "eq.account-directory") return refuse("GET supabase report_snapshots (not the account directory)");
        return reply(200, []);
      }
      if (path === "/rest/v1/source_returns_account_state") {
        const raw = String(query.get("account_id") || "");
        const ids = raw ? raw.replace(/^in\.\(/, "").replace(/\)$/, "").split(",").map((s) => s.replace(/^"|"$/g, "")) : null;
        const rows = [...states.values()].filter((s) => !ids || ids.includes(s.account_id)).sort((x, y) => (x.account_id < y.account_id ? -1 : 1));
        const off = Number(query.get("offset") || 0); const lim = Number(query.get("limit") || 1000);
        return reply(200, rows.slice(off, off + lim));
      }
      if (path === "/rest/v1/source_coverage") {
        if (query.get("source_key") !== "eq.returns") return refuse("GET supabase source_coverage (not the 'returns' key)");
        const a = eqOf(query.get("account_id"));
        return reply(200, (coverage.get(a) || []).map((w) => ({ covered_from: w.from, covered_to: w.to, updated_at: iso(clock()) })));
      }
      if (path === "/rest/v1/source_returns_events") {
        const prefer = String((init && init.headers && init.headers.Prefer) || "");
        if (query.get("select") !== "return_date" || query.get("limit") !== "1" || prefer !== "count=exact") return refuse("GET supabase source_returns_events (not the read-back count)");
        const a = eqOf(query.get("account_id")); const ds = query.getAll("return_date");
        const from = (ds.find((d) => d.startsWith("gte.")) || "").slice(4); const to = (ds.find((d) => d.startsWith("lte.")) || "").slice(4);
        const n = (events.get(a) || []).filter((e) => inWin(e.return_date, from, to)).length;
        return reply(200, n ? [{ return_date: from }] : [], { "content-range": n ? "0-0/" + n : "*/0" });
      }
      return refuse("GET supabase " + path);
    }
    let body = null;
    try { body = init && init.body != null ? JSON.parse(String(init.body)) : null; } catch { body = null; }
    if (method === "POST" && path.startsWith("/rest/v1/rpc/")) return rpc(path.slice("/rest/v1/rpc/".length), body);
    if (method === "POST" && path === "/rest/v1/source_run_status") {
      const row = Array.isArray(body) ? body[0] : null;
      if (query.get("on_conflict") !== "source_key,bucket" || !row || row.source_key !== "returns") return refuse("POST supabase source_run_status (not the 'returns' row)");
      log.statusRows.push(row);
      return new Response(null, { status: 201 });
    }
    return refuse(method + " supabase " + path);
  }

  globalThis.fetch = async (input, init) => {
    const opts = init || {};
    const url = new URL(String(input && input.url ? input.url : input));
    const method = String(opts.method || "GET").toUpperCase();
    if (url.href.startsWith(DD + "/")) return datadoe(method, url.pathname.slice("/api/v1".length), url.searchParams, opts);
    if (url.origin === SB_ORIGIN) return supabase(method, url.pathname, url.searchParams, opts);
    return refuse(method + " " + url.origin);
  };
  return { log, states, coverage, events, get balance() { return balance; } };
}

// =====================================================================================================================
// Fixtures: the 20260942 RPC signatures (parsed from the SQL), source ids, rows carrying SECRET markers.
// =====================================================================================================================
const SRC = await import("../lib/server/reports/sources.js");
const CORE = await import("../lib/server/sync/returns-event-source.js");
const R = await import("../lib/server/sync/returns-event-runner.js");
const AS = await import("../lib/server/ads-sync.js");
const SB = await import("../lib/server/supabase.js");

const MIGRATION_SQL = readFileSync(join(APP, "supabase", "migrations", "20260942_returns_event_source.sql"), "utf8");
const SIGNATURES = {};
for (const m of MIGRATION_SQL.matchAll(/create or replace function public\.([a-z_]+)\(([\s\S]*?)\)\s*returns\b/g)) {
  SIGNATURES[m[1]] = m[2].split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
}
const RUNNER_RPCS = ["acquire_returns_run_lease", "renew_returns_run_lease", "release_returns_run_lease", "claim_returns_create_slot",
  "replace_returns_events_window", "confirm_returns_events_window", "record_returns_window_failure"];
const RPC_PARAMS = Object.fromEntries(RUNNER_RPCS.map((n) => [n, SIGNATURES[n]]));
const OTHER_SOURCE_IDS = new Set(Object.values(SRC).filter((v) => v && typeof v === "object" && typeof v.id === "string" && v !== SRC.RETURNS).map((v) => v.id));

const NOW = "2026-10-04T12:00:00.000Z";
const ASOF = "2026-10-03";
const INITIAL = { from: "2026-08-05", to: "2026-10-03" };   // [D1-59, D1]
const ROLLING = { from: "2026-09-20", to: "2026-10-03" };   // [D1-13, D1]
const acct = (n) => "c" + String(n).padStart(7, "0") + "-2222-4000-8000-" + String(n).padStart(12, "0");
const IN = (id) => ({ id, country: "IN", currency: "INR" });
let rowSeq = 0;
const SENSITIVE = new Set();
const mark = (v) => { SENSITIVE.add(v); return v; };
function fba(seller, date, over = {}) {
  const k = ++rowSeq;
  return {
    seller_or_vendor_id: seller, marketplace_country_code: "IN", date, order_date: null, sku: mark("SKU-ONLYSECRET-" + k), child_asin: "B0ONLYASN" + (k % 10),
    fnsku: mark("X00ONLYSECRETFN" + k), amazon_order_id: mark("407-ONLYSECRET-ORDER-" + k), quantity: 1, amazon_return_reason: "DEFECTIVE",
    amazon_fulfillment_channel: "FBA", amazon_return_request_status: "Unit returned to inventory", amazon_return_detailed_disposition: "SELLABLE",
    amazon_return_rmaid: null, amazon_return_seller_rmaid: null, amazon_return_label_to_be_paid_by: null, amazon_return_refunded_amount: null,
    amazon_return_label_cost: null, cogs_item_value: "4.50", cogs_shipping_value: "0.50", cogs_total_value: "5.00", cogs_currency: "INR", cogs_present: true,
    amazon_license_plate_number: mark("LPNONLYSECRET" + k), ...over,
  };
}
function fbm(seller, date, over = {}) {
  const k = ++rowSeq;
  return {
    seller_or_vendor_id: seller, marketplace_country_code: "IN", date, order_date: "2026-08-01", sku: mark("SKU-ONLYSECRET-" + k), child_asin: "B0ONLYASN" + (k % 10),
    fnsku: null, amazon_order_id: mark("171-ONLYSECRET-ORDER-" + k), quantity: 2, amazon_return_reason: "NO_LONGER_NEEDED",
    amazon_fulfillment_channel: "FBM", amazon_return_request_status: "Approved", amazon_return_detailed_disposition: null,
    amazon_return_rmaid: mark("RMAONLYSECRET" + k), amazon_return_seller_rmaid: mark("SRMAONLYSECRET" + k), amazon_return_label_to_be_paid_by: "Seller",
    amazon_return_refunded_amount: "12.50", amazon_return_label_cost: "3.10", cogs_item_value: null, cogs_shipping_value: null, cogs_total_value: null,
    cogs_currency: null, cogs_present: false, amazon_license_plate_number: "", ...over,
  };
}
const completeState = (over = {}) => ({ initial_status: "complete", last_status: "succeeded", last_mode: "rolling", last_window_from: "2026-09-19", last_window_to: "2026-10-02",
  last_success_at: "2026-10-03T09:00:00Z", last_request_hashes: ["a".repeat(64)], last_event_count: 0, last_unit_sum: 0, identity_status: "clear", hold_reason: null, legacy_fence: true, ...over });
const fakeCfg = (over = {}) => ({ supabaseUrl: SB_URL, returnsId: SRC.RETURNS.id, columns: [...CORE.RETURNS_EVENT_COLUMNS], eventFields: [...CORE.RETURNS_EVENT_FIELDS],
  rpcParams: RPC_PARAMS, nowIso: NOW, ...over });

// One region run through the REAL production composition (only the clock + sleep injected).
async function runInProcess(cfg, opts = {}) {
  const fake = installReturnsFakeHttp(fakeCfg(cfg));
  const logs = [];
  const r = await R.runReturnsRegion({
    region: "india", asOf: ASOF, dryRun: opts.dryRun === true, maxCreates: opts.dryRun ? null : (opts.maxCreates == null ? 6 : opts.maxCreates), reserveTokens: 100,
    accountAllowlist: opts.accounts || null, adoptList: opts.adoptList !== false, log: (m) => logs.push(String(m)),
    deps: { now: () => NOW, nowMs: () => Date.parse(NOW), sleep: async () => {}, reconcileWaitMs: 0 },
  });
  return { r, log: fake.log, logs, fake };
}

// The invariant of EVERY scenario: no refused request; every create is a Returns-only raw request inside the provider contract.
function assertReturnsOnly(log, label) {
  assert.deepEqual(log.violations, [], label + ": a request outside the Returns-only allowlist was attempted");
  for (const b of log.ddPosts) {
    assert.equal(b.sourceId, SRC.RETURNS.id, label + ": a create for another source");
    assert.ok(!OTHER_SOURCE_IDS.has(b.sourceId), label + ": a Settlements / OLI / other create");
    assert.ok(Array.isArray(b.sellerOrVendorIds) && b.sellerOrVendorIds.length >= 1 && b.sellerOrVendorIds.length <= 5, label + ": 1..5 sellers per create");
    assert.equal(b.limit, 50000, label + ": limit 50000"); assert.equal(b.skip, 0, label + ": skip 0");
    assert.deepEqual(b.columns, [...CORE.RETURNS_EVENT_COLUMNS], label + ": exactly the 24 Returns columns, in order");
    assert.equal(b.columns.length, 24);
    assert.equal(b.outputType, "JSON"); assert.equal(b.orderByColumn, "date"); assert.equal(b.orderByDirection, "ASC");
    assert.equal(b.groupBy, undefined, label + ": raw rows, never grouped"); assert.equal(b.aggregations, undefined);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(b.from) && /^\d{4}-\d{2}-\d{2}$/.test(b.to) && b.from <= b.to);
  }
  assert.ok(log.rpc.every((n) => RUNNER_RPCS.includes(n)), label + ": only the Returns RPCs");
}
const windowsOf = (log) => log.ddPosts.map((b) => b.from + ".." + b.to);

test("A0 the fixtures: every RPC the runner calls has a 20260942 SQL signature, and RETURNS is not another source's id", () => {
  for (const n of RUNNER_RPCS) assert.ok(Array.isArray(SIGNATURES[n]) && SIGNATURES[n].length >= 3 && SIGNATURES[n].every((p) => /^p_[a-z_]+$/.test(p)), n);
  assert.equal(SIGNATURES.replace_returns_events_window.length, 23);
  assert.ok(OTHER_SOURCE_IDS.has(SRC.SETTLEMENTS.id) && OTHER_SOURCE_IDS.has(SRC.ORDER_LINE_ITEMS.id) && !OTHER_SOURCE_IDS.has(SRC.RETURNS.id));
  assert.equal(CORE.RETURNS_PSEUDO_SOURCE.sourceId, SRC.RETURNS.id);
});

// ================================================ A. the production composition ================================================
test("A1 INITIAL 60-day load of two new accounts: ONE Returns-only create over [D1-59, D1]; both persisted, confirmed and complete", async () => {
  const [A, B] = [acct(1), acct(2)];
  const { r, log, fake } = await runInProcess({ accounts: [IN(A), IN(B)], dataset: { [A]: [fba(A, "2026-08-05"), fbm(A, "2026-10-03")], [B]: [fba(B, "2026-09-01")] } });
  assertReturnsOnly(log, "A1");
  assert.equal(r.ok, true); assert.equal(r.classification, "COMPLETE");
  assert.equal(log.ddPosts.length, 1); assert.deepEqual(windowsOf(log), [INITIAL.from + ".." + INITIAL.to]);
  assert.deepEqual([...log.ddPosts[0].sellerOrVendorIds].sort(), [A, B].sort());
  assert.deepEqual(r.outcomes["initial-loaded"].sort(), [A, B].sort());
  assert.equal(fake.states.get(A).initial_status, "complete"); assert.equal(fake.states.get(B).initial_status, "complete");
  assert.equal(log.rpc.filter((n) => n === "replace_returns_events_window").length, 2);
  assert.equal(log.rpc.filter((n) => n === "confirm_returns_events_window").length, 2);
  assert.equal(log.rpc[0], "acquire_returns_run_lease"); assert.equal(log.rpc.at(-1), "release_returns_run_lease");
  assert.equal(log.ddGets.filter((p) => p === "/spec/data-scheme").length, 1, "the public spec read once per run");
  assert.equal(log.ddGets.filter((p) => p === "/exports/sources").length, 2, "one compatible-sources read per account");
  assert.ok(log.ddGets.filter((p) => p === "/usage-logs").length >= 2, "the plan balance + a FRESH balance before the create");
  assert.equal(log.statusRows.length, 1); assert.equal(log.statusRows[0].last_status, "succeeded"); assert.equal(log.statusRows[0].bucket, "india");
});

test("A2 ROLLING 14-day replace of two complete accounts: ONE create over [D1-13, D1] (never a catch-up window)", async () => {
  const [A, B] = [acct(3), acct(4)];
  const { r, log, fake } = await runInProcess({ accounts: [IN(A), IN(B)], states: { [A]: completeState(), [B]: completeState() },
    coverage: { [A]: [{ from: "2026-08-04", to: "2026-10-02" }], [B]: [{ from: "2026-08-04", to: "2026-10-02" }] },
    dataset: { [A]: [fba(A, "2026-09-20")], [B]: [fbm(B, "2026-10-03")] } });
  assertReturnsOnly(log, "A2");
  assert.deepEqual(windowsOf(log), [ROLLING.from + ".." + ROLLING.to]);
  assert.deepEqual(r.outcomes["daily-refreshed"].sort(), [A, B].sort()); assert.equal(r.classification, "COMPLETE");
  assert.deepEqual(fake.coverage.get(A), [{ from: "2026-08-04", to: "2026-10-03" }]);
});

test("A3 SEVEN new accounts: two creates of 5 + 2 sellers (never more than 5 per create)", async () => {
  const ids = [11, 12, 13, 14, 15, 16, 17].map(acct);
  const { r, log } = await runInProcess({ accounts: ids.map(IN), dataset: Object.fromEntries(ids.map((x) => [x, [fba(x, "2026-09-10")]])) });
  assertReturnsOnly(log, "A3");
  assert.deepEqual(log.ddPosts.map((b) => b.sellerOrVendorIds.length), [5, 2]);
  assert.equal(r.outcomes["initial-loaded"].length, 7);
});

test("A4 a CAPPED export (exactly 50,000 rows) is never persisted: the window bisects into two Returns-only creates; the halves persist", async () => {
  const A = acct(21);
  const { r, log } = await runInProcess({ accounts: [IN(A)], cappedWindows: [{ from: INITIAL.from, to: INITIAL.to }],
    dataset: { [A]: [fba(A, "2026-08-20"), fba(A, "2026-09-28")] } });
  assertReturnsOnly(log, "A4");
  assert.deepEqual(windowsOf(log), [INITIAL.from + ".." + INITIAL.to, "2026-08-05..2026-09-03", "2026-09-04..2026-10-03"]);
  assert.ok(r.outcomes["initial-loaded"].includes(A));
  assert.equal(r.fragments.length, 2); assert.ok(r.fragments.every((f) => f.rowCount < 50000));
});

test("A5 an AMBIGUOUS create (the POST landed, the response was lost) is never re-POSTed: the adopt-only reconcile reuses it", async () => {
  const A = acct(31);
  const { r, log } = await runInProcess({ accounts: [IN(A)], landThenDrop: [1], dataset: { [A]: [fba(A, "2026-09-02")] } });
  assertReturnsOnly(log, "A5");
  assert.equal(log.ddPosts.length, 1, "exactly one POST: the ambiguous create was never re-sent");
  assert.ok(log.listings >= 1); assert.equal(r.reused, 1); assert.equal(r.creates, 1);
  assert.ok(r.outcomes["initial-loaded"].includes(A));
});

test("A6 a COMPLETED export with the exact request identity is REUSED: zero POSTs, zero slots, persisted from it", async () => {
  const A = acct(41);
  const body = R.guardedReturnsBody(CORE.RETURNS_PSEUDO_SOURCE, [A], INITIAL.from, INITIAL.to);
  const listedId = "ls000001-beef-4000-8000-000000000001";
  const listed = [{ id: listedId, status: "COMPLETED", createdAt: "2026-10-04T10:00:00.000Z", expiresAt: "2026-10-05T10:00:00.000Z", ...body, rows: [fba(A, "2026-09-03")] }];
  const { r, log } = await runInProcess({ accounts: [IN(A)], listed, dataset: {} });
  assertReturnsOnly(log, "A6");
  assert.equal(log.ddPosts.length, 0); assert.equal(log.rpc.filter((n) => n === "claim_returns_create_slot").length, 0);
  assert.equal(r.reused, 1); assert.equal(r.tokens, 0); assert.deepEqual(r.adoptedExportIds, [listedId]);
  assert.ok(r.outcomes["initial-loaded"].includes(A));
});

test("A7 --no-adopt-list: ZERO export-listing GETs (the create goes straight through slot + balance + POST)", async () => {
  const A = acct(51);
  const { r, log } = await runInProcess({ accounts: [IN(A)], dataset: { [A]: [fba(A, "2026-09-04")] } }, { adoptList: false });
  assertReturnsOnly(log, "A7");
  assert.equal(log.listings, 0); assert.equal(log.ddPosts.length, 1); assert.ok(r.outcomes["initial-loaded"].includes(A));
});

test("A8 a REJECTED multi-seller create splits: every retry is still a Returns-only create; the rejecting seller is isolated", async () => {
  const [A, B, C] = [acct(61), acct(62), acct(63)];
  const { r, log } = await runInProcess({ accounts: [IN(A), IN(B), IN(C)], rejectSellers: [B],
    dataset: { [A]: [fba(A, "2026-09-05")], [B]: [fba(B, "2026-09-06")], [C]: [fba(C, "2026-09-07")] } }, { maxCreates: 10 });
  assertReturnsOnly(log, "A8");
  assert.ok(log.ddPosts.length >= 3); assert.equal(log.ddPosts[0].sellerOrVendorIds.length, 3);
  assert.ok(r.outcomes.failed.includes(B)); assert.equal(r.accountCodes[B], "RETURNS_EXPORT_REJECTED");
  assert.deepEqual(r.outcomes["initial-loaded"].sort(), [A, C].sort());
});

test("A9 DRY-RUN through the same composition: ZERO creates, ZERO export listing, ZERO Supabase writes (no RPC, no status row)", async () => {
  const [A, B] = [acct(71), acct(72)];
  const { r, log } = await runInProcess({ accounts: [IN(A), IN(B)], states: { [B]: completeState() }, coverage: { [B]: [{ from: "2026-08-01", to: "2026-10-02" }] } }, { dryRun: true });
  assertReturnsOnly(log, "A9");
  assert.equal(r.classification, "DRY_RUN");
  assert.equal(log.ddPosts.length + log.listings + log.rpc.length + log.statusRows.length, 0);
  assert.equal(r.exposure.plannedCreates, 2); assert.equal(r.balanceBefore, 1000);
});

// ================================================ B. the fence is not vacuous ================================================
test("B1 SELF-CHECK: the recording fetch refuses + records a Settlements / OLI / Campaign create and a legacy history write", async () => {
  const A = acct(81);
  const fake = installReturnsFakeHttp(fakeCfg({ accounts: [IN(A)] }));
  const pseudo = (src) => ({ key: "probe", sourceId: src.id, dimensions: ["date", "seller_or_vendor_id"], metrics: [], keyFields: [] });
  for (const src of [SRC.SETTLEMENTS, SRC.ORDER_LINE_ITEMS, SRC.ADS_CAMPAIGN]) {
    await assert.rejects(() => AS.PRODUCTION_ADS_SYNC_DEPS.createExport(FAKE_DD_KEY, pseudo(src), [A], INITIAL.from, INITIAL.to, 0));
  }
  assert.equal(fake.log.ddPosts.length, 0);
  assert.equal(fake.log.violations.filter((v) => /non-Returns sourceId/.test(v)).length, 3);
  const legacyReturns = await SB.replaceReturnsHistoryWindow({ organizationFingerprint: "f".repeat(64), accountId: A, coveredFrom: INITIAL.from, coveredTo: INITIAL.to, returnRows: [] });
  const legacySettlements = await SB.replaceSettlementHistoryWindow({ organizationFingerprint: "f".repeat(64), accountId: A, coveredFrom: INITIAL.from, coveredTo: INITIAL.to, settlementRows: [] });
  assert.notEqual(legacyReturns.write, "ok"); assert.notEqual(legacySettlements.write, "ok");
  assert.ok(fake.log.violations.some((v) => /rpc\/replace_returns_history_window/.test(v)), "the legacy Returns writer is refused");
  assert.ok(fake.log.violations.some((v) => /rpc\/replace_settlement_history_window/.test(v)), "the Settlements writer is refused");
  // a Returns RPC body that drifted from the SQL signature (a renamed / missing parameter) is refused, never served
  await assert.rejects(() => fetch(SB_URL + "/rest/v1/rpc/replace_returns_events_window", { method: "POST", body: JSON.stringify({ p_account_id: A, p_from: INITIAL.from }) }));
  assert.ok(fake.log.violations.some((v) => /rpc\/replace_returns_events_window \(body keys differ from the SQL signature\)/.test(v)));
  assert.equal(fake.log.rpc.length, 0, "nothing refused was ever served");
});

// ================================================ C. the CLI in child processes ================================================
const TMP = mkdtempSync(join(tmpdir(), "returns-only-cli-"));
const PRELOAD = join(TMP, "returns-fake-preload.mjs");
writeFileSync(PRELOAD, [
  "import { readFileSync, writeFileSync } from \"node:fs\";",
  "const cfg = JSON.parse(readFileSync(process.env.RETURNS_FAKE_CFG_PATH, \"utf8\"));",
  "const install = (" + installReturnsFakeHttp.toString() + ");",
  "const fake = install(cfg);",
  "process.on(\"exit\", () => { try { writeFileSync(cfg.logPath, JSON.stringify(fake.log)); } catch { /* the parent fails on a missing log */ } });",
  "",
].join("\n"));
const utcDay = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const YESTERDAY = utcDay(-1);

function runCli(argv, cfg = {}, envOver = {}) {
  const runDir = mkdtempSync(join(TMP, "run-"));
  const logPath = join(runDir, "fake-log.json"); const cfgPath = join(runDir, "fake-cfg.json");
  const ghOutput = join(runDir, "github-output.txt"); const ghSummary = join(runDir, "github-summary.md");
  writeFileSync(ghOutput, ""); writeFileSync(ghSummary, "");
  writeFileSync(cfgPath, JSON.stringify(fakeCfg({ nowIso: null, ...cfg, logPath })));
  // Built from scratch (never the parent environment): every credential variable is SET (fake or empty) so an env file
  // that loadReleaseEnv() might find can never fill it.
  const env = {
    PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "", windir: process.env.windir || "",
    TEMP: runDir, TMP: runDir, TMPDIR: runDir,
    SUPABASE_URL: SB_URL, VITE_SUPABASE_URL: "", [SB_KEY_ENV]: FAKE_SB_KEY, SUPABASE_SECRET_KEY: "", DATADOE_API_KEY: FAKE_DD_KEY, DATADOE_API_KEY_SECONDARY: "",
    POSTGRES_URL: "postgres://returns-only.invalid:1/none", RETURNS_REFRESH_DEADLINE_SECONDS: "",
    GITHUB_OUTPUT: ghOutput, GITHUB_STEP_SUMMARY: ghSummary, RETURNS_FAKE_CFG_PATH: cfgPath, ...envOver,
  };
  const res = spawnSync(process.execPath, ["--import=" + pathToFileURL(PRELOAD).href, CLI, ...argv], { cwd: APP, env, encoding: "utf8", timeout: 180000 });
  const log = existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : null;
  const outputs = readFileSync(ghOutput, "utf8").split("\n").filter(Boolean);
  const resultLine = (res.stdout || "").split("\n").filter((l) => l.startsWith("RESULT ")).at(-1);
  return {
    code: res.status, stdout: res.stdout || "", stderr: res.stderr || "", outputs, rowsWritten: (outputs.filter((l) => l.startsWith("rows_written=")).at(-1) || "").slice(13),
    summary: readFileSync(ghSummary, "utf8"), log, result: resultLine ? JSON.parse(resultLine.slice(7)) : null, runDir,
  };
}
const quiet = (log) => log && log.ddGets.length + log.ddPosts.length + log.sbGets.length + log.rpc.length + log.statusRows.length === 0;
const zeroDataDoe = (log) => log && log.ddGets.length + log.ddPosts.length === 0;
function assertRedacted(text, ids, label) {
  for (const id of ids) assert.ok(!text.includes(id), label + ": a full account id leaked");
  for (const v of SENSITIVE) assert.ok(!text.includes(v), label + ": a sensitive row value leaked");
  assert.ok(!/ONLYSECRET/.test(text), label + ": no SECRET-marked value anywhere");
}

test("C1 usage STOPs (exit 2, rows_written=false, ZERO requests) -- strict parsing, and a value is never echoed", () => {
  const SECRET_ID = "SELLERSECRETVALUE123";
  const cases = [
    [["--bucket=india", "--max-creates=4", "--as-of=" + YESTERDAY, "--scheduled", "--dryrun"], /unknown argument --dryrun/],
    [["--bucket=india", "--dry-run=true"], /--dry-run takes no value/],
    [["--bucket=india", "--bucket=us-ca", "--dry-run"], /duplicate argument --bucket/],
    [["--bucket=india", "--accounts=" + SECRET_ID, "--accounts=" + SECRET_ID, "--dry-run"], /duplicate argument --accounts/],
    [["--bucket=india", "--max-creates"], /--max-creates needs =<value>/],
    [["--bucket=india", "positional-" + SECRET_ID], /unknown argument #2/],
    [["--bucket=eu", "--dry-run"], /--bucket must be one region/],
    [["--bucket=india", "--as-of=" + YESTERDAY, "--scheduled"], /--max-creates=N .* REQUIRED for a paid run/],
    [["--bucket=india", "--max-creates=61", "--as-of=" + YESTERDAY, "--scheduled"], /--max-creates must be an integer 0\.\.60/],
    [["--bucket=india", "--max-creates=4", "--as-of=" + YESTERDAY], /requires --confirm-paid/],
    [["--bucket=india", "--max-creates=4", "--scheduled"], /explicit --as-of/],
    [["--bucket=india", "--max-creates=4", "--as-of=" + YESTERDAY, "--scheduled", "--accounts=" + SECRET_ID], /--scheduled runs the whole region/],
    [["--bucket=india", "--max-creates=4", "--as-of=" + YESTERDAY, "--scheduled", "--allow-shrink=" + SECRET_ID], /operator-only/],
    [["--bucket=india", "--dry-run", "--evidence-file=" + join(APP, "returns-evidence-inside.json")], /OUTSIDE the git work tree/],
  ];
  for (const [argv, re] of cases) {
    const c = runCli(argv);
    assert.equal(c.code, 2, "exit 2 for " + argv.join(" ").replace(SECRET_ID, "<id>"));
    assert.match(c.stderr, /^STOP /m); assert.match(c.stderr, re);
    assert.ok(!c.stderr.includes(SECRET_ID) && !c.stdout.includes(SECRET_ID), "a usage STOP never echoes a value");
    assert.equal(c.rowsWritten, "false"); assert.ok(quiet(c.log), "a usage STOP makes no request");
  }
  assert.ok(!existsSync(join(APP, "returns-evidence-inside.json")));
});

test("C2 the typed configuration gate: no Supabase URL -> STOP RELEASE_CONFIG_UNAVAILABLE (exit 1), ZERO requests", () => {
  const c = runCli(["--bucket=india", "--dry-run"], {}, { SUPABASE_URL: "" });
  assert.equal(c.code, 1); assert.match(c.stderr, /RELEASE_CONFIG_UNAVAILABLE/); assert.equal(c.rowsWritten, "false"); assert.ok(quiet(c.log));
});

test("C3 controls UNREADABLE / MISSING: typed skip (exit 0), a FAILED status row with the code, ZERO DataDoe, rows_written=false", () => {
  for (const [controls, code] of [["unreadable", "RETURNS_CONTROLS_UNREADABLE"], ["missing", "RETURNS_CONTROLS_MISSING"]]) {
    const c = runCli(["--bucket=india", "--max-creates=4", "--as-of=" + YESTERDAY, "--scheduled"], { controls, accounts: [IN(acct(91))] });
    assert.equal(c.code, 0, code); assert.equal(c.result.classification, code); assert.equal(c.rowsWritten, "false");
    assert.ok(zeroDataDoe(c.log)); assert.equal(c.log.rpc.length, 0);
    assert.equal(c.log.statusRows.length, 1); assert.equal(c.log.statusRows[0].last_status, "failed"); assert.equal(c.log.statusRows[0].safe_error_code, code);
    assert.equal(c.log.statusRows[0].bucket, "india"); assert.equal(c.log.statusRows[0].source_key, "returns");
  }
});

test("C4 PAUSED (operator) and schedule NOT ENABLED (--scheduled): SILENT skips -- exit 0, no status row, ZERO DataDoe", () => {
  const p = runCli(["--bucket=india", "--max-creates=4", "--as-of=" + YESTERDAY, "--confirm-paid"], { controls: { paused: true, schedule_enabled: true } });
  assert.equal(p.code, 0); assert.equal(p.result.classification, "RETURNS_PAUSED"); assert.equal(p.log.statusRows.length, 0); assert.ok(zeroDataDoe(p.log)); assert.equal(p.rowsWritten, "false");
  const s = runCli(["--bucket=india", "--max-creates=4", "--as-of=" + YESTERDAY, "--scheduled"], { controls: { paused: false, schedule_enabled: false } });
  assert.equal(s.code, 0); assert.equal(s.result.classification, "RETURNS_SCHEDULE_NOT_ENABLED"); assert.equal(s.log.statusRows.length, 0); assert.ok(zeroDataDoe(s.log));
  const C = acct(95);
  const o = runCli(["--bucket=india", "--max-creates=4", "--as-of=" + YESTERDAY, "--confirm-paid"], { controls: { paused: false, schedule_enabled: false }, accounts: [IN(C)], dataset: { [C]: [fba(C, utcDay(-3))] } });
  assert.equal(o.code, 0, "an operator canary is NOT gated by schedule_enabled (only the scheduled job is)");
  assert.equal(o.result.classification, "COMPLETE"); assert.equal(o.log.ddPosts.length, 1); assertReturnsOnly(o.log, "C4");
});

test("C5 a SCHEDULED paid run end to end: Returns-only creates, rows_written=true, RESULT / summary / status row redacted, exit 0", () => {
  const [A, B] = [acct(101), acct(102)];
  const day = (n) => utcDay(-1 - n);
  const c = runCli(["--bucket=india", "--max-creates=4", "--reserve-tokens=108", "--as-of=" + YESTERDAY, "--scheduled"],
    { accounts: [IN(A), IN(B)], dataset: { [A]: [fba(A, day(10)), fbm(A, day(1))], [B]: [fba(B, day(40))] } });
  assert.equal(c.code, 0, c.stderr.slice(0, 300));
  assertReturnsOnly(c.log, "C5");
  assert.equal(c.log.ddPosts.length, 1); assert.deepEqual(windowsOf(c.log), [day(59) + ".." + YESTERDAY]);
  assert.equal(c.rowsWritten, "true"); assert.ok(c.outputs.includes("rows_written=true"));
  assert.equal(c.result.classification, "COMPLETE"); assert.equal(c.result.creates, 1); assert.equal(c.result.tokens, 2); assert.equal(c.result.counts["initial-loaded"], 2);
  assert.equal(c.log.statusRows.at(-1).last_status, "succeeded"); assert.equal(c.log.statusRows.at(-1).creates_spent, 1);
  assert.match(c.summary, /Returns \(FBA & FBM\) india/);
  assertRedacted(c.stdout + c.stderr + c.summary + JSON.stringify(c.log.statusRows) + JSON.stringify(c.log.failures), [A, B], "C5");
  assert.ok(c.stdout.includes(A.slice(0, 8)), "the 8-character prefix is the reporting form");
});

test("C6 an OPERATOR canary: --accounts limits the run, --no-adopt-list never lists, --evidence-file lands OUTSIDE the work tree with full ids", () => {
  const [A, B] = [acct(111), acct(112)];
  const c = runCli(["--bucket=india", "--max-creates=2", "--as-of=" + YESTERDAY, "--confirm-paid", "--accounts=" + A, "--no-adopt-list", "--evidence-file"],
    { accounts: [IN(A), IN(B)], dataset: { [A]: [fba(A, utcDay(-5))], [B]: [fba(B, utcDay(-6))] } });
  assert.equal(c.code, 0, c.stderr.slice(0, 300));
  assertReturnsOnly(c.log, "C6");
  assert.equal(c.log.listings, 0); assert.equal(c.log.ddPosts.length, 1); assert.deepEqual(c.log.ddPosts[0].sellerOrVendorIds, [A]);
  assert.equal(c.result.counts["initial-loaded"], 1);
  const files = readdirSync(c.runDir).filter((f) => /^returns-evidence-india-.*\.json$/.test(f));
  assert.equal(files.length, 1, "the bare --evidence-file resolves under os.tmpdir()");
  const ev = JSON.parse(readFileSync(join(c.runDir, files[0]), "utf8"));
  assert.equal(ev.exports.created.length, 1); assert.ok(ev.exports.created[0].length > 8, "the evidence file keeps the FULL export id");
  assert.ok(!c.stdout.includes(ev.exports.created[0]), "the console only ever shows the 8-character prefix");
  assertRedacted(c.stdout + c.stderr + c.summary, [A, B], "C6");
});

test("C7 an operator DRY-RUN: ZERO creates, ZERO listing, ZERO Supabase writes, rows_written=false, exit 0", () => {
  const [A, B] = [acct(121), acct(122)];
  const c = runCli(["--bucket=india", "--dry-run"], { accounts: [IN(A), IN(B)] });
  assert.equal(c.code, 0, c.stderr.slice(0, 300));
  assert.deepEqual(c.log.violations, []);
  assert.equal(c.log.ddPosts.length + c.log.listings + c.log.rpc.length + c.log.statusRows.length, 0);
  assert.equal(c.result.classification, "DRY_RUN"); assert.equal(c.result.exposure.plannedCreates, 1); assert.equal(c.rowsWritten, "false");
});

test("C8 an out-of-range --as-of on a paid run STOPs before any request (RETURNS_ASOF_OUT_OF_RANGE, exit 2)", () => {
  const c = runCli(["--bucket=india", "--max-creates=2", "--as-of=" + utcDay(-5), "--confirm-paid"], { accounts: [IN(acct(131))] });
  assert.equal(c.code, 2); assert.match(c.stderr, /RETURNS_ASOF_OUT_OF_RANGE/); assert.ok(quiet(c.log)); assert.equal(c.rowsWritten, "false");
});

test("C9 a SYSTEMIC failure (the run lease RPC errors): exit 1, rows_written=false, ZERO creates, a FAILED status row", () => {
  const c = runCli(["--bucket=india", "--max-creates=4", "--as-of=" + YESTERDAY, "--scheduled"], { accounts: [IN(acct(141))], failRpc: ["acquire_returns_run_lease"] });
  assert.equal(c.code, 1); assert.equal(c.rowsWritten, "false"); assert.equal(c.log.ddPosts.length, 0); assert.deepEqual(c.log.violations, []);
  assert.equal(c.result.ok, false); assert.equal(c.log.statusRows.at(-1).last_status, "failed");
});

test("C10 an operator id OUTSIDE the region (--accounts / --allow-shrink): typed STOP (exit 2) after zero-token reads -- no lease, no create, no write, the id never echoed", () => {
  const A = acct(151); const FOREIGN = acct(159);
  for (const [flagArg, code] of [["--accounts=" + FOREIGN, "RETURNS_ALLOWLIST_NOT_IN_REGION"], ["--allow-shrink=" + FOREIGN, "RETURNS_ALLOW_SHRINK_NOT_IN_SCOPE"]]) {
    const c = runCli(["--bucket=india", "--max-creates=2", "--as-of=" + YESTERDAY, "--confirm-paid", flagArg], { accounts: [IN(A)], dataset: { [A]: [fba(A, utcDay(-4))] } });
    assert.equal(c.code, 2, code); assert.match(c.stderr, new RegExp("STOP " + code));
    assert.deepEqual(c.log.violations, []); assert.equal(c.log.ddPosts.length + c.log.listings + c.log.rpc.length + c.log.statusRows.length, 0);
    assert.equal(c.rowsWritten, "false"); assertRedacted(c.stdout + c.stderr, [A, FOREIGN], "C10");
  }
});

// ================================================ D. static import closure ================================================
// Every relative static import / re-export / literal dynamic import, followed recursively (comments are NOT stripped, so a
// commented-out import only makes the closure larger -- the proof stays conservative).
function importClosure(entries) {
  const seen = new Set(); const stack = entries.map((e) => resolve(e)); const unresolved = [];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src = "";
    try { src = readFileSync(f, "utf8"); } catch { continue; }
    const specs = [
      ...[...src.matchAll(/\bimport\s+(?:[^'"`;]*?\s+from\s+)?["']([^"'\n]+)["']/g)].map((m) => m[1]),
      ...[...src.matchAll(/\bexport\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/g)].map((m) => m[1]),
      ...[...src.matchAll(/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g)].map((m) => m[1]),
    ];
    // a NON-literal dynamic import could not be followed: report it (comment lines -- prose such as "import (x)" -- skipped)
    const codeLines = src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
    for (const m of codeLines.matchAll(/\bimport\s*\(\s*([^"'\s)][^)]*)\)/g)) unresolved.push({ file: f, expr: m[1].slice(0, 60) });
    for (const s of specs) if (s.startsWith(".")) stack.push(resolve(dirname(f), s));
  }
  return { files: seen, unresolved };
}
const LEGACY = [join(APP, "lib", "server", "sync", "returns-operation.js"), join(APP, "scripts", "release", "returns-leakage-golive.mjs")].map((p) => resolve(p));

test("D1 STATIC import closure: the CLI and the runner can NEVER reach returns-operation.js / returns-leakage-golive.mjs", () => {
  const runner = join(APP, "lib", "server", "sync", "returns-event-runner.js");
  const cli = importClosure([CLI]); const run = importClosure([runner]);
  for (const f of LEGACY) assert.ok(existsSync(f), "the legacy file exists (the check is not vacuous)");
  assert.ok(cli.files.has(resolve(runner)) && cli.files.has(resolve(APP, "lib", "server", "ads-sync.js")) && cli.files.has(resolve(APP, "lib", "server", "supabase.js")),
    "the scanner follows the CLI's dynamic imports into the runner, the transport and the wrappers");
  for (const f of LEGACY) {
    assert.ok(!cli.files.has(f), "the CLI closure reaches a legacy Returns module");
    assert.ok(!run.files.has(f), "the runner closure reaches a legacy Returns module");
  }
  const legacy = importClosure([LEGACY[1]]);
  assert.ok(legacy.files.has(LEGACY[0]), "SELF-CHECK: the scanner finds the legacy operator's dynamic import of returns-operation.js");
  const unresolved = [...cli.unresolved, ...run.unresolved];
  assert.deepEqual(unresolved.map((u) => u.file), [], "no non-literal dynamic import in the closure (it could not be followed)");
});

// ================================================ run ================================================
process.exitCode = 1; // until every test ran and passed (a drained event loop can never exit 0)
let finished = false;
process.on("exit", () => {
  if (!finished) { out("not ok - the event loop drained after " + passed + " of " + tests.length + " test(s): a test never settled"); process.exitCode = 1; }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});
(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); passed += 1; out("ok - " + t.name); }
    catch (e) { failed += 1; out("not ok - " + t.name + "\n  " + String(e && e.stack ? e.stack : e).split("\n").slice(0, 8).join("\n  ")); }
  }
  finished = true;
  out("\nreturns-only-exports: " + passed + "/" + tests.length + " passed");
  process.exitCode = failed === 0 && passed === tests.length ? 0 : 1;
})();
