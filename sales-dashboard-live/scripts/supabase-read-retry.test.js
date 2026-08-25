import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

const calls = [];
let queue = [];
const response = ({ status, body }) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), method: String(options.method || "GET").toUpperCase() });
  const next = queue.shift();
  if (!next) throw new Error("unexpected fetch");
  if (next.error) throw next.error;
  return response(next);
};

const { getAsinAdsDailyRows, recordSourceCoverageWindows } = await import("../lib/server/supabase.js");

queue = [
  { status: 503, body: { message: "temporary" } },
  { status: 200, body: [] },
];
const rows = await getAsinAdsDailyRows("A1", "2026-08-01", "2026-08-24");
assert.deepEqual(rows, []);
assert.deepEqual(calls.map((c) => c.method), ["GET", "GET"], "the failed GET page retries in place");

calls.length = 0;
queue = [
  { error: Object.assign(new Error("read reset"), { code: "ECONNRESET" }) },
  { status: 200, body: [] },
];
assert.deepEqual(await getAsinAdsDailyRows("A1", "2026-08-01", "2026-08-24"), []);
assert.equal(calls.length, 2, "a network-reset GET retries in place");

calls.length = 0;
queue = [
  { status: 503, body: { message: "write uncertain" } },
  { status: 200, body: null },
];
const write = await recordSourceCoverageWindows([{
  organizationFingerprint: "org",
  accountId: "A1",
  sourceKey: "order-line-items",
  coveredFrom: "2026-08-01",
  coveredTo: "2026-08-24",
}]);
assert.equal(write.write, "write-failed");
assert.deepEqual(calls.map((c) => c.method), ["POST"], "mutating writes remain single-attempt");

console.log("3 assertions passed");
