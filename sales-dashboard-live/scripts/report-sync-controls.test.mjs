import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROLLED_REPORT_KEYS,
  controlledReport,
  enabledReportKeys,
  reportControlCatalog,
} from "../lib/server/sync/report-controls.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
let assertions = 0;
function ok(name, fn) { fn(); assertions += 1; process.stdout.write(`  ok  ${name}\n`); }

ok("all 13 user-facing source-backed reports are controlled", () => {
  assert.equal(CONTROLLED_REPORT_KEYS.length, 13);
  assert.equal(new Set(CONTROLLED_REPORT_KEYS).size, 13);
});

ok("unknown and derived-only keys cannot be manually synced", () => {
  assert.equal(controlledReport("brand-view"), null);
  assert.equal(controlledReport("priority-feed"), null);
  assert.equal(controlledReport("made-up"), null);
});

ok("readiness is fail-closed and only production-wired reports can run", () => {
  const catalog = reportControlCatalog(CONTROLLED_REPORT_KEYS.map((report_key) => ({ report_key, schedule_enabled: true })));
  assert.ok(catalog.some((report) => report.ready));
  assert.ok(catalog.some((report) => !report.ready));
  assert.ok(catalog.filter((report) => !report.ready).every((report) => report.scheduleEnabled === false));
});

ok("enabledReportKeys ignores requested settings for locked reports", () => {
  const keys = enabledReportKeys(CONTROLLED_REPORT_KEYS.map((report_key) => ({ report_key, schedule_enabled: true })));
  for (const report of reportControlCatalog()) {
    assert.equal(keys.has(report.reportKey), report.ready);
  }
});

const migration = read("supabase/migrations/20260810_report_sync_controls.sql");
ok("migration starts every report paused and exposes no browser write policy", () => {
  assert.equal((migration.match(/\('[^']+', false\)/g) || []).length, 13);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /admins read report sync settings/i);
  assert.doesNotMatch(migration, /for (insert|update|delete|all) to authenticated/i);
});

const runner = read("lib/server/sync/run-sync.js");
ok("pause gate runs before DataDoe account discovery", () => {
  const gate = runner.indexOf('skipped: "all-reports-paused"');
  const discovery = runner.indexOf("fetchAccounts(conn.apiKey)");
  assert.ok(gate > 0 && discovery > gate);
});

ok("manual scheduler accepts report and account filters", () => {
  assert.match(runner, /reportKeys = null, accountIds = null/);
  assert.match(runner, /requestedAccountIds\.has/);
  assert.match(runner, /selectedKeys\.has\(entry\.reportKey\)/);
});

const api = read("api/admin/sync.js");
ok("admin API is admin-gated, audited, rate-limited, and report-scoped", () => {
  assert.match(api, /assertAdmin\(access\)/);
  assert.match(api, /allowManualRun/);
  assert.match(api, /report\.sync\.manual/);
  assert.match(api, /reportKeys: \[entry\.reportKey\]/);
  assert.match(api, /accountIds: accountId \? \[accountId\] : null/);
  assert.doesNotMatch(api, /refresh=1/);
});

const shell = read("src/components/shell.jsx");
const app = read("src/App.jsx");
ok("Data Sync Center route is visible only through the admin navigation", () => {
  assert.match(shell, /view: "sync-center"[^\n]+adminOnly: true/);
  assert.match(app, /view === "sync-center" && isAdmin/);
});

process.stdout.write(`${assertions} assertions passed\n`);
