// api/datadoe.js
//
// Serverless function that talks to DataDoe on the server side, so the
// DATADOE_API_KEY never reaches the browser. Deployed automatically by
// Vercel as /api/datadoe because it lives in the /api folder.
//
// IMPORTANT — please read:
// The endpoint paths below (ENDPOINTS) are inferred from DataDoe's MCP tool
// names (sellers_and_vendors_list, exports_create, exports_get,
// exports_raw_download), since DataDoe's docs confirm the REST API and MCP
// server expose the same underlying data. If DataDoe's actual REST paths
// turn out to differ, THIS is the only place that needs to change.
//
// To verify before relying on it, run this once with your real key
// (replace YOUR_KEY, never share the output containing your key):
//
//   curl -H "Authorization: Bearer YOUR_KEY" https://api.datadoe.com/api/v1/sellers-and-vendors
//
// If that doesn't return a list of your Amazon accounts, check
// https://api.datadoe.com/api/v1/docs for the correct path and let me know
// what you find — it's a one-line fix here.

const BASE = "https://api.datadoe.com/api/v1";

// Verified DataDoe REST details:
// - Accounts endpoint includes the /util prefix.
// - Auth uses the custom datadoe-api-key header, not Authorization: Bearer.
// - Sales exports accept no more than 5 seller/vendor IDs per request.
const ENDPOINTS = {
  sellers: `${BASE}/util/sellers-and-vendors`,
  exportsCreate: `${BASE}/exports`,
  exportStatus: (id) => `${BASE}/exports/${id}`,
  exportRaw: (id) => `${BASE}/exports/${id}/raw`,
};

// Source table for daily sales/units per account. 401ffcd7e5 ("Sales &
// Traffic by ASIN & Date") is the user-confirmed correct sales report.
// (Previously used b24cd69c06 "Profit by Date".) DataDoe aggregates each
// export by the non-metric columns selected, so requesting only date +
// seller_or_vendor_id returns one row per account per day.
// Dashboard source: fast daily per-account rollup ("Profit by Date",
// ~1 row/account/day, includes order counts). Used by action=sales for the
// multi-account dashboard, where per-ASIN volume would be millions of rows.
const DASHBOARD_SOURCE_ID = "b24cd69c06";
const DASHBOARD_COLUMNS = [
  "date",
  "seller_or_vendor_id",
  "seller_or_vendor_name",
  "marketplace_country_code",
  "currency",
  "total_sales",
  "total_units_sold",
  "total_orders",
];

// Daily Reporting sales source: "Sales & Traffic by ASIN & Date" (401ffcd7e5),
// the user-confirmed accurate report. It is per-ASIN (~700 rows/account/day,
// mostly zero-sales rows), so action=daily aggregates it to one row per account
// per day server-side. It has no currency/name columns, so only id + metrics
// are requested. Used only for the single-account Daily Reporting view.
const DAILY_SALES_SOURCE_ID = "401ffcd7e5";
const DAILY_SALES_COLUMNS = [
  "date",
  "seller_or_vendor_id",
  "total_sales",
  "total_units",
];

// Advertising source (ad sales / spend / clicks), merged into the daily report
// by (account, date).
const ADS_SOURCE_ID = "08cdc77d3d";
const ADS_COLUMNS = [
  "date",
  "seller_or_vendor_id",
  "ad_sales",
  "ad_spend",
  "ad_clicks",
];
const MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT = 5;
const DASHBOARD_ROW_LIMIT = 5000;
// The per-ASIN daily source produces ~20k rows/account/month; allow a large
// window for one account across several months.
const DAILY_ROW_LIMIT = 200000;

