// A tiny scope + request-generation guard for account-keyed async loads. PURE, offline-testable, no React.
//
// The FBA plan config load (and any similar per-account read) must never let a SLOW, FAILED, or SUPERSEDED response
// overwrite the state of a DIFFERENT active account. The bug this guards against: comparing captured values
// (`selectedAccountId === acct`) where both sides are the SAME captured closure value, so the check is always true and
// a stale response is applied anyway.
//
// Usage:
//   const loader = makeScopedLoader(() => currentAccountRef.current);
//   const isCurrent = loader.begin(acct);        // stamps a new generation + captures the scope
//   const data = await fetch(...);               // (or it throws)
//   if (!isCurrent()) return;                     // a newer begin() ran, OR the live scope changed -> discard
//   applyToState(data);
//
// isCurrent() is true ONLY when BOTH hold: (a) no newer begin() has been called (generation match), and (b) the LIVE
// scope (read fresh from readCurrentScope) still equals the scope captured at begin(). (a) handles A->B->A (the first A
// and the B loads are superseded by the second A); (b) handles a response resolving after the scope changed with no new
// load yet. A read failure is handled by the caller checking isCurrent() in its catch before showing an error.
export function makeScopedLoader(readCurrentScope) {
  let generation = 0;
  return {
    begin(scope) {
      generation += 1;
      const myGen = generation;
      const myScope = scope;
      return function isCurrent() {
        if (myGen !== generation) return false;
        const live = typeof readCurrentScope === "function" ? readCurrentScope() : myScope;
        return live === myScope;
      };
    },
    // The current generation (for tests / diagnostics).
    generation() { return generation; },
  };
}
