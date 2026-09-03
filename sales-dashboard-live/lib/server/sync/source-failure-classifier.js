// Centralized TYPED failure classification for durable SOURCE (DataDoe export) operations. PURE + offline-testable.
//
// One authority so every source path (activated for Campaign Ads now; reusable) classifies a create / poll / download
// / parse / coverage failure identically, records SAFE bounded diagnostics (NEVER a secret, api key, authorization
// header or full sensitive payload), and drives the stage-aware retry / split / isolate policy. The terminal /
// retryable / ambiguous flags are mutually consistent so a caller can branch on flags without re-deriving the rule.

export const SOURCE_FAILURE = Object.freeze({
  REQUEST_REJECTED: "SOURCE_REQUEST_REJECTED",       // create-time non-transient 4xx (400 / 422) on a MULTI-seller batch
  RATE_LIMITED: "SOURCE_RATE_LIMITED",               // HTTP 429
  UPSTREAM_TRANSIENT: "SOURCE_UPSTREAM_TRANSIENT",   // HTTP 5xx
  CREATE_AMBIGUOUS: "SOURCE_CREATE_AMBIGUOUS",       // timeout / connection reset / interrupted create -- unknown if it landed
  POLL_FAILED: "SOURCE_POLL_FAILED",
  DOWNLOAD_FAILED: "SOURCE_DOWNLOAD_FAILED",
  SCHEMA_INVALID: "SOURCE_SCHEMA_INVALID",
  SELLER_COVERAGE_MISSING: "SOURCE_SELLER_COVERAGE_MISSING",
  ACCOUNT_REJECTED: "SOURCE_ACCOUNT_REJECTED",       // definitive create-time 4xx that REMAINS for a SINGLE seller
});

export const MAX_EXCERPT = 300;

// Strip anything that could be a secret from a diagnostic excerpt + bound its length. Never persist a raw body wholesale.
export function sanitizeExcerpt(text) {
  return String(text == null ? "" : text)
    // Redact a credential following any auth keyword -- including an optional "Bearer " prefix + a dotted/typed token
    // (JWT-style, dd_api_..., etc.). The keyword itself is kept so the excerpt stays diagnostic.
    .replace(/\b(authorization|api[_-]?key|bearer|token|secret|password)\b\s*[:=]?\s*(?:bearer\s+)?[A-Za-z0-9._\-]{4,}/gi, "$1 [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXCERPT);
}

/**
 * Classify one source-operation failure into a typed outcome + flags. Inputs (all optional, safe):
 *   stage             : "create" | "poll" | "download" | "parse" | "coverage"
 *   status            : HTTP status (number) or null
 *   network           : true when the underlying fetch THREW (connection reset / timeout / interrupted)
 *   singleSeller      : true when the failing batch holds EXACTLY one seller (a definitive 4xx is then account-level)
 *   retryAfterSeconds : parsed Retry-After (number) or null
 *   message / excerpt : diagnostic text (sanitized + bounded here)
 * Returns { classification, stage, status, terminal, retryable, ambiguous, retryAfterMs, excerpt }.
 */
export function classifySourceFailure({ stage = "create", status = null, network = false, singleSeller = false, retryAfterSeconds = null, message = "", excerpt = "" } = {}) {
  const st = Number.isFinite(Number(status)) && Number(status) > 0 ? Number(status) : null;
  const base = { stage, status: st, terminal: false, retryable: false, ambiguous: false, retryAfterMs: null, excerpt: sanitizeExcerpt(excerpt || message) };

  // A network throw: a CREATE POST is AMBIGUOUS (it may have landed + charged server-side -> never blind-recreate); a
  // free idempotent GET (poll / download) is a typed stage failure that is safe to retry (the export already exists).
  if (network) {
    if (stage === "create") return { ...base, classification: SOURCE_FAILURE.CREATE_AMBIGUOUS, ambiguous: true };
    if (stage === "poll") return { ...base, classification: SOURCE_FAILURE.POLL_FAILED, retryable: true };
    if (stage === "download") return { ...base, classification: SOURCE_FAILURE.DOWNLOAD_FAILED, retryable: true };
    return { ...base, classification: SOURCE_FAILURE.DOWNLOAD_FAILED, retryable: true };
  }

  if (st === 429) return { ...base, classification: SOURCE_FAILURE.RATE_LIMITED, retryable: true, retryAfterMs: retryAfterSeconds != null && Number.isFinite(Number(retryAfterSeconds)) ? Math.max(0, Number(retryAfterSeconds)) * 1000 : null };
  if (st != null && st >= 500) return { ...base, classification: SOURCE_FAILURE.UPSTREAM_TRANSIENT, retryable: true };
  if (st != null && st >= 400) {
    if (stage === "create") return { ...base, classification: singleSeller ? SOURCE_FAILURE.ACCOUNT_REJECTED : SOURCE_FAILURE.REQUEST_REJECTED, terminal: true };
    if (stage === "poll") return { ...base, classification: SOURCE_FAILURE.POLL_FAILED, terminal: true };
    if (stage === "download") return { ...base, classification: SOURCE_FAILURE.DOWNLOAD_FAILED, terminal: true };
  }

  if (stage === "parse") return { ...base, classification: SOURCE_FAILURE.SCHEMA_INVALID, terminal: true };
  if (stage === "coverage") return { ...base, classification: SOURCE_FAILURE.SELLER_COVERAGE_MISSING, terminal: true };
  // A non-network, non-HTTP create failure fails CLOSED as a request rejection (never a blind paid retry); any other
  // stage defaults to a typed download failure (retryable only when the caller re-runs the whole free read).
  return { ...base, classification: stage === "create" ? SOURCE_FAILURE.REQUEST_REJECTED : SOURCE_FAILURE.DOWNLOAD_FAILED, terminal: stage === "create", retryable: stage !== "create" };
}

// Build the classifier input from a thrown error produced by the source layer. A SourceHttpError (from ads-sync
// createExport) carries { httpStatus, sourceStage, network, retryAfterSeconds, safeBody }; a plain Error is treated as
// a network/ambiguous create by default unless it names an HTTP status. Never reads a secret off the error.
export function classifyThrownSourceError(error, { stage = "create", singleSeller = false } = {}) {
  const e = error || {};
  const status = e.httpStatus != null ? e.httpStatus : null;
  const network = e.network === true || (status == null && /network|reset|timeout|aborted|ECONN|fetch failed/i.test(String(e.message || "")));
  return classifySourceFailure({
    stage: e.sourceStage || stage,
    status,
    network,
    singleSeller,
    retryAfterSeconds: e.retryAfterSeconds != null ? e.retryAfterSeconds : null,
    message: e.safeBody || e.message || "",
    excerpt: e.safeBody || e.message || "",
  });
}
