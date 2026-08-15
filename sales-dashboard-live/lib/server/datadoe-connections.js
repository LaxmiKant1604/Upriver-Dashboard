// Server-only DataDoe connection registry.
//
// The original DataDoe organisation keeps its existing account IDs so current
// account permissions, shared snapshots, and Ads history remain valid. A
// secondary organisation gets a stable prefix, preventing a same-looking raw
// seller/vendor ID from crossing an organisation boundary.

const PRIMARY_ID = "primary";
const SECONDARY_ID = "secondary";
const SECONDARY_PREFIX = "dd-secondary:";

function configured(value) {
  return Boolean(String(value || "").trim());
}

export function getDataDoeConnections() {
  const primaryKey = String(process.env.DATADOE_API_KEY || "").trim();
  if (!configured(primaryKey)) {
    throw new Error("DATADOE_API_KEY is not configured.");
  }

  const connections = [{
    id: PRIMARY_ID,
    label: "Primary DataDoe",
    apiKey: primaryKey,
    accountPrefix: "",
  }];
  const secondaryKey = String(process.env.DATADOE_API_KEY_SECONDARY || "").trim();
  if (configured(secondaryKey)) {
    if (secondaryKey === primaryKey) {
      throw new Error("DATADOE_API_KEY_SECONDARY must be a different DataDoe API key from DATADOE_API_KEY.");
    }
    connections.push({
      id: SECONDARY_ID,
      label: "Secondary DataDoe",
      apiKey: secondaryKey,
      accountPrefix: SECONDARY_PREFIX,
    });
  }
  return connections;
}

export function publicAccountId(connection, rawAccountId) {
  const raw = String(rawAccountId || "").trim();
  if (!raw) throw new Error("DataDoe returned an account without an ID.");
  return connection.id === PRIMARY_ID ? raw : `${connection.accountPrefix}${raw}`;
}

export function resolveDataDoeAccountIds(accountIds, connections = getDataDoeConnections()) {
  const requested = [...new Set((accountIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!requested.length) return null;

  const secondary = connections.find((connection) => connection.id === SECONDARY_ID);
  const primary = connections.find((connection) => connection.id === PRIMARY_ID);
  const resolved = requested.map((accountId) => {
    if (accountId.startsWith(SECONDARY_PREFIX)) {
      const rawAccountId = accountId.slice(SECONDARY_PREFIX.length).trim();
      if (!secondary || !rawAccountId) throw new Error("The selected secondary DataDoe account is unavailable.");
      return { accountId, rawAccountId, connection: secondary };
    }
    if (accountId.includes(":")) throw new Error("The selected DataDoe account ID is invalid.");
    if (!primary) throw new Error("The primary DataDoe connection is unavailable.");
    return { accountId, rawAccountId: accountId, connection: primary };
  });

  const connection = resolved[0].connection;
  if (resolved.some((entry) => entry.connection.id !== connection.id)) {
    throw new Error("Select accounts from one DataDoe connection at a time. Cross-organisation exports are intentionally blocked.");
  }
  return {
    connection,
    accountIds: resolved.map((entry) => entry.accountId),
    rawAccountIds: resolved.map((entry) => entry.rawAccountId),
  };
}

// Typed status for an account whose owning DataDoe connection is not configured.
export const CONNECTION_UNAVAILABLE = "CONNECTION_UNAVAILABLE";

/**
 * Classify account-directory rows against the CONFIGURED DataDoe connections BEFORE any planning.
 *
 * When the secondary DataDoe organization is retired (DATADOE_API_KEY_SECONDARY removed), the registry
 * stops returning the `secondary` connection, but historical `dd-secondary:`-prefixed accounts can still
 * appear in the directory. Such an account is STALE: it must never be planned, never be routed through
 * the primary API key, never have its prefix stripped, and never have its saved snapshots touched -- but
 * its absence must not fail the primary cycle. This partitions accounts into:
 *   - `active`   : accounts whose owning connection IS configured (planned normally); and
 *   - `unavailable`: inactive/read-only status rows { accountId (prefix intact), connectionId, status:
 *                    CONNECTION_UNAVAILABLE, active:false, readOnly:true, reason } for admin display.
 * Pure given `connections`. `account` may be a directory row ({ accountId | id, ... }); the original
 * object is preserved on each active entry and referenced on each unavailable entry.
 */
export function classifyDirectoryAccounts(accounts, connections = getDataDoeConnections()) {
  const hasPrimary = (connections || []).some((c) => c.id === PRIMARY_ID);
  const hasSecondary = (connections || []).some((c) => c.id === SECONDARY_ID);
  const active = [];
  const unavailable = [];
  const flag = (account, accountId, connectionId, reason) =>
    unavailable.push({ account, accountId, connectionId, status: CONNECTION_UNAVAILABLE, active: false, readOnly: true, reason });
  for (const account of accounts || []) {
    const accountId = String((account && (account.accountId ?? account.id)) || "").trim();
    if (!accountId) continue;
    if (accountId.startsWith(SECONDARY_PREFIX)) {
      if (hasSecondary) active.push(account);
      else flag(account, accountId, SECONDARY_ID, "Secondary DataDoe connection is not configured; the account is retained read-only.");
    } else if (accountId.includes(":")) {
      // A prefixed id whose owning connection cannot be identified -- never guess/route to primary.
      flag(account, accountId, null, "Account references an unknown DataDoe connection.");
    } else if (hasPrimary) {
      active.push(account);
    } else {
      flag(account, accountId, PRIMARY_ID, "Primary DataDoe connection is not configured.");
    }
  }
  return { active, unavailable };
}

export function connectionForApiKey(apiKey, connections = getDataDoeConnections()) {
  const connection = connections.find((entry) => entry.apiKey === apiKey);
  if (!connection) throw new Error("The requested DataDoe connection is not configured.");
  return connection;
}

export function decorateDataDoeAccount(connection, account) {
  const id = publicAccountId(connection, account.id);
  return {
    ...account,
    id,
    dataDoeConnectionId: connection.id,
    dataDoeConnectionLabel: connection.label,
    // Make duplicate account names distinguishable in the shared selector
    // without exposing either API key.
    name: connection.id === PRIMARY_ID ? account.name : `${account.name} (${connection.label})`,
  };
}

// Raw seller/vendor IDs belong to a DataDoe organisation, not to the whole
// dashboard. Two organisations can therefore legitimately return the same
// raw ID. Merge on the public, connection-scoped ID so both accounts remain
// available to the shared account and Brand View directories.
export function mergeDiscoveredDataDoeAccounts(connectionAccounts) {
  const byPublicAccountId = new Map();
  for (const { connection, accounts } of connectionAccounts || []) {
    for (const account of accounts || []) {
      const decorated = decorateDataDoeAccount(connection, account);
      // A duplicate response from the same organisation should not create a
      // duplicate selector option, while a secondary connection is already
      // distinct because its public ID carries the secondary prefix.
      if (!byPublicAccountId.has(decorated.id)) {
        byPublicAccountId.set(decorated.id, decorated);
      }
    }
  }
  return [...byPublicAccountId.values()];
}

export function scopeDataDoeRows(connection, rows) {
  return (rows || []).map((row) => {
    if (!row || row.seller_or_vendor_id === undefined || row.seller_or_vendor_id === null) return row;
    return { ...row, seller_or_vendor_id: publicAccountId(connection, row.seller_or_vendor_id) };
  });
}
