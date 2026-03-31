export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  KV_CACHE: KVNamespace;

  // Optional vars via wrangler.toml [vars]
  // Cache reset time zone offset minutes (default Asia/Shanghai = 480)
  CACHE_RESET_TZ_OFFSET_MINUTES?: string;

  // Build info (injected by CI)
  BUILD_SHA?: string;

  // Max object size to store into KV (Workers KV has per-value limits; default 25MB)
  KV_CACHE_MAX_BYTES?: string;

  // Batch size for daily cleanup
  KV_CLEANUP_BATCH?: string;

  // Proxy pool: comma-separated proxy URLs for quick bootstrap
  PROXY_URLS?: string;

  // Proxy pool: external pool API URL for dynamic proxy fetching
  PROXY_POOL_URL?: string;

  // Proxy pool: refresh interval in seconds for dynamic pool (default 300)
  PROXY_POOL_INTERVAL?: string;
}
