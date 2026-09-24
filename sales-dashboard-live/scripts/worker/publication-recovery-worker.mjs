// Independent PUBLICATION RECOVERY WORKER -- production entrypoint (systemd: deploy/publication-recovery/).
//
//   node scripts/worker/publication-recovery-worker.mjs                 # run until SIGTERM/SIGINT
//   node scripts/worker/publication-recovery-worker.mjs --check-config  # validate env + registry + DB reachability, exit
//   node scripts/worker/publication-recovery-worker.mjs --once          # one loop iteration (smoke), exit
//
// Detects saved source evidence not yet reflected in its live dashboard report and invokes ONLY the existing zero-export
// reconciler CLIs to publish + verify it (see lib/server/recovery/worker.js). Observe-only by default: a family publishes
// only when BOTH PRW_LIVE_FAMILIES (this env) AND public.publication_recovery_control (enabled + live_families) allow it.
// Secrets come from the protected VM env file; this process never prints a secret value.

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

// The release SHA comes from version.env (install.sh). No git probe: the worker spawns ONLY the four reconciler CLIs.
const version = String(process.env.PRW_VERSION || "").trim().slice(0, 64) || "unknown";

const { createRecoveryStore } = await import("../../lib/server/recovery/store-pg.js");
const { runReconcile } = await import("../../lib/server/recovery/runner.js");
const { createRecoveryWorker } = await import("../../lib/server/recovery/worker.js");
let store;
try { store = createRecoveryStore({ connectionString: process.env.POSTGRES_URL, onError: (code) => log("db pool error (idle client dropped): " + code) }); }
catch (e) { console.error(`${ts()} publication-recovery: STOP ${String((e && e.message) || "POSTGRES_URL invalid")}`); process.exit(2); }
const config = cfg.config;

if (process.argv.includes("--check-config")) {
  let db = "unreachable", control = null;
  try { control = await store.control(); db = "ok"; } catch (e) { db = "error:" + String((e && e.code) || "unknown"); }
  console.log(JSON.stringify({ ok: db === "ok", version, workerId: config.workerId, pollSeconds: config.pollSeconds, scanIntervalSeconds: config.scanIntervalSeconds, batch: config.batch, concurrency: config.concurrency, leaseSeconds: config.leaseSeconds, childMaxOldSpaceMb: config.childMaxOldSpaceMb, envLiveFamilies: config.liveFamilies, regions: config.regions, secretsPresent: config.secretsPresent, db, control }, null, 1));
  await store.close();
  process.exit(db === "ok" ? 0 : 3);
}

const { interruptibleSleep: sleep } = await import("../../lib/server/recovery/worker.js");
const run =(args) => runReconcile({ appRoot, childMaxOldSpaceMb: config.childMaxOldSpaceMb, ...args });
const worker = createRecoveryWorker({ store, run, config, sleep, log, randomUUID, version });

if (process.argv.includes("--once")) {
  try { const busy = await worker.tick(); log(`--once complete (busy=${busy}) stats=${JSON.stringify(worker.stats)}`); }
  catch (e) { log("--once failed: " + String((e && (e.code || e.name)) || "error")); await store.close(); process.exit(1); }
  await store.close();
  process.exit(0);
}

const ac = new AbortController();
const onSignal = (sig) => { log(`${sig}: graceful stop (no new claims or children; a running dry-run is given ${config.stopGraceSeconds}s; a live/cleanup child finishes within its own deadline)`); worker.stop(); ac.abort(); };
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("unhandledRejection", (e) => log("unhandledRejection: " + String((e && (e.code || e.name)) || "error")));

log(`start version=${version} worker=${config.workerId} poll=${config.pollSeconds}s scan=${config.scanIntervalSeconds}s batch=${config.batch} concurrency=1 envLive=[${config.liveFamilies.join(",")}] regions=[${config.regions.join(",")}]`);
await worker.runForever({ signal: ac.signal });
await store.close();
log("stopped");
process.exit(0);
