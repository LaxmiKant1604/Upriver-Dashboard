// Unit tests for the FBA import-lifecycle identity + note helpers (audit 2026-09-08, round 2). Pure, no React.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { importScopeKey, resolveLeadTimeNote, canApplyImport, tagConfigAccount, configForAccount, isConfigReady } from "../src/lib/import-lifecycle.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; writeSync(1, `  ok ${name}\n`); };
writeSync(1, "import-lifecycle\n");

/* scope key */
ok("scope key combines account + token; a change in EITHER changes the scope", importScopeKey("A", "t1") === "A::t1" && importScopeKey("A", "t1") !== importScopeKey("B", "t1") && importScopeKey("A", "t1") !== importScopeKey("A", "t2"));
ok("scope key is stable for null/undefined", importScopeKey(null, null) === "::" && importScopeKey(undefined, undefined) === "::");

/* note preservation */
ok("resolveLeadTimeNote: OMITTED (undefined) preserves the current note", resolveLeadTimeNote(undefined, "keep") === "keep");
ok("resolveLeadTimeNote: OMITTED (null) preserves the current note", resolveLeadTimeNote(null, "keep") === "keep");
ok("resolveLeadTimeNote: omitted with no current note -> empty", resolveLeadTimeNote(undefined, null) === "" && resolveLeadTimeNote(undefined, undefined) === "");
ok("resolveLeadTimeNote: an EXPLICIT note is used verbatim", resolveLeadTimeNote("new", "old") === "new");
ok("resolveLeadTimeNote: an EXPLICIT blank clears (intentional)", resolveLeadTimeNote("", "old") === "");

/* apply guard */
ok("canApplyImport: same scope -> ok", canApplyImport(importScopeKey("A", "t"), "A", "t").ok === true);
ok("canApplyImport: different account -> scope-changed", canApplyImport(importScopeKey("A", "t"), "B", "t").ok === false && canApplyImport(importScopeKey("A", "t"), "B", "t").reason === "scope-changed");
ok("canApplyImport: different token (session) -> scope-changed", canApplyImport(importScopeKey("A", "t1"), "A", "t2").reason === "scope-changed");
ok("canApplyImport: no preview scope -> no-preview", canApplyImport(null, "A", "t").ok === false && canApplyImport("", "A", "t").reason === "no-preview");

/* account-keyed config */
const cfgA = tagConfigAccount({ settings: { x: 1 }, leadTimes: [] }, "A");
ok("tagConfigAccount stamps __accountId + preserves fields", cfgA.__accountId === "A" && cfgA.settings.x === 1 && Array.isArray(cfgA.leadTimes));
ok("tagConfigAccount handles a null/garbage response into safe defaults", tagConfigAccount(null, "A").__accountId === "A" && tagConfigAccount(null, "A").settings === null);
ok("configForAccount: returns config only for its own account", configForAccount(cfgA, "A") === cfgA && configForAccount(cfgA, "B") === null && configForAccount(null, "A") === null);
ok("isConfigReady: true only when the config belongs to the account", isConfigReady(cfgA, "A") === true && isConfigReady(cfgA, "B") === false && isConfigReady(null, "A") === false);

writeSync(1, `\nimport-lifecycle: ${passed} checks passed\n`);
