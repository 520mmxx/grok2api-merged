-- Fix: remove foreign key constraint from proxy_sso_bindings
-- The in-memory proxy pool manages data consistency

DROP TABLE IF EXISTS proxy_sso_bindings;

CREATE TABLE IF NOT EXISTS proxy_sso_bindings (
  sso TEXT PRIMARY KEY,
  proxy_url TEXT NOT NULL,
  bound_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proxy_sso_bindings_url ON proxy_sso_bindings(proxy_url);
