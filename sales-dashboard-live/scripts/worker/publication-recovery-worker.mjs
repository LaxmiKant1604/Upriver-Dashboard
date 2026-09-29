// Independent PUBLICATION RECOVERY WORKER -- production entrypoint (systemd: deploy/publication-recovery/).
//
//   node scripts/worker/publication-recovery-worker.mjs                 # run until SIGTERM/SIGINT
//   node scripts/worker/publication-recovery-worker.mjs --check-config  # validate env + registry + DB reachability, exit
//   node scripts/worker/publication-recovery-worker.mjs --once          # one loop iteration (smoke), exit
//
// Detects saved source evidence not yet reflected in its live dashboard report and invokes ONLY the allow-listed
// zero-export publication-route CLIs (the four legacy reconcilers + scripts/release/publication-route-reconcile.mjs) to
// publish + verify it (lib/server/recovery/worker.js). Observe-only by default: a route publishes only when ALL of
// PRW_LIVE_ROUTES (this env), public.publication_recovery_control.enabled, the route's live_enabled AND its live_regions
// allow it (every switch OFF by default). Secrets come from the protected VM env file; this process never prints one.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadReleaseEnv } from "../release/env-bootstrap.mjs";

loadReleaseEnv(); // MUST precede every env-dependent dynamic import (release-env-import-ordering rule).

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const ts = () => new Date().toISOString();
const log = (m) => console.log(`${ts()} publication-recovery: ${m}`);

const { loadRecoveryConfig } = await import("../../lib/server/recovery/config.js");
const cfg = loadRecoveryConfig();
if (!cfg.ok) {
  console.error(`${ts()} publication-recovery: STOP configuration invalid:\n - ${cfg.errors.join("\n - ")}`);
  process.exit(2);
}
const { validateRecoveryRegistry } = await import("../../lib/server/recovery/registry.js");
try { validateRecoveryRegistry(); } catch (e) { console.error(`${ts()} publication-recovery: STOP registry invalid: ${e && e.message}`); process.exit(2); }
// The PRIMARY connection's organization fingerprint (a non-reversible 24-hex digest of the key -- the ONE evidence ctx the
// route CLIs also build). Never printed.
const { primaryOrganizationFingerprint } = await import("../../lib/server/datadoe-connections.js");
const organizationFingerprint = primaryOrganizationFingerprint();
if (!organizationFingerprint) { console.error(`${ts()} publication-recovery: STOP the primary DataDoe connection is not configured (fingerprint unavailable).`); process.exit(2); }

// The release SHA comes from version.env (install.sh). No git probe: the worker spawns ONLY the allow-listed route CLIs.
const version = String(process.env.PRW_VERSION || "").trim().slice(0, 64) || "unknown";

const { createRecoveryStore } = await import("../../lib/server/recovery/store-pg.js");
const { runRoute } = await import("../../lib/server/recovery/runner.js");
const { createRecoveryWorker, interruptibleSleep: sleep } = await import("../../lib/server/recovery/worker.js");
let store;
try { store = createRecoveryStore({ connectionString: process.env.POSTGRES_URL, onError: (code) => log("db pool error (idle client dropped): " + code) }); }
catch (e) { console.error(`${ts()} publication-recovery: STOP ${String((e && e.message) || "POSTGRES_URL invalid")}`); process.exit(2); }
const config = cfg.config;

if (process.argv.includes("--check-config")) {
  let db = "unreachable", control = null;
  try { control = await store.control(); db = "ok"; } catch (e) { db = "error:" + String((e && e.code) || "unknown"); }
  console.log(JSON.stringify({
    ok: db === "ok", version, workerId: config.workerId, pollSeconds: config.pollSeconds, scanIntervalSeconds: config.scanIntervalSeconds,
    batch: config.batch, concurrency: config.concurrency, leaseSeconds: config.leaseSeconds, childMaxOldSpaceMb: config.childMaxOldSpaceMb,
    envLiveRoutes: config.liveRoutes, regions: config.regions, schedulerCooldownSeconds: config.schedulerCooldownSeconds,
    deepSweepHours: config.deepSweepHours, awaitMaxMinutes: config.awaitMaxMinutes, attestations: config.attestations,
    secretsPresent: config.secretsPresent, db, control,
  }, null, 1));
  await store.close();
  process.exit(db === "ok" ? 0 : 3);
}

const run = (args) => runRoute({ appRoot, childMaxOldSpaceMb: config.childMaxOldSpaceMb, ...args });
const worker = createRecoveryWorker({ store, run, config, sleep, log, randomUUID, version, organizationFingerprint });

if (process.argv.includes("--once")) {
  try { const busy = await worker.tick(); log(`--once complete (busy=${busy}) stats=${JSON.stringify(worker.stats)}`); }
  catch (e) { log("--once failed: " + String((e && (e.code || e.name)) || "error")); await store.close(); process.exit(1); }
  await store.close();
  process.exit(0);
}

const ac = new AbortController();
const onSignal = (sig) => { log(`${sig}: graceful stop (no new claims or children; a running read-only child is given ${config.stopGraceSeconds}s; a live/repair/cleanup child finishes within its own deadline)`); worker.stop(); ac.abort(); };
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("unhandledRejection", (e) => log("unhandledRejection: " + String((e && (e.code || e.name)) || "error")));

log(`start version=${version} worker=${config.workerId} poll=${config.pollSeconds}s tier1=${config.scanIntervalSeconds}s deepSweep=${config.deepSweepHours}h batch=${config.batch} concurrency=1 envLiveRoutes=[${config.liveRoutes.join(",")}] regions=[${config.regions.join(",")}]`);
await worker.runForever({ signal: ac.signal });
await store.close();
log("stopped");
process.exit(0);
