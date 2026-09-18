// Pure, framework-free helpers for the admin "User Access" account selector: case-insensitive multi-field search,
// "selected only" filtering, and honest counts. The React selector in App.jsx renders from these, and keeping them
// pure makes the search + selection-preservation guarantees unit-testable with zero DOM.
//
// KEY INVARIANT: the SELECTION (a Set of account ids) is INDEPENDENT of the current search text. Filtering only
// changes which rows are VISIBLE; it never mutates the selection. So an account that is selected but hidden by the
// active search stays selected, and a save persists the COMPLETE selected set -- not just the visible rows.

const S = (v) => String(v == null ? "" : v);

// The lowercased searchable fields of an account: name, country/marketplace, currency, and the stable account id. The
// component may enrich an account with `marketplace`/`countryName` (derived from the country) for a richer match; any
// missing field is skipped. Returned as separate fields (never a joined string) so a query is matched WITHIN a single
// field without needing a control-character separator.
export function accountSearchFields(account) {
  if (!account) return [];
  return [account.name, account.country, account.countryName, account.marketplace, account.currency, account.id]
    .map((v) => S(v).toLowerCase());
}

// Case-insensitive match of an account against a free-text query. An empty/whitespace query matches every account.
// Matches when the trimmed lowercased query is a substring of any ONE searchable field (name / country / marketplace /
// currency / id) -- each field is tested independently, so a term can never span two fields.
export function matchesAccountQuery(account, query) {
  const q = S(query).trim().toLowerCase();
  if (!q) return true;
  return accountSearchFields(account).some((f) => f.includes(q));
}

// Coerce a selection (array or Set of ids) to a Set of string ids.
function selSet(selectedIds) {
  if (selectedIds instanceof Set) return selectedIds;
  return new Set((Array.isArray(selectedIds) ? selectedIds : []).map((id) => S(id)));
}

// Project the account list to what should be VISIBLE for the given search text + "selected only" toggle. The selection
// is NEVER mutated; a selected-but-non-matching account is simply hidden. Input order is preserved.
export function filterAccounts(accounts, { query = "", selectedOnly = false, selectedIds = null } = {}) {
  const sel = selSet(selectedIds);
  return (Array.isArray(accounts) ? accounts : []).filter((account) => {
    if (!account) return false;
    if (selectedOnly && !sel.has(S(account.id))) return false;
    return matchesAccountQuery(account, query);
  });
}

// Honest counts for the selector header: the TOTAL number of accounts and how many are selected across ALL accounts
// (never just the visible ones) -- so the "N of M selected" stays truthful while a search is active.
export function accountSelectionCounts(accounts, selectedIds) {
  const sel = selSet(selectedIds);
  const list = Array.isArray(accounts) ? accounts : [];
  return { total: list.length, selected: list.filter((a) => a && sel.has(S(a.id))).length };
}

// Toggle one account id in a selection array immutably (add if absent, remove if present). Returned as a new array so
// React state updates cleanly; the search text is irrelevant to this operation, guaranteeing selection survives
// filtering. (Mirrors the existing App.jsx `toggle` helper, extracted so it is testable.)
export function toggleAccountId(selectedIds, accountId) {
  const id = S(accountId);
  const cur = (Array.isArray(selectedIds) ? selectedIds : []).map((x) => S(x));
  return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
}
