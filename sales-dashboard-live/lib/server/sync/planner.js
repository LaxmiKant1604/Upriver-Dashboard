import { countriesForBucket } from "./registry.js";

export const MAX_TARGET_ATTEMPTS = 3;

function adsScopeKey(countries) {
  return countries === "OTHER" ? "other" : countries.map((country) => String(country).toLowerCase()).sort().join("-");
}

export function expandSyncWork(entries, bucketAccounts, bucket) {
  const work = [];
  for (const entry of entries) {
    if (entry.partition === "per-bucket") {
      for (const countries of countriesForBucket(bucket).groups) {
        work.push({
          entry,
          scope: { bucket, countries },
          targetAccountId: `__bucket:${bucket}:${adsScopeKey(countries)}`,
        });
      }
      continue;
    }
    for (const account of bucketAccounts) {
      work.push({ entry, scope: { account }, targetAccountId: account.account_id });
    }
  }
  return work;
}

export function targetDisposition(target, cycleDate) {
  if (!target || target.cycle_date !== cycleDate) return { status: "due", attempts: 0 };
  const attempts = Number(target.attempts || 0);
  if (target.last_status === "succeeded") return { status: "complete", attempts };
  if (target.last_status === "failed" && attempts >= MAX_TARGET_ATTEMPTS) {
    return { status: "terminal-failure", attempts };
  }
  return { status: "due", attempts };
}
