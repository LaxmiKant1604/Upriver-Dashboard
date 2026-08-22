// Seller/vendor ID batching for DataDoe exports.
//
// A dependency-free LEAF module so the live transport (lib/server/datadoe.js) and
// the scheduler's request resolver (lib/server/sync/report-source-contracts.js)
// chunk account IDs with EXACTLY the same implementation, without the resolver
// importing the DataDoe/report module graph.
//
// DataDoe accepts at most 5 seller/vendor IDs per export, so a source request over
// N accounts becomes one export per 5-ID chunk. Chunks follow the GIVEN input order
// (chunk boundaries depend on input order); the canonical identity sorts the IDs
// WITHIN a chunk, so reordering IDs inside one chunk does not change its request
// hash, but moving an ID across a chunk boundary does.

export const MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT = 5;

export function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// The canonical account-ID chunking every source export uses.
export function chunkAccountIds(sellerOrVendorIds) {
  const scope = Array.isArray(sellerOrVendorIds)
    ? sellerOrVendorIds
    : sellerOrVendorIds == null
      ? []
      : [sellerOrVendorIds];
  return chunkArray(scope, MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT);
}
