// Brand View membership SCOPE -- deterministic OFFLINE proof that membership is built ONLY from current-primary
// accounts: dd-secondary ("conn:uuid"), stale/retired (a UUID no longer discovered), and malformed ids never pin a
// brand's account set, and the scoped account set is always a subset of current primary discovery.
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import {
  isPrimaryAccountId, primaryAccountIdsOnly, scopePrimaryMembership,
  buildBrandAccountMembership, accountsForBrand,
} from "../lib/server/reports/brand-membership.js";

let passed = 0;
const out = (s) => { try { writeSync(1, s + "\n"); } catch (_e) { /* ignore */ } };
const test = (name, fn) => { try { fn(); passed += 1; out("  ok  " + name); } catch (e) { out("FAIL  " + name); out(String(e && e.stack ? e.stack : e)); process.exitCode = 1; } };

const U = (n) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36); // canonical-looking UUIDs
const A = U(1), B = U(2), STALE = U(3);

test("isPrimaryAccountId: a plain UUID is primary; dd-secondary and malformed are not", () => {
  assert.equal(isPrimaryAccountId(A), true);
  assert.equal(isPrimaryAccountId("dd-secondary:" + A), false, "conn-prefixed dd-secondary is never primary");
  assert.equal(isPrimaryAccountId("secondary:" + A), false);
  assert.equal(isPrimaryAccountId("not-a-uuid"), false);
  assert.equal(isPrimaryAccountId(""), false);
});

test("primaryAccountIdsOnly: excludes ':'-bearing dd-secondary ids and dedups", () => {
  const got = primaryAccountIdsOnly([A, "dd-secondary:" + B, A, B]);
  assert.deepEqual(got.sort(), [A, B].sort(), "secondary dropped, primaries deduped");
});

test("scopePrimaryMembership: dd-secondary, stale/retired, and malformed drop; only current primary survives", () => {
  const perAccount = [
    { accountId: A, salesBrands: ["Acme"] },
    { accountId: B, salesBrands: ["Bolt"] },
    { accountId: "dd-secondary:" + U(9), salesBrands: ["Ghost"] }, // secondary
    { accountId: STALE, salesBrands: ["Retired"] },                // real UUID, not in current primary
    { accountId: "junk-id", salesBrands: ["Bad"] },                // malformed
  ];
  const primarySet = new Set([A, B]); // current discovery
  const { scoped, dropped } = scopePrimaryMembership(perAccount, primarySet);
  assert.deepEqual(scoped.map((s) => s.accountId).sort(), [A, B].sort());
  assert.equal(dropped.ddSecondary, 1);
  assert.equal(dropped.staleRetired, 1, "a real UUID no longer discovered is stale/retired");
  assert.equal(dropped.malformed, 1);
});

test("membership account scope is a SUBSET of current primary discovery (no stale/secondary ever appears)", () => {
  const perAccount = [
    { accountId: A, salesBrands: ["Bebi Born"] },
    { accountId: STALE, salesBrands: ["Bebi Born"] }, // retired but historically sold the brand
    { accountId: "dd-secondary:" + B, salesBrands: ["Bebi Born"] },
  ];
  const primarySet = new Set([A]); // only A is current primary
  const { scoped } = scopePrimaryMembership(perAccount, primarySet);
  const membership = buildBrandAccountMembership(scoped);
  const accts = accountsForBrand(membership, "Bebi Born");
  assert.deepEqual(accts, [A], "Bebi Born resolves to ONLY the current-primary account, never the retired/secondary ones");
  assert.ok(accts.every((id) => primarySet.has(id)), "every membership account is in current primary discovery");
});

test("without a primaryIdSet, secondary + malformed still drop (stale-retired cannot be detected)", () => {
  const perAccount = [{ accountId: A, salesBrands: ["Acme"] }, { accountId: "dd-secondary:" + B, salesBrands: ["x"] }, { accountId: "junk", salesBrands: ["y"] }];
  const { scoped, dropped } = scopePrimaryMembership(perAccount, null);
  assert.deepEqual(scoped.map((s) => s.accountId), [A]);
  assert.equal(dropped.ddSecondary, 1);
  assert.equal(dropped.malformed, 1);
  assert.equal(dropped.staleRetired, 0, "no set -> stale cannot be classified (kept out of the scoped set only when malformed/secondary)");
});

out("\n" + passed + " assertions passed");
