-- Proxy pool table for IP address proxy management
-- Port from grok2api-pro proxy_pool.py to Cloudflare Workers D1

CREATE TABLE IF NOT EXISTS proxy_pool (
  url TEXT PRIMARY KEY,
  healthy INTEGER NOT NULL DEFAULT 1,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER,
  total_requests INTEGER NOT NULL DEFAULT 0,
  success_requests INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proxy_pool_healthy ON proxy_pool(healthy);

CREATE TABLE IF NOT EXISTS proxy_sso_bindings (
  sso TEXT PRIMARY KEY,
  proxy_url TEXT NOT NULL,
  bound_at INTEGER NOT NULL,
  FOREIGN KEY (proxy_url) REFERENCES proxy_pool(url) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_proxy_sso_bindings_url ON proxy_sso_bindings(proxy_url);
