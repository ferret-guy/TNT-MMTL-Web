#ifndef NMMTL_INTERVAL_CACHE_H
#define NMMTL_INTERVAL_CACHE_H
// Scope the thread-local cache to one assembly partition. Clearing both ends
// prevents reuse after geometry/edge exponents change or element addresses recur.
void nmmtl_interval_cache_begin();
void nmmtl_interval_cache_end();
struct NmmtlIntervalCacheScope {
  NmmtlIntervalCacheScope() { nmmtl_interval_cache_begin(); }
  ~NmmtlIntervalCacheScope() { nmmtl_interval_cache_end(); }
  NmmtlIntervalCacheScope(const NmmtlIntervalCacheScope &) = delete;
  NmmtlIntervalCacheScope &operator=(const NmmtlIntervalCacheScope &) = delete;
};
#endif
