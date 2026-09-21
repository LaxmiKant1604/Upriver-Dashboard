// NARROW, SINGLE-ACCOUNT OLI HISTORICAL RESTORE for flexii UK (DIRECT re-export, cycle-independent).
//
// Scope is intentionally ONE account and ONE forced export. It re-fetches the canonical Order Line Items history
// for the flexii seller over [--from .. --to] (default 2025-01-01 .. 2026-09-02) with the EXACT canonical OLI
// contract (OLI_SALES_COLUMNS / GROUP_BY / AGGREGATIONS, orderBy date/ASC, limit = the DataDoe-confirmed 50,000
// source ceiling) and persists it through the atomic 9-arg replace_oli_dimensional_window RPC so ALL THREE grains
// are written together: dimensional rows (p_rows) + order-level audit (p_order_rows) + operational units
// (p_unit_rows). The RPC also folds the non-cancelled rollup (source_oli_daily_history) and writes truthful
// coverage for the exact window.
//
//   node scripts/release/flexii-oli-history-restore.mjs [--account=UUID] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
//                                                       [--token-ceiling=2] [--apply]
//
// Why this exists instead of scripts/release/oli-dimensional-replacement.mjs:
//   - that tool is BUCKET-WIDE (no single-account filter) -> would re-backfill the whole non-us bucket;
//   - it persists with a 7-arg RPC call (dimensional + folded rollup only) -> omits the order-audit and
//     operational-unit grains, so SKU Movement / operational units break for the restored history;
//   - its window loop clamps to <=180 days -> cannot do a single [2025-01-01 .. 2026-09-02] export.
//   Its ROW_CAP = 50,000 IS correct and is reused here.
//
// SAFETY:
//   - single account, single seller, at most 1 create-export (2 standard tokens) unless split is separately approved;
//   - DRY by default: resolves ownership, reads durable state, freezes the token ceiling, checks the live balance --
//     creates NO export, writes NOTHING, spends NOTHING;
//   - --apply forces exactly ONE export (bypassing the known-false coverage by creating directly). A result AT the
//     50,000 cap is a typed TRUNCATED stop (never a partial save) -> revised split plan for separate approval;
//   - a create rejection (e.g. DataDoe refuses 50,000) is a typed CONTRACT-DRIFT stop -- no retry, no extra spend;
//   - persistence window ends at --to (default 2026-09-02) so the existing valid 2026-09-03+ rows are OUTSIDE the
//     windowed delete and are preserved; false coverage inside the window is replaced with truthful coverage;
//   - never prints a raw seller/account/export id in full (only short prefixes) and never prints credentials.

import { pathToFileURL } from "node:url";

// ------------------------------- pure, side-effect-free helpers (unit-tested) -------------------------------

export const RESTORE_DEFAULTS = Object.freeze({
  account: "f08cefca-c527-41d6-a2e7-71a435478f5d", // flexii UK
  from: "2025-01-01",
  to: "2026-09-02", // strictly before the earliest valid durable row (2026-09-03), which is preserved
  preserveFrom: "2026-09-03",
  rowCap: 50000, // DataDoe-team-confirmed OLI source ceiling (2026-09-21); a result AT the cap is truncated
  tokenPerCreate: 2, // OLI is a standard source: 2 tokens per create-export
  marketplace: "GB",
  currency: "GBP",
});

// Plan the single forced export and freeze the token ceiling. Throws if the window would touch the preserved
// 2026-09-03+ history (a coveredTo >= preserveFrom would delete valid rows) or if from > to.
export function planRestore({ from, to, rowCap = RESTORE_DEFAULTS.rowCap, preserveFrom = RESTORE_DEFAULTS.preserveFrom, tokenPerCreate = RESTORE_DEFAULTS.tokenPerCreate } = {}) {
  if (!isDateStr(from) || !isDateStr(to)) throw new Error("planRestore requires ISO from/to dates (fail closed).");
  if (from > to) throw new Error(`planRestore: from (${from}) is after to (${to}).`);
  if (to >= preserveFrom) throw new Error(`planRestore: coveredTo ${to} must be strictly before the preserved boundary ${preserveFrom} (else valid 2026-09-03+ rows would be deleted).`);
  return {
    windows: [{ from, to }],
    sellerCount: 1,
    limit: rowCap,
    expectedExports: 1,
    expectedTokens: tokenPerCreate,
    tokenCeiling: tokenPerCreate, // first stage is exactly ONE create; a split needs separate approval
    preserveFrom,
  };
}

