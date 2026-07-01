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

// Source table for daily sales/units/orders per account (Profit by Date).
// This id is a stable data-model identifier, verified against DataDoe's
// data during development — should not need to change.
const SALES_SOURCE_ID = "b24cd69c06";
// Alternative source 401ffcd7e5 may match Seller Central more closely if
// settlement-lagged sales totals from b24cd69c06 are not accurate enough.
const MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT = 5;

function authHeaders(apiKey) {
  return {
    "datadoe-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

async function fetchAccounts(apiKey) {
  const r = await fetch(ENDPOINTS.sellers, { headers: authHeaders(apiKey) });
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

async function createExport(apiKey, sellerOrVendorIds, from, to) {
  const r = await fetch(ENDPOINTS.exportsCreate, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      sourceId: SALES_SOURCE_ID,
      sellerOrVendorIds,
      columns: [
        "date",
        "seller_or_vendor_id",
        "seller_or_vendor_name",
        "marketplace_country_code",
        "currency",
        "total_sales",
        "total_units_sold",
        "total_orders",
      ],
      from,
      to,
      limit: 2500,
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

async function fetchSalesRows(apiKey, sellerOrVendorIds, from, to) {
  const chunks = chunkArray(sellerOrVendorIds, MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT);
  const allRows = [];

  for (const chunk of chunks) {
    const created = await createExport(apiKey, chunk, from, to);
    const exportId = created.exportId || created.id;
    if (created.status !== "COMPLETED") {
      await pollExport(apiKey, exportId);
    }
    const rows = await downloadExport(apiKey, exportId);
    allRows.push(...rows);
  }

  return allRows;
}

async function pollExport(apiKey, exportId) {
  const maxAttempts = 12;
  const delayMs = 1500;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = await fetch(ENDPOINTS.exportStatus(exportId), { headers: authHeaders(apiKey) });
    if (!r.ok) throw new Error(`DataDoe export status check failed (${r.status})`);
    const body = await r.json();
    if (body.status === "COMPLETED") return body;
    if (body.status === "FAILED") throw new Error("DataDoe export failed to process.");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("DataDoe export timed out while processing. Try a shorter date range.");
}

async function downloadExport(apiKey, exportId) {
  const r = await fetch(ENDPOINTS.exportRaw(exportId), { headers: authHeaders(apiKey) });
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
      const rows = await fetchSalesRows(apiKey, sellerOrVendorIds, from, to);
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
      const sourceId = req.query.sourceId || SALES_SOURCE_ID;
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
      const sourceId = req.query.sourceId || SALES_SOURCE_ID;
      let ids = req.query.ids;
      if (!ids) {
        const accts = await fetchAccounts(apiKey);
        const aak = accts.find((a) => /aakriti/i.test(a.name));
        ids = accts.length ? (aak || accts[0]).id : "";
      }
      const sellerOrVendorIds = String(ids).split(",").filter(Boolean).slice(0, MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT);
      const to = req.query.to || new Date().toISOString().slice(0, 10);
      const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

      const createRes = await fetch(ENDPOINTS.exportsCreate, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ sourceId, sellerOrVendorIds, from, to, limit: 5, outputType: "JSON" }),
      });
      const createText = await createRes.text().catch(() => "");
      if (!createRes.ok) {
        res.status(200).json({ sourceId, from, to, sellerOrVendorIds, ok: false, stage: "create", status: createRes.status, body: createText.slice(0, 2000) });
        return;
      }
      let created = {};
      try { created = JSON.parse(createText); } catch (e) { /* leave empty */ }
      const exportId = created.exportId || created.id;
      if (created.status !== "COMPLETED") {
        try {
          await pollExport(apiKey, exportId);
        } catch (e) {
          res.status(200).json({ sourceId, from, to, sellerOrVendorIds, ok: false, stage: "poll", error: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      const rows = await downloadExport(apiKey, exportId);
      res.status(200).json({
        sourceId, from, to, sellerOrVendorIds, ok: true,
        rowCount: rows.length,
        columns: rows.length ? Object.keys(rows[0]) : [],
        sample: rows.slice(0, 3),
      });
      return;
    }

    res.status(400).json({ error: "Unknown action. Use ?action=accounts, ?action=sales, ?action=fields, or ?action=sample" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unexpected server error." });
  }
}
