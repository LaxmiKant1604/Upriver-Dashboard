// Secure scheduled-sync cron endpoint.
//
//   GET /api/cron/sync?bucket=non-us   (02:00 UTC / 07:30 IST)
//   GET /api/cron/sync?bucket=us       (10:30 UTC / 16:00 IST)
//
// Auth is Vercel-Cron / driver style: Authorization: Bearer <CRON_SECRET>, checked
// by verifyCronRequest (401 without it). A browser user can never reach this.
// One invocation does a bounded (<=~50s) slice and returns { drained }. A driver
// (GitHub Actions loop, see .github/workflows/scheduled-sync.yml) calls it until
// drained:true; the per-bucket lock makes repeated/overlapping calls safe.

import { verifyCronRequest } from "../../lib/server/ads-sync.js";
import { runScheduledSync } from "../../lib/server/sync/run-sync.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!verifyCronRequest(req, res)) return; // sends 401/500 itself
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  const bucket = String(req.query?.bucket || "");
  if (bucket !== "us" && bucket !== "non-us") {
    res.status(400).json({ error: "Query param 'bucket' must be 'us' or 'non-us'." });
    return;
  }
  const trigger = String(req.query?.trigger || "cron-vercel");
  try {
    const result = await runScheduledSync({ bucket, trigger });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "scheduled sync failed" });
  }
}
