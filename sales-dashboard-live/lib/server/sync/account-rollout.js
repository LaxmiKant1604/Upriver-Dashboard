// Scheduler v2 -- Gate-7 ACCOUNT ROLLOUT resolver (PURE, fail-closed; no I/O).
//
// The DURABLE account gate is an ADDITIONAL, INDEPENDENT gate on top of report-level readiness
// (SCHEDULER_V2_READY_REPORT_KEYS + report_sync_settings): a report may be ready while zero accounts are
// enabled, and an account may be enabled while every report stays locked. Neither gate weakens the other.
//
// Selection semantics (all enforced HERE so every caller shares one implementation):
//   - state.read !== "ok"                      => ZERO accounts (a read/schema failure can never widen scope);
//   - default durable state (no rows, all_primary=false) => ZERO accounts;
//   - allowlist mode (all_primary=false)       => ONLY discovered PRIMARY accounts whose EXACT public id has
//                                                 an enabled=true row; stale/unknown rows select nothing;
//   - all-primary mode (all_primary=true)      => EVERY discovered primary account (a deliberate durable
//                                                 switch -- newly connected primary accounts join
//                                                 automatically with no code change);
//   - dd-secondary NEVER enters: a `dd-secondary:`-prefixed id is rejected both as a discovered account and
//     as an allowlist row (defense in depth; the discovery classifier already excludes stale secondaries).
// There is NO wildcard and NO implicit fallback of any kind.

const SECONDARY_PREFIX = "dd-secondary:";

/**
 * Resolve which of the DISCOVERED, ACTIVE, PRIMARY accounts the durable rollout state selects.
 * `discoveredPrimary`: [{ accountId | id, ... }] -- the classifier's ACTIVE primary accounts.
 * `rolloutState`: { read, allPrimary, enabledAccountIds } from getSchedulerAccountRollout().
 * Returns { accounts, selectedIds, staleIds, reason } -- `accounts` preserves discovery order;
 * `staleIds` lists enabled allowlist rows with NO matching discovered primary account (they spend nothing).
 * Pure; never throws on data (malformed input fails closed to zero accounts).
 */
export function resolveRolloutAccounts(rolloutState, discoveredPrimary) {
  const discovered = Array.isArray(discoveredPrimary) ? discoveredPrimary : [];
  const idOf = (a) => String((a && (a.accountId ?? a.id)) || "").trim();
  // dd-secondary can never enter regardless of what the caller passed (defense in depth).
  const primary = discovered.filter((a) => {
    const id = idOf(a);
    return id.length > 0 && !id.startsWith(SECONDARY_PREFIX);
  });
  if (!rolloutState || typeof rolloutState !== "object" || rolloutState.read !== "ok") {
    return { accounts: [], selectedIds: [], staleIds: [], reason: "rollout-read-not-ok" };
  }
  if (rolloutState.allPrimary === true) {
    return { accounts: primary, selectedIds: primary.map(idOf), staleIds: [], reason: "all-primary" };
  }
  const enabled = Array.isArray(rolloutState.enabledAccountIds) ? rolloutState.enabledAccountIds : [];
  const wanted = new Set(
    enabled.map((x) => String(x || "").trim()).filter((id) => id.length > 0 && !id.startsWith(SECONDARY_PREFIX)),
  );
  if (wanted.size === 0) return { accounts: [], selectedIds: [], staleIds: [], reason: "allowlist-empty" };
  const accounts = primary.filter((a) => wanted.has(idOf(a)));
  const matched = new Set(accounts.map(idOf));
  const staleIds = [...wanted].filter((id) => !matched.has(id));
  return { accounts, selectedIds: accounts.map(idOf), staleIds, reason: "allowlist" };
}
