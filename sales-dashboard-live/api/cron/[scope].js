import { runAdsSync, verifyCronRequest } from "../../lib/server/ads-sync.js";

export const config = { maxDuration: 60 };

const SCOPE_CONFIG = {
  "in-campaign": { countries: ["IN"], source: "campaign-performance-v1" },
  "in-asin": { countries: ["IN"], source: "asin-performance-v1" },
  "in-targeting": { countries: ["IN"], source: "keyword-targeting-performance-v1" },
  "americas-campaign": { countries: ["US", "CA"], source: "campaign-performance-v1" },
  "americas-asin": { countries: ["US", "CA"], source: "asin-performance-v1" },
  "americas-targeting": { countries: ["US", "CA"], source: "keyword-targeting-performance-v1" },
  "au-campaign": { countries: ["AU"], source: "campaign-performance-v1" },
  "au-asin": { countries: ["AU"], source: "asin-performance-v1" },
  "au-targeting": { countries: ["AU"], source: "keyword-targeting-performance-v1" },
  "other-campaign": { countries: "OTHER", source: "campaign-performance-v1" },
  "other-asin": { countries: "OTHER", source: "asin-performance-v1" },
  "other-targeting": { countries: "OTHER", source: "keyword-targeting-performance-v1" },
};

export default async function handler(req, res) {
  if (!verifyCronRequest(req, res)) return;
  const configForScope = SCOPE_CONFIG[String(req.query.scope || "")];
  if (!configForScope) {
    res.status(404).json({ error: "Unknown Ads cron scope." });
    return;
  }
  try {
    res.status(200).json(await runAdsSync(configForScope.countries, [configForScope.source]));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Ads sync failed." });
  }
}
