// Verified Postgres TLS (lib/server/pg-tls.js): pinned Supabase Root 2021 CA + hostname verification for the worker and
// the zero-export reconciler CLIs. ZERO network. 7-bit ASCII, LF.
import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import {
  SUPABASE_ROOT_2021_CA_PEM, SUPABASE_ROOT_2021_CA_SHA256, SUPABASE_PG_TRUSTED_ROOTS, verifiedPgSsl, verifiedPgConfig, pgBaseConnectionString,
} from "../lib/server/pg-tls.js";

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed += 1; writeSync(1, `  ok ${n}\n`); };
const src = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
writeSync(1, "pg-tls\n");

const x = new X509Certificate(SUPABASE_ROOT_2021_CA_PEM);
ok("T1: the embedded CA is exactly the pinned Supabase Root 2021 CA (sha256), a CA, self-signed, valid until 2031", x.fingerprint256 === SUPABASE_ROOT_2021_CA_SHA256 && SUPABASE_ROOT_2021_CA_SHA256.startsWith("80:70:25:AD:50:D4:ED:21") && x.ca === true && /CN=Supabase Root 2021 CA/.test(x.subject) && x.subject === x.issuer && x.verify(x.publicKey) && Date.parse(x.validTo) > Date.parse("2031-01-01"));

ok("T1b: every trusted root is pinned (its PEM hashes to its declared sha256) and is a self-signed CA -- rotation adds, never replaces blindly", SUPABASE_PG_TRUSTED_ROOTS.length >= 1 && SUPABASE_PG_TRUSTED_ROOTS.every((r) => { const c = new X509Certificate(r.pem); return c.fingerprint256 === r.sha256 && c.ca === true && c.subject === c.issuer; }) && SUPABASE_PG_TRUSTED_ROOTS.some((r) => r.sha256 === SUPABASE_ROOT_2021_CA_SHA256));
const ssl = verifiedPgSsl();
ok("T2: ssl = { ca: pinned root, rejectUnauthorized: true } with NO checkServerIdentity override (Node verifies the hostname)", ssl.ca === SUPABASE_ROOT_2021_CA_PEM && ssl.rejectUnauthorized === true && !("checkServerIdentity" in ssl) && Object.keys(ssl).sort().join(",") === "ca,rejectUnauthorized");

const prodShape = "postgresql://postgres.abcdefghij:S3cret-Pass@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x";
const cfg = verifiedPgConfig(prodShape, { statement_timeout: 1000 });
ok("T3: the URL query (sslmode=require, supa=...) is removed; extra pg options are kept", !cfg.connectionString.includes("?") && !cfg.connectionString.includes("sslmode") && cfg.statement_timeout === 1000 && cfg.connectionString.startsWith("postgresql://"));

// pg merges parse(connectionString) OVER the config (connection-parameters.js), so a URL sslmode would silently replace
// the verified ssl object. Prove the EFFECTIVE parameters pg will use are still the verified ones.
const require = createRequire(import.meta.url);
const ConnectionParameters = require("pg/lib/connection-parameters.js");
const eff = new ConnectionParameters(cfg);
ok("T4: pg's EFFECTIVE connection parameters keep {ca: pinned, rejectUnauthorized: true} even for a sslmode=require URL", eff.ssl && eff.ssl.ca === SUPABASE_ROOT_2021_CA_PEM && eff.ssl.rejectUnauthorized === true && eff.host === "aws-1-ap-south-1.pooler.supabase.com" && Number(eff.port) === 6543);
const weakUrl = prodShape.replace("sslmode=require", "sslmode=no-verify");
const raw = new ConnectionParameters({ connectionString: weakUrl, ssl: verifiedPgSsl() });
const safe = new ConnectionParameters(verifiedPgConfig(weakUrl));
ok("T5: (why the query is stripped) a raw URL sslmode would REPLACE the pinned ssl object -- verifiedPgConfig never lets it", raw.ssl && raw.ssl.rejectUnauthorized === false && safe.ssl.rejectUnauthorized === true && safe.ssl.ca === SUPABASE_ROOT_2021_CA_PEM);

let err = "";
try { pgBaseConnectionString("postgres://u:pa ss#word@host/db"); pgBaseConnectionString("not a url S3cret-Pass"); } catch (e) { err = String(e && e.message) + String(e && e.input); }
ok("T6: a malformed POSTGRES_URL throws a REDACTED error (never the value)", /not a valid URL/.test(err) && !err.includes("S3cret-Pass") && !err.includes("pa ss"));

const CLOSURE = [
  "lib/server/recovery/store-pg.js", "lib/server/sync/priority-control-pg-store.js",
  "scripts/release/oli-publication-reconcile.mjs", "scripts/release/fba-publication-reconcile.mjs",
  "scripts/release/ads-publication-reconcile.mjs", "scripts/release/listing-health-v3-reconcile.mjs",
];
const code = (p) => src(p).split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
ok("T7: no worker/reconciler DB site ships unverified TLS (rejectUnauthorized:false / sslmode=no-verify / NODE_TLS_REJECT_UNAUTHORIZED)", CLOSURE.every((p) => !/rejectUnauthorized\s*:\s*false|no-verify|NODE_TLS_REJECT_UNAUTHORIZED/.test(code(p))));
ok("T8: every one of those sites builds its pg config through verifiedPgConfig", CLOSURE.every((p) => /verifiedPgConfig/.test(src(p))));
ok("T9: the reconciler CLIs construct pg clients INSIDE try (an invalid URL stays a typed failure, never an uncaught throw)", CLOSURE.slice(2).every((p) => !/const (client|probe) = (makePgReadOnly\(\)|new pg\.Client\()/.test(src(p))));

writeSync(1, `pg-tls: ${passed} passed\n`);