function authHeaders(apiKey) {
  return {
    "datadoe-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// DataDoe caps requests at 2/sec per organization. `ddFetch` spaces requests
// out to stay under that cap and transparently retries on HTTP 429 using the
// server's retry hint, so a burst of exports (e.g. the all-accounts load) or
// concurrent tabs don't surface a rate-limit error to the user.
let _lastDataDoeCall = 0;
const MIN_REQUEST_INTERVAL_MS = 550;
const MAX_RATE_LIMIT_RETRIES = 6;

async function ddFetch(url, options, attempt = 0) {
  const since = Date.now() - _lastDataDoeCall;
  if (since < MIN_REQUEST_INTERVAL_MS) await sleep(MIN_REQUEST_INTERVAL_MS - since);
  _lastDataDoeCall = Date.now();

  const r = await fetch(url, options);
  if (r.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
    let retrySec = Number(r.headers.get("retry-after")) || 0;
    try {
      const body = await r.clone().json();
      retrySec = Number(body.retryAfterSeconds) || Number(body.config && body.config.retryAfterSeconds) || retrySec || 1;
    } catch (e) {
      retrySec = retrySec || 1;
    }
    await sleep(retrySec * 1000 + 250);
    return ddFetch(url, options, attempt + 1);
  }
  return r;
}

async function fetchAccounts(apiKey) {
  const r = await ddFetch(ENDPOINTS.sellers, { headers: authHeaders(apiKey) });
  if (!r.ok) {
    throw new Error(`DataDoe accounts request failed (${r.status}). Check the endpoint path in api/datadoe.js against https://api.datadoe.com/api/v1/docs`);
  }
  const body = await r.json();
  const list = body.data || body.results || (Array.isArray(body) ? body : []);
  return list.map((a) => ({
    id: a.id,
    name: a.name,
    country: a.marketplaceCountryCode,
    countryName: a.marketplaceCountryName,
    currency: a.currency || null,
  }));
}

async function createExport(apiKey, sourceId, columns, sellerOrVendorIds, from, to, limit) {
  const r = await ddFetch(ENDPOINTS.exportsCreate, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      sourceId,
      sellerOrVendorIds,
      columns,
      from,
      to,
      limit,
      outputType: "JSON",
      orderByColumn: "date",
      orderByDirection: "ASC",
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`DataDoe export creation failed (${r.status}): ${text}`);
  }
  return r.json();
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Run an export for any source, chunking by the 5-id-per-export cap and
// combining the returned rows.
async function fetchExportRows(apiKey, sourceId, columns, sellerOrVendorIds, from, to, limit) {
  const chunks = chunkArray(sellerOrVendorIds, MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT);
  const allRows = [];

  for (const chunk of chunks) {
    const created = await createExport(apiKey, sourceId, columns, chunk, from, to, limit);
    const exportId = created.exportId || created.id;
    if (created.status !== "COMPLETED") {
      await pollExport(apiKey, exportId);
    }
    const rows = await downloadExport(apiKey, exportId);
    allRows.push(...rows);
  }

  return allRows;
}

// Aggregate raw rows to one row per (seller_or_vendor_id, date), summing the
// given numeric fields. Used to collapse the per-ASIN daily source.
function aggregateByAccountDate(rawRows, fields) {
  const byKey = new Map();
  for (const r of rawRows) {
    const key = `${r.seller_or_vendor_id}|${r.date}`;
    let agg = byKey.get(key);
    if (!agg) {
      agg = { date: r.date, seller_or_vendor_id: r.seller_or_vendor_id };
      for (const f of fields) agg[f] = 0;
      byKey.set(key, agg);
    }
    for (const f of fields) agg[f] += num(r[f]);
  }
  return [...byKey.values()];
}

const num = (v) => Number(v) || 0;

// Fold advertising rows (ad_sales/ad_spend/ad_clicks) into the sales rows by
// (account, date). Ad totals attach to the first sales row for each key so
// downstream range sums count them exactly once; days with ad activity but no
// sales row get a synthetic zero-sales row.
function mergeSalesAndAds(salesRows, adRows) {
  const firstByKey = new Map();
  for (const r of salesRows) {
    const key = `${r.seller_or_vendor_id}|${r.date}`;
    if (!firstByKey.has(key)) firstByKey.set(key, r);
  }
  for (const a of adRows) {
    const key = `${a.seller_or_vendor_id}|${a.date}`;
    const target = firstByKey.get(key);
    if (target) {
      target.ad_sales = num(target.ad_sales) + num(a.ad_sales);
      target.ad_spend = num(target.ad_spend) + num(a.ad_spend);
      target.ad_clicks = num(target.ad_clicks) + num(a.ad_clicks);
    } else {
      const row = {
        date: a.date,
        seller_or_vendor_id: a.seller_or_vendor_id,
        currency: a.currency,
        total_sales: 0,
        total_units: 0,
        total_units_sold: 0,
        ad_sales: num(a.ad_sales),
        ad_spend: num(a.ad_spend),
        ad_clicks: num(a.ad_clicks),
      };
      salesRows.push(row);
      firstByKey.set(key, row);
    }
  }
  return salesRows;
}

async function pollExport(apiKey, exportId) {
  const maxAttempts = 12;
  const delayMs = 1500;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = await ddFetch(ENDPOINTS.exportStatus(exportId), { headers: authHeaders(apiKey) });
    if (!r.ok) throw new Error(`DataDoe export status check failed (${r.status})`);
    const body = await r.json();
    if (body.status === "COMPLETED") return body;
    if (body.status === "FAILED") throw new Error("DataDoe export failed to process.");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("DataDoe export timed out while processing. Try a shorter date range.");
}

async function downloadExport(apiKey, exportId) {
  const r = await ddFetch(ENDPOINTS.exportRaw(exportId), { headers: authHeaders(apiKey) });
  if (!r.ok) throw new Error(`DataDoe export download failed (${r.status})`);
  const body = await r.json();
  if (typeof body.rawContent === "string") {
    return JSON.parse(body.rawContent);
  }
  return Array.isArray(body) ? body : [];
}

export default async function handler(req, res) {
  const apiKey = process.env.DATADOE_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "DATADOE_API_KEY is not set in this deployment's environment variables." });
    return;
  }

  try {
    const action = req.query.action;

    if (action === "accounts") {
      const accounts = await fetchAccounts(apiKey);
      res.status(200).json({ accounts });
      return;
    }

    if (action === "sales") {
      const { ids, from, to } = req.query;
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      const rows = await fetchExportRows(apiKey, DASHBOARD_SOURCE_ID, DASHBOARD_COLUMNS, sellerOrVendorIds, from, to, DASHBOARD_ROW_LIMIT);
      res.status(200).json({ rows });
      return;
    }

    // Daily Reporting data: single-account sales/units from the accurate but
    // per-ASIN source 401ffcd7e5 (aggregated to one row per day), merged with
    // advertising figures from 08cdc77d3d.
    if (action === "daily") {
      const { ids, from, to } = req.query;
      if (!ids || !from || !to) {
        res.status(400).json({ error: "Missing required params: ids, from, to" });
        return;
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean);
      const salesRaw = await fetchExportRows(apiKey, DAILY_SALES_SOURCE_ID, DAILY_SALES_COLUMNS, sellerOrVendorIds, from, to, DAILY_ROW_LIMIT);
      const rows = aggregateByAccountDate(salesRaw, ["total_sales", "total_units"]);
      for (const r of rows) r.total_units_sold = r.total_units;
      const adRaw = await fetchExportRows(apiKey, ADS_SOURCE_ID, ADS_COLUMNS, sellerOrVendorIds, from, to, DAILY_ROW_LIMIT);
      const ads = aggregateByAccountDate(adRaw, ["ad_sales", "ad_spend", "ad_clicks"]);
      mergeSalesAndAds(rows, ads);
      res.status(200).json({ rows });
      return;
    }

    // Temporary discovery route to find DataDoe's advertising data source and
    // its column names. Hit this once on the live deployment, e.g.
    //   /api/datadoe?action=fields
    //   /api/datadoe?action=fields&sourceId=<id>
    // then read the JSON to identify the ad source id + ad sales/spend/clicks
    // column names, wire them into the "sales" export columns (or a new
    // "ads" action), and remove this route afterwards.
    if (action === "fields") {
      const sourceId = req.query.sourceId || DAILY_SALES_SOURCE_ID;
      const candidates = [
        `${BASE}/sources`,
        `${BASE}/util/sources`,
        `${BASE}/data-sources`,
        `${BASE}/util/data-sources`,
        `${BASE}/util/data-models`,
        `${BASE}/sources/${sourceId}`,
        `${BASE}/sources/${sourceId}/columns`,
        `${BASE}/util/sources/${sourceId}`,
        `${BASE}/util/sources/${sourceId}/columns`,
      ];
      const results = {};
      for (const url of candidates) {
        try {
          const r = await fetch(url, { headers: authHeaders(apiKey) });
          const text = await r.text().catch(() => "");
          results[url] = { status: r.status, ok: r.ok, body: text.slice(0, 4000) };
        } catch (e) {
          results[url] = { error: e instanceof Error ? e.message : String(e) };
        }
        // Stay under DataDoe's ~2 req/sec org rate limit while probing.
        await new Promise((resolve) => setTimeout(resolve, 550));
      }
      res.status(200).json({ sourceId, note: "Discovery route — identify the ad source id + column names, then remove this action.", results });
      return;
    }

    // Temporary discovery route: pull a small real sample from a source (no
    // columns specified) to reveal its actual column names and row granularity.
    //   /api/datadoe?action=sample&sourceId=401ffcd7e5
    // Remove this route once the source/columns are confirmed.
    if (action === "sample") {
      const sourceId = req.query.sourceId || DAILY_SALES_SOURCE_ID;
      let ids = req.query.ids;
      if (!ids) {
        const accts = await fetchAccounts(apiKey);
        const aak = accts.find((a) => /aakriti/i.test(a.name));
        ids = accts.length ? (aak || accts[0]).id : "";
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean).slice(0, MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT);
      const to = req.query.to || new Date().toISOString().slice(0, 10);
      const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const limit = Number(req.query.limit) || 200;
      // Columns must be specified (DataDoe rejects an empty/absent list). Pass
      // ?columns=a,b,c to probe arbitrary columns, else default by source.
      let columns;
      if (req.query.columns) columns = String(req.query.columns).split(",").map((c) => c.trim()).filter(Boolean);
      else if (sourceId === DAILY_SALES_SOURCE_ID) columns = DAILY_SALES_COLUMNS;
      else if (sourceId === DASHBOARD_SOURCE_ID) columns = DASHBOARD_COLUMNS;
      else if (sourceId === ADS_SOURCE_ID) columns = ADS_COLUMNS;
      else columns = ["date", "seller_or_vendor_id"];

      const createRes = await ddFetch(ENDPOINTS.exportsCreate, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ sourceId, sellerOrVendorIds, columns, from, to, limit, outputType: "JSON", orderByColumn: "date", orderByDirection: "ASC" }),
      });
      const createText = await createRes.text().catch(() => "");
      if (!createRes.ok) {
        res.status(200).json({ sourceId, from, to, columns, sellerOrVendorIds, ok: false, stage: "create", status: createRes.status, body: createText.slice(0, 2000) });
        return;
      }
      let created = {};
      try { created = JSON.parse(createText); } catch (e) { /* leave empty */ }
      const exportId = created.exportId || created.id;
      if (created.status !== "COMPLETED") {
        try {
          await pollExport(apiKey, exportId);
        } catch (e) {
          res.status(200).json({ sourceId, from, to, columns, sellerOrVendorIds, ok: false, stage: "poll", error: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      const rows = await downloadExport(apiKey, exportId);
      // Summaries to diagnose granularity/magnitude without dumping everything.
      const salesSum = rows.reduce((a, r) => a + (Number(r.total_sales) || 0), 0);
      const unitsSum = rows.reduce((a, r) => a + (Number(r.total_units) || 0), 0);
      const dates = rows.map((r) => r.date).filter(Boolean);
      res.status(200).json({
        sourceId, from, to, columns, sellerOrVendorIds, ok: true,
        rowCount: rows.length,
        rowKeys: rows.length ? Object.keys(rows[0]) : [],
        distinctDates: new Set(dates).size,
        minDate: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
        maxDate: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
        salesSum, unitsSum,
        sample: rows.slice(0, 8),
      });
      return;
    }

    res.status(400).json({ error: "Unknown action. Use ?action=accounts, ?action=sales, ?action=fields, or ?action=sample" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unexpected server error." });
  }
}
