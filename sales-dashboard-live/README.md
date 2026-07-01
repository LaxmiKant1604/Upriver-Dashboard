# PULSE — Amazon Seller Portfolio Sales Dashboard

A live sales dashboard across all your connected Amazon accounts, pulling
data directly from DataDoe's API. Deployed on Vercel, it stays up without
your laptop running.

## What this is

- **Frontend**: React + Vite (`src/App.jsx`) — account/brand selection,
  KPI cards, DoD/WoW/MTD/YoY comparisons, sales trend chart, and
  account/brand breakdowns.
- **Backend**: One Vercel serverless function (`api/datadoe.js`) that calls
  DataDoe's REST API using your API key. The key stays server-side only —
  it is never sent to the browser.

## One-time setup

### 1. Get your DataDoe API key
app.datadoe.com → Integrations → REST API → Create API Key. Copy it and
keep it somewhere private.

### 2. Verify the API before deploying (recommended, 30 seconds)
The endpoint paths in `api/datadoe.js` are inferred from DataDoe's MCP tool
names, since DataDoe's own docs confirm the REST API and MCP server expose
the same data. Before deploying, run this once from any terminal
(replace `YOUR_KEY`, and don't paste the output anywhere with your key
visible):

```
curl -H "Authorization: Bearer YOUR_KEY" https://api.datadoe.com/api/v1/sellers-and-vendors
```

If that returns a list of your Amazon accounts, you're good — deploy as is.
If it returns a 404 or an error, check https://api.datadoe.com/api/v1/docs
for the correct path and update the `ENDPOINTS` object at the top of
`api/datadoe.js` accordingly (it's the only place that needs to change).

### 3. Deploy
1. Push these files to your GitHub repo.
2. In Vercel: **Add New Project** → import this repo.
3. On the import screen, add one **Environment Variable**:
   - Key: `DATADOE_API_KEY`
   - Value: (the key from step 1)
4. Click **Deploy**. You'll get a live `.vercel.app` URL within about a
   minute.

### 4. Future updates
Any time you (or I) push new code to this GitHub repo, Vercel rebuilds and
redeploys automatically — no manual redeploy needed.

## Notes and known limitations (read before relying on this for decisions)

- **Currency conversion**: accounts in different currencies (e.g. INR,
  USD, AUD, CAD) are combined using static approximate FX rates set in
  `src/App.jsx` (the `FX` constant). These will drift over time — update
  them periodically, or wire in a live FX API for accuracy. Native,
  unconverted figures are always available via the "View native-currency
  figures" disclosure when a selection spans more than one currency.
- **Brand grouping**: brands are inferred automatically from account names
  (e.g. "Indya Store IN" and "Indya Store CA CA" → "Indya Store"). Accounts
  with very similar but not-quite-identical names may group incorrectly —
  double check the Brand View dropdown after your first deploy.
- **YoY comparisons**: need at least ~13 months of history per account.
  Newer accounts will show "Not enough history yet" until they have it.
- **Data freshness**: the most recent 1–2 days may still adjust slightly as
  Amazon finalizes settlement data.

## Local development (optional)

```
npm install
npm run dev
```

Note: the local dev server proxies `/api` to `localhost:3000`, which
requires `vercel dev` running separately, or you can skip local dev
entirely and just deploy — Vercel handles both frontend and API routes
together in production automatically.
