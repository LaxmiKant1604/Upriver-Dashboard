import { runAdsSync, verifyCronRequest } from "../ads-sync.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!verifyCronRequest(req, res)) return;
  try { res.status(200).json(await runAdsSync(["AU"], ["asin-performance-v1"])); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Ads sync failed." }); }
}