// A fetched fragment AT the cap is indistinguishable from a truncated one.
export function classifyFetchResult({ rowCount, rowCap = RESTORE_DEFAULTS.rowCap }) {
  const n = Number(rowCount);
  if (!Number.isFinite(n) || n < 0) throw new Error("classifyFetchResult: rowCount must be a non-negative number.");
  return n >= rowCap ? "truncated" : "complete";
}

// Validate a downloaded OLI fragment BEFORE any persistence: exact ownership, marketplace currency, date bounds,
// canonical-grain duplicates, and non-empty evidence. Returns a structured report; ok=false lists every reason.
export function validateFragment({ rows, expectedSeller, expectedCurrency, from, to, groupByColumns }) {
  if (!Array.isArray(rows)) throw new Error("validateFragment requires a rows array (fail closed).");
  if (!Array.isArray(groupByColumns) || !groupByColumns.length) throw new Error("validateFragment requires groupByColumns (fail closed).");
  const errors = [];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const dateOf = (r) => String(r.date ?? r.sale_date ?? "").slice(0, 10);
  const dates = rows.map(dateOf).filter((d) => isDateStr(d)).sort();
  const earliest = dates[0] || null;
  const latest = dates[dates.length - 1] || null;
  const salesSum = rows.reduce((s, r) => s + num(r.total_sales_sum ?? r.item_price_value), 0);
  const unitsSum = rows.reduce((s, r) => s + num(r.total_units_sum ?? r.quantity), 0);
  const sellers = [...new Set(rows.map((r) => String(r.seller_or_vendor_id ?? "")))].filter(Boolean);
  const currencies = [...new Set(rows.map((r) => String(r.item_price_currency ?? r.currency ?? "")))].filter(Boolean);
  // canonical-grain duplicates: rows are grouped server-side by groupByColumns, so each grain must be unique.
  const seen = new Map();
  let dupes = 0;
  for (const r of rows) {
    const k = groupByColumns.map((c) => String(r[c] ?? "")).join("");
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n > 1) dupes += 1;
  }
  const outOfRange = dates.filter((d) => d < from || d > to).length;
  if (rows.length === 0) errors.push("empty fragment (0 rows) -- inconclusive, NOT proof of zero; do not persist");
  if (sellers.length && !(sellers.length === 1 && sellers[0] === expectedSeller)) errors.push(`unexpected seller(s): ${JSON.stringify(sellers.map((s) => s.slice(0, 8)))} != ${String(expectedSeller).slice(0, 8)}`);
  if (currencies.length && !(currencies.length === 1 && currencies[0] === expectedCurrency)) errors.push(`unexpected currency(ies): ${JSON.stringify(currencies)} != ${expectedCurrency}`);
  if (outOfRange > 0) errors.push(`${outOfRange} row-date(s) outside [${from}..${to}]`);
  if (dupes > 0) errors.push(`${dupes} canonical-grain duplicate row(s)`);
  return { ok: errors.length === 0, errors, earliest, latest, salesSum, unitsSum, unitsInt: Math.round(unitsSum), dupes, sellers, currencies, outOfRange, rowCount: rows.length };
}

// Map the operational-unit rows (camelCase, from oliDimensionalRowsFromFragment) to the snake_case jsonb the RPC's
// p_unit_rows reads. byAccount / orderAuditByAccount are ALREADY snake_case and pass through unchanged.
export function unitRowsToSnake(unitRows) {
  if (unitRows == null) return null;
  if (!Array.isArray(unitRows)) throw new Error("unitRowsToSnake requires an array or null.");
  return unitRows.map((u) => ({
    seller_or_vendor_id: u.sellerOrVendorId ?? u.seller_or_vendor_id,
    sale_date: u.saleDate ?? u.sale_date,
    sku: String(u.sku ?? ""),
    child_asin: String(u.childAsin ?? u.child_asin ?? ""),
    currency: u.currency,
    priced_units: u.pricedUnits ?? u.priced_units ?? 0,
    priced_sales: (u.pricedSales ?? u.priced_sales) ?? null,
    explicit_zero_units: u.explicitZeroUnits ?? u.explicit_zero_units ?? 0,
    pending_units: u.pendingUnits ?? u.pending_units ?? 0,
    cancelled_units: u.cancelledUnits ?? u.cancelled_units ?? 0,
    source_request_hash: u.sourceRequestHash ?? u.source_request_hash,
  }));
}

