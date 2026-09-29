// VERIFIED Postgres TLS for direct `pg` connections to the Supabase pooler (worker + zero-export reconciler CLIs).
//
// The pooler (aws-1-ap-south-1.pooler.supabase.com, cert CN/SAN *.pooler.supabase.com) presents the chain
//   leaf *.pooler.supabase.com -> "Supabase Intermediate 2021 CA" -> "Supabase Root 2021 CA" (self-signed),
// which is NOT in Node's public trust store -- hence the historical `rejectUnauthorized:false` / `sslmode=no-verify`.
// Instead we pin Supabase's PUBLISHED root (public certificate, not a secret) and verify BOTH the chain and the
// hostname (Node's default checkServerIdentity; pg sets SNI servername = host). Provenance, verified 2026-09-25:
//   * downloaded from https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt (the
//     "Download certificate" link in Supabase Database Settings -> SSL), AND
//   * byte-identical fingerprint to the root the production pooler itself presents (two independent channels);
//   * a connection by IP is rejected (ERR_TLS_CERT_ALTNAME_INVALID) and one without this CA is rejected
//     (SELF_SIGNED_CERT_IN_CHAIN) -- i.e. verification is really enforced.
// The root is valid until 2031-04-26; SUPABASE_ROOT_2021_CA_SHA256 is pinned by a unit test.

export const SUPABASE_ROOT_2021_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`;
export const SUPABASE_ROOT_2021_CA_SHA256 = "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";

// The TRUSTED ROOT SET (every entry pinned by fingerprint in scripts/pg-tls.test.js). SAFE CA ROTATION -- never by
// disabling verification: (1) when Supabase publishes a new root, ADD it here (+ its fingerprint to the test) next to
// the old one, from its official download AND cross-checked against the chain the pooler presents; (2) deploy -- both
// roots now verify; (3) after Supabase switches the pooler chain, confirm `--check-config` / a verified connection
// succeeds against the NEW chain; (4) only then REMOVE the old root in a follow-up release. At no step is
// rejectUnauthorized false, sslmode no-verify, or the hostname check overridden.
export const SUPABASE_PG_TRUSTED_ROOTS = Object.freeze([
  Object.freeze({ name: "Supabase Root 2021 CA", pem: SUPABASE_ROOT_2021_CA_PEM, sha256: SUPABASE_ROOT_2021_CA_SHA256 }),
]);

/** The `ssl` option for a pg Client/Pool: chain verified against the pinned Supabase root(s) + hostname verified. */
export function verifiedPgSsl() {
  const roots = SUPABASE_PG_TRUSTED_ROOTS.map((r) => r.pem);
  return { ca: roots.length === 1 ? roots[0] : roots, rejectUnauthorized: true };
}

/**
 * The connection string with its query removed. TLS is configured ONLY by verifiedPgSsl(): a URL `sslmode=` (the
 * production URL carries sslmode=require, which pg-connection-string would turn into its own ssl object) must never
 * override or weaken it. A malformed URL throws a REDACTED error -- Node's own ERR_INVALID_URL prints the whole value.
 */
export function pgBaseConnectionString(connectionString) {
  let url;
  try { url = new URL(String(connectionString || "")); }
  catch { throw new Error("POSTGRES_URL is not a valid URL (value not printed; check for unencoded / # ? in the password, or stray quotes)"); }
  url.search = "";
  return url.toString();
}

/** A complete verified pg config: `{ connectionString, ssl }` (+ any extra pg options). */
export function verifiedPgConfig(connectionString, extra = {}) {
  return { ...extra, connectionString: pgBaseConnectionString(connectionString), ssl: verifiedPgSsl() };
}
