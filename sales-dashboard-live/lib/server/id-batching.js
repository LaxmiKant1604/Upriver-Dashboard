// Seller/vendor ID batching for DataDoe exports.
//
// A dependency-free LEAF module so the live transport (lib/server/datadoe.js) and
// the scheduler's request resolver (lib/server/sync/report-source-contracts.js)
// chunk account IDs with EXACTLY the same implementation, without the resolver
// importing the DataDoe/report module graph.
//
// DataDoe confirmed IN WRITING that ANY number of sellerOrVendorIds may be included in one export, and that
// sellers from multiple marketplaces may be combined safely. The only hard limit is 5,000,000 ROWS per export
// (a separate per-source truncation concern, enforced by each source's row cap -- NOT a seller-count limit). So
// a source request over N accounts becomes ONE canonical export over all N sorted seller ids (the identity
// sorts the ids, so input order never changes the request hash). [Superseded: the former 5-seller cap.]
export const MAX_SELLER_OR_VENDOR_IDS_PER_EXPORT = Number.MAX_SAFE_INTEGER; // effectively unlimited (no seller cap)

export function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// The canonical account-ID chunking every source export uses: ONE chunk over all sellers (any number allowed).
export function chunkAccountIds(sellerOrVendorIds) {
  const scope = Array.isArray(sellerOrVendorIds)
    ? sellerOrVendorIds
    : sellerOrVendorIds == null
      ? []
      : [sellerOrVendorIds];
  return scope.length ? [scope] : [];
}