export function isDateStr(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// ------------------------------- side-effecting runner (DRY by default) -------------------------------

async function main() {
  const argOf = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.split("=").slice(1).join("=") : null; };
  const ACCT = argOf("account") || RESTORE_DEFAULTS.account;
  const FROM = argOf("from") || RESTORE_DEFAULTS.from;
  const TO = argOf("to") || RESTORE_DEFAULTS.to;
  const TOKEN_CEILING = Math.max(2, Math.trunc(Number(argOf("token-ceiling") ?? RESTORE_DEFAULTS.tokenPerCreate)));
  const APPLY = process.argv.includes("--apply");
  const log = (m) => console.log("flexii-oli-restore: " + m);
  let db = null;
  // Clean shutdown: close the pg handle, settle briefly so libuv finishes closing the socket handle, then exit.
  // (Avoids a Windows "UV_HANDLE_CLOSING" assertion when process.exit races an open pg handle.)
  const finish = async (code) => { try { if (db) await db.end(); } catch { /* already closed */ } db = null; await new Promise((r) => setTimeout(r, 80)); process.exit(code); };
  const stop = (m, code = 1) => { console.error("flexii-oli-restore STOP: " + m); return finish(code); };

  let plan;
  try { plan = planRestore({ from: FROM, to: TO }); }
  catch (e) { return stop(String(e && e.message ? e.message : e), 2); }

  const { loadReleaseEnv } = await import("./env-bootstrap.mjs");
  loadReleaseEnv();
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const { getDataDoeConnections, primaryOrganizationFingerprint } = await import("../../lib/server/datadoe-connections.js");
  const { fetchAccountsDetailed, fetchExportRows } = await import("../../lib/server/datadoe.js");
  const { getDataDoeTokenBalance } = await import("../../lib/server/datadoe-usage.js");
  const { OLI_SALES_COLUMNS, OLI_SALES_AGGREGATIONS } = await import("../../lib/server/sync/report-source-contracts.js");
  const { oliDimensionalRowsFromFragment } = await import("../../lib/server/sync/source-durable-model.js");
  const pgMod = (await import("pg")).default;

  const OLI_ID = "89b27535d27c2a94db5ae39af4717f542624ff4df7802fd633e16c78674a1778";

  // GUARD: refuse to run against a stale 5,000 contract. The canonical fragment MUST already be at the 50,000 ceiling.
  const contractLimit = plan.limit;
  if (contractLimit !== 50000) return stop(`configured limit ${contractLimit} != 50000 (the DataDoe-confirmed OLI ceiling). Audit the OLI constants first.`);

  log(`account ${ACCT.slice(0, 8)} | window [${FROM}..${TO}] | limit ${contractLimit} | ceiling ${plan.expectedExports} export / ${plan.tokenCeiling} tokens | mode ${APPLY ? "APPLY" : "DRY"}`);

  // 1) OWNERSHIP (read-only directory) -- resolve the ONE connection whose directory holds flexii; confirm GB/GBP.
  const connections = getDataDoeConnections() || [];
  let conn = null, flexii = null;
  for (const c of connections) {
    if (!c || !String(c.apiKey || "").trim()) continue;
    let d; try { d = await fetchAccountsDetailed(c.apiKey); } catch { continue; }
    const f = (Array.isArray(d) ? d : []).find((a) => String(a.id) === ACCT);
    if (f) { conn = c; flexii = f; break; }
  }
  if (!flexii) return stop("account not found in any connection directory -- cannot resolve the export seller.");
  const seller = String(flexii.id);
  const country = String(flexii.country || "").toUpperCase();
  const currency = String(flexii.currency || "").toUpperCase();
  log(`ownership: seller ${seller.slice(0, 8)} | name ${flexii.name} | country ${country} | currency ${currency} | connection ${conn.id}`);
  if (country !== "GB" && country !== "UK") return stop(`marketplace ${country} is not GB/UK.`);
  if (currency !== RESTORE_DEFAULTS.currency) return stop(`currency ${currency} is not ${RESTORE_DEFAULTS.currency}.`);

  const orgFp = primaryOrganizationFingerprint();
  if (!orgFp) return stop("no primary organization fingerprint.");

  // 2) DURABLE STATE (read-only) -- prove the missing window is empty and the preserved tail is intact.
  const pgUrl = String(process.env.POSTGRES_URL || "").split("?")[0];
  if (!pgUrl) return stop("POSTGRES_URL not set.");
  db = new pgMod.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const readState = async () => {
    const q = async (sql, params) => (await db.query(sql, params)).rows[0];
    const inWin = await q("select count(*)::int n, coalesce(min(sale_date)::text,'-') mn, coalesce(max(sale_date)::text,'-') mx, coalesce(sum(total_sales_sum),0)::float s, coalesce(sum(total_units_sum),0)::int u from public.source_oli_dimensional_history where organization_fingerprint=$1 and connection_id='primary' and account_id=$2 and sale_date between $3 and $4", [orgFp, ACCT, FROM, TO]);
    const tail = await q("select count(*)::int n, coalesce(min(sale_date)::text,'-') mn, coalesce(max(sale_date)::text,'-') mx, coalesce(sum(total_sales_sum),0)::float s, coalesce(sum(total_units_sum),0)::int u from public.source_oli_dimensional_history where organization_fingerprint=$1 and connection_id='primary' and account_id=$2 and sale_date >= $3", [orgFp, ACCT, plan.preserveFrom]);
    const cov = (await db.query("select covered_from::text f, covered_to::text t, status from public.source_coverage where organization_fingerprint=$1 and connection_id='primary' and account_id=$2 and source_key='order-line-items' order by covered_from", [orgFp, ACCT])).rows;
    return { inWin, tail, cov };
  };
  const before = await readState();
  log(`durable BEFORE: in-window [${FROM}..${TO}] rows=${before.inWin.n} sales=£${Number(before.inWin.s).toFixed(2)} units=${before.inWin.u}; preserved tail (>=${plan.preserveFrom}) rows=${before.tail.n} (${before.tail.mn}..${before.tail.mx}) sales=£${Number(before.tail.s).toFixed(2)}; coverage windows=${before.cov.length}`);
  for (const c of before.cov) log(`  coverage: [${c.f}..${c.t}] ${c.status}`);

  // 3) TOKEN BALANCE (zero-token /usage-logs) -- require a confirmed usable balance >= the frozen ceiling.
  const bal = await getDataDoeTokenBalance({ apiKey: conn.apiKey }).catch(() => null);
  const usable = bal && bal.read === "ok" ? Number(bal.usable) : null;
  log(`token balance: usable=${usable == null ? "UNREADABLE" : usable} (frozen ceiling ${plan.tokenCeiling}; run token-ceiling ${TOKEN_CEILING})`);

  if (!APPLY) {
    log("DRY plan: ONE forced OLI export (seller " + seller.slice(0, 8) + ", [" + FROM + ".." + TO + "], limit " + contractLimit + ", 1 seller). Expected <=" + plan.tokenCeiling + " tokens.");
    log("If rows < 50,000 -> validate + persist all 3 grains via replace_oli_dimensional_window; if == 50,000 -> STOP truncated + revised split plan; if create rejected -> STOP contract drift.");
    log("DRY complete: no export created, nothing written, zero tokens spent. Re-run with --apply after explicit approval.");
    return finish(0);
  }

  // ---- APPLY: fail-closed guards, then exactly ONE forced export ----
  if (usable == null || usable < plan.tokenCeiling) return stop(`insufficient/unreadable usable balance (${usable}) < frozen ceiling ${plan.tokenCeiling} -- refusing before the create.`);
  if (TOKEN_CEILING < plan.tokenCeiling) return stop(`--token-ceiling ${TOKEN_CEILING} is below the required ${plan.tokenCeiling}.`);

  log("CREATE: one forced OLI export (direct create bypasses the false coverage).");
  let rows;
  try {
    rows = await fetchExportRows(conn.apiKey, OLI_ID, OLI_SALES_COLUMNS, [seller], FROM, TO, contractLimit, { groupBy: OLI_SALES_COLUMNS, aggregations: OLI_SALES_AGGREGATIONS, orderByColumn: "date", orderByDirection: "ASC" });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/\b400\b|limit|exceed|too many|contract/i.test(msg)) return stop("CONTRACT DRIFT: DataDoe rejected the 50,000-row create (" + msg.slice(0, 160) + "). No retry, no additional spend.");
    return stop("export failed (" + msg.slice(0, 160) + "). No retry.");
  }

  const afterBal = await getDataDoeTokenBalance({ apiKey: conn.apiKey }).catch(() => null);
  const afterUsable = afterBal && afterBal.read === "ok" ? Number(afterBal.usable) : null;
  const consumed = usable != null && afterUsable != null ? usable - afterUsable : null;
  log(`export returned ${rows.length} rows; tokens consumed = ${consumed == null ? "unknown" : consumed} (balance ${usable} -> ${afterUsable}).`);

  if (classifyFetchResult({ rowCount: rows.length, rowCap: contractLimit }) === "truncated") {
    return stop(`TRUNCATED: export returned ${rows.length} rows AT the ${contractLimit} cap. NOT persisted. Revised plan: split [${FROM}..${TO}] into contiguous non-overlapping subranges (each < 50,000) and re-approve. Report earliest/latest before splitting.`);
  }

  const v = validateFragment({ rows, expectedSeller: seller, expectedCurrency: RESTORE_DEFAULTS.currency, from: FROM, to: TO, groupByColumns: OLI_SALES_COLUMNS });
  log(`validation: rows=${v.rowCount} dates=${v.earliest}..${v.latest} sales=£${Number(v.salesSum).toFixed(2)} units=${v.unitsInt} dupes=${v.dupes} sellers=${JSON.stringify(v.sellers.map((s) => s.slice(0, 8)))} currencies=${JSON.stringify(v.currencies)}`);
  if (!v.ok) return stop("fragment validation failed: " + v.errors.join("; ") + ". NOT persisted (LKG preserved).");

  // 4) NORMALIZE -> all 3 grains. A blocked account (missing status / defect value) is a hard STOP for a single-account run.
  const sourceRequestHash = "flexii-oli-restore:" + FROM + ".." + TO;
  const accountsBySellerId = { [seller]: { accountId: ACCT, currency: RESTORE_DEFAULTS.currency } };
  const norm = oliDimensionalRowsFromFragment({ rows, accountsBySellerId, organizationFingerprint: orgFp, connectionId: "primary", sourceRequestHash });
  if (norm.blocked && norm.blocked.length) return stop("account BLOCKED by order-rule validation (" + norm.blocked.map((b) => b.code).join(",") + "). LKG preserved, nothing persisted.");
  const dimRows = norm.byAccount.get(ACCT) || [];
  const orderRows = norm.orderAuditByAccount.get(ACCT) || [];
  const unitRows = unitRowsToSnake(norm.operationalUnitsByAccount.get(ACCT) || []);
  log(`normalized grains: dimensional=${dimRows.length} order-audit=${orderRows.length} operational-units=${unitRows.length}`);

  // 5) PERSIST -- ONE atomic 9-arg replace bounded to [FROM..TO]; the 2026-09-03+ tail is OUTSIDE the delete.
  try {
    const res = await db.query(
      "select public.replace_oli_dimensional_window($1,$2,$3,$4::date,$5::date,$6::jsonb,now(),$7::jsonb,$8::jsonb) as r",
      [orgFp, "primary", ACCT, FROM, TO, JSON.stringify(dimRows), JSON.stringify(orderRows), JSON.stringify(unitRows)],
    );
    log("PERSIST ok: " + JSON.stringify(res.rows[0].r));
  } catch (e) {
    return stop("PERSIST failed: " + String(e && e.message ? e.message : e).slice(0, 200) + ". Transaction rolled back; LKG preserved.");
  }

  // 6) RE-READ durable state -- prove the window is now populated and the preserved tail is intact.
  const after = await readState();
  log(`durable AFTER: in-window rows=${after.inWin.n} (${after.inWin.mn}..${after.inWin.mx}, £${Number(after.inWin.s).toFixed(2)}, ${after.inWin.u} units); preserved tail rows=${after.tail.n} (${after.tail.mn}..${after.tail.mx}); coverage windows=${after.cov.length}`);
  for (const c of after.cov) log(`  coverage: [${c.f}..${c.t}] ${c.status}`);
  if (after.tail.n !== before.tail.n) log(`WARN: preserved tail row count changed ${before.tail.n} -> ${after.tail.n} (investigate before proceeding).`);
  log("RESTORE COMPLETE (persistence only). Rebuild (reconcile/materialize) is a separate, zero-export step.");
  return finish(0);
}

// Only execute when run directly (so tests can import the pure helpers without side effects).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("flexii-oli-restore FATAL: " + String(e && e.message ? e.message : e)); process.exit(1); });
}
