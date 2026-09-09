// RELEASE GUARD proof: every AUTOMATIC scheduler family MUST declare its production contract (schedulerOwner,
// dependencies, frozen-plan participation, token/create ceiling, completion output, partial/deferred behavior,
// watchdog idempotency), the declarations pass the guard, and the declared P0-A/P1 contracts match the real
// scheduler-v2 workflow + source registry. A future undeclared scheduled family fails this guard. Offline, pure.
// 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { writeSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  SCHEDULED_FAMILY_REGISTRY, REQUIRED_DAILY_FAMILIES, REQUIRED_FAMILY_DECLARATION_FIELDS,
  validateScheduledFamilyDeclaration, validateScheduledFamilyRegistry,
} from "../lib/server/sync/scheduled-family-registry.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "scheduled-family-registry (release guard)\n");

// 1. The whole registry validates + every REQUIRED daily family is declared.
{
  const r = validateScheduledFamilyRegistry();
  ok("G1: the scheduled-family registry validates (all declarations complete + in-enum): " + JSON.stringify(r.problems), r.ok === true);
  for (const req of REQUIRED_DAILY_FAMILIES) {
    ok("G2: required daily family declared: " + req, !!SCHEDULED_FAMILY_REGISTRY[req]);
  }
}

// 2. Every declaration carries EVERY required field (the seven-field contract).
{
  for (const [key, decl] of Object.entries(SCHEDULED_FAMILY_REGISTRY)) {
    const missing = REQUIRED_FAMILY_DECLARATION_FIELDS.filter((f) => !(f in decl));
    ok("G3: " + key + " declares all seven contract fields", missing.length === 0);
  }
}

// 3. P0-A contract: Catalog is frozen in the OLI step, executed in the priority step (never a case-c not-drained).
{
  const cat = SCHEDULED_FAMILY_REGISTRY["product-catalog"];
  ok("G4 (P0-A): product-catalog frozenPlanParticipation = freeze-in-oli-step-execute-in-priority-step",
    cat.frozenPlanParticipation === "freeze-in-oli-step-execute-in-priority-step");
  ok("G4b (P0-A): product-catalog depends on order-line-items + is drained/finalized by the priority owner",
    cat.dependencies.includes("order-line-items") && cat.schedulerOwner === "scheduler-v2:priority" && cat.completionOutput === "cycle-drained-finalized");
  const oli = SCHEDULED_FAMILY_REGISTRY["order-line-items"];
  ok("G4c (P0-A): OLI is freeze-and-execute with a computed-per-region ceiling (never a static floor)",
    oli.frozenPlanParticipation === "freeze-and-execute" && oli.ceiling === "computed-per-region");
}

// 4. P1 contract: FBA emits a machine-readable completion; v3 gates on it (not on job success).
{
  const fba = SCHEDULED_FAMILY_REGISTRY["fba-inventory-health"];
  ok("G5 (P1): fba completionOutput = fba_complete-job-output + partial stays visibly partial",
    fba.completionOutput === "fba_complete-job-output" && fba.partialBehavior === "stay-visibly-partial");
  const v3 = SCHEDULED_FAMILY_REGISTRY["listing-health-v3"];
  ok("G6 (P1): listing-health-v3 depends on fba-inventory-health + skips typed with zero creates when incomplete",
    v3.dependencies.includes("fba-inventory-health") && v3.partialBehavior === "skip-typed-zero-creates" && v3.completionOutput === "terminal-succeeded-gate");
}

// 5. Workflow parity: the declared owners/gates match the REAL scheduler-v2.yml.
{
  const wf = readFileSync(path.join(ROOT, "../.github/workflows/scheduler-v2.yml"), "utf8");
  ok("G7 (P1 wiring): the fba job EXPORTS fba_complete as a job output", /outputs:\s*[\s\S]*?fba_complete:\s*\$\{\{\s*steps\.fba\.outputs\.fba_complete/.test(wf));
  ok("G8 (P1 wiring): the listing-health-v3 job GATES on needs.fba.outputs.fba_complete == 'true' (not merely result == 'success')",
    /needs\.fba\.outputs\.fba_complete\s*==\s*'true'/.test(wf));
  ok("G9: materialize + materialize-inventory jobs exist (zero-export owners)", /\bmaterialize:\s*\n/.test(wf) && /materialize-inventory:\s*\n/.test(wf));
  ok("G9b (Campaign Ads parity): the declared scheduled Campaign Ads family has a real refresh step in the run job",
    !!SCHEDULED_FAMILY_REGISTRY["campaign-performance"] && /Refresh Campaign Ads/.test(wf) && /scheduled-campaign-ads-refresh\.mjs/.test(wf));
}

// 6. Source-registry parity: the durable daily source families are real registered sources.
{
  const reg = readFileSync(path.join(ROOT, "lib/server/sync/source-registry.js"), "utf8");
  for (const fam of ["order-line-items", "product-catalog", "fba-inventory-health"]) {
    ok("G10: durable daily family is a registered source: " + fam, reg.includes(`sourceKey: "${fam}"`));
  }
}

// 7. NEGATIVE: an undeclared field / bad enum / unknown dependency FAILS the guard (a future family cannot ship blind).
{
  const bad = validateScheduledFamilyDeclaration({ family: "new-thing", schedulerOwner: "cron-hack", dependencies: ["ghost"], frozenPlanParticipation: "yolo", ceiling: "unbounded", completionOutput: "vibes", partialBehavior: "pretend-ok", watchdogIdempotency: "hope" }, { knownFamilies: new Set(["new-thing"]) });
  ok("G11: a bogus declaration (bad enums + unknown dep) FAILS the guard", bad.ok === false && bad.problems.length >= 5);
  const missing = validateScheduledFamilyDeclaration({ family: "x", schedulerOwner: "scheduler-v2:run" });
  ok("G12: a declaration MISSING required fields FAILS the guard", missing.ok === false && missing.problems.some((p) => /missing required field/.test(p)));
  const goodDeps = validateScheduledFamilyDeclaration(SCHEDULED_FAMILY_REGISTRY["listing-health-v3"], { knownFamilies: new Set(Object.keys(SCHEDULED_FAMILY_REGISTRY)) });
  ok("G13: a real declaration with known dependencies PASSES", goodDeps.ok === true);
}

writeSync(1, `\nscheduled-family-registry: ${passed} checks passed\n`);
