import type { Env } from "../env";
import { dbAll, dbFirst, dbRun } from "../db";
import { nowMs } from "../utils/time";

const MAX_FAIL_COUNT = 3;
const PROXY_STATE_KV_KEY = "proxy_pool_state";

export interface ProxyInfo {
  url: string;
  healthy: boolean;
  fail_count: number;
  last_used: number | null;
  total_requests: number;
  success_requests: number;
  assigned_sso: string[];
}

export interface ProxyPoolState {
  proxies: Record<string, ProxyInfo>;
  sso_assignments: Record<string, string>; // sso -> proxy_url
  round_robin_index: number;
  enabled: boolean;
}

function normalizeProxyUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return "";
  // Normalize socks5 -> socks5h (DNS via proxy)
  if (url.startsWith("socks5://")) url = "socks5h://" + url.slice("socks5://".length);
  if (url.startsWith("sock5://")) url = "socks5h://" + url.slice("sock5://".length);
  if (url.startsWith("sock5h://")) url = "socks5h://" + url.slice("sock5h://".length);
  // Remove trailing slash
  url = url.replace(/\/+$/, "");
  return url;
}

function validateProxyUrl(url: string): boolean {
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("socks5://") ||
    url.startsWith("socks5h://")
  );
}

export class ProxyPool {
  private env: Env;
  private state: ProxyPoolState;

  constructor(env: Env) {
    this.env = env;
    this.state = {
      proxies: {},
      sso_assignments: {},
      round_robin_index: 0,
      enabled: false,
    };
  }

  async init(): Promise<void> {
    // Try loading from KV first (faster)
    const kvState = await this.env.KV_CACHE.get<ProxyPoolState>(PROXY_STATE_KV_KEY, "json");
    if (kvState && kvState.proxies) {
      this.state = kvState;
      return;
    }

    // Fallback: load from D1
    const rows = await dbAll<{
      url: string;
      healthy: number;
      fail_count: number;
      last_used: number | null;
      total_requests: number;
      success_requests: number;
    }>(this.env.DB, "SELECT * FROM proxy_pool");

    const bindingRows = await dbAll<{ sso: string; proxy_url: string }>(
      this.env.DB,
      "SELECT sso, proxy_url FROM proxy_sso_bindings",
    );

    const proxies: Record<string, ProxyInfo> = {};
    for (const r of rows) {
      proxies[r.url] = {
        url: r.url,
        healthy: Boolean(r.healthy),
        fail_count: r.fail_count,
        last_used: r.last_used,
        total_requests: r.total_requests,
        success_requests: r.success_requests,
        assigned_sso: [],
      };
    }

    const sso_assignments: Record<string, string> = {};
    for (const b of bindingRows) {
      sso_assignments[b.sso] = b.proxy_url;
      if (proxies[b.proxy_url]) {
        proxies[b.proxy_url]!.assigned_sso.push(b.sso);
      }
    }

    this.state = {
      proxies,
      sso_assignments,
      round_robin_index: 0,
      enabled: Object.keys(proxies).length > 0,
    };

    // Save to KV for fast access
    await this.persist();
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  getProxies(): ProxyInfo[] {
    return Object.values(this.state.proxies);
  }

  getSsoAssignments(): Record<string, string> {
    return { ...this.state.sso_assignments };
  }

  private async persist(): Promise<void> {
    await this.env.KV_CACHE.put(PROXY_STATE_KV_KEY, JSON.stringify(this.state));
  }

  private async persistToD1(proxy: ProxyInfo): Promise<void> {
    await dbRun(
      this.env.DB,
      `INSERT INTO proxy_pool(url, healthy, fail_count, last_used, total_requests, success_requests, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(url) DO UPDATE SET healthy=excluded.healthy, fail_count=excluded.fail_count,
       last_used=excluded.last_used, total_requests=excluded.total_requests,
       success_requests=excluded.success_requests, updated_at=excluded.updated_at`,
      [
        proxy.url,
        proxy.healthy ? 1 : 0,
        proxy.fail_count,
        proxy.last_used,
        proxy.total_requests,
        proxy.success_requests,
        nowMs(),
        nowMs(),
      ],
    );
  }

  private async removeD1Binding(sso: string): Promise<void> {
    await dbRun(this.env.DB, "DELETE FROM proxy_sso_bindings WHERE sso = ?", [sso]);
  }

  private async addD1Binding(sso: string, proxyUrl: string): Promise<void> {
    await dbRun(
      this.env.DB,
      `INSERT INTO proxy_sso_bindings(sso, proxy_url, bound_at) VALUES(?,?,?)
       ON CONFLICT(sso) DO UPDATE SET proxy_url=excluded.proxy_url, bound_at=excluded.bound_at`,
      [sso, proxyUrl, nowMs()],
    );
  }

  async addProxy(url: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = normalizeProxyUrl(url);
    if (!normalized) return { ok: false, error: "Empty proxy URL" };
    if (!validateProxyUrl(normalized)) {
      return { ok: false, error: "Invalid proxy scheme (use http/https/socks5/socks5h)" };
    }
    if (this.state.proxies[normalized]) {
      return { ok: false, error: "Proxy already exists" };
    }

    const proxy: ProxyInfo = {
      url: normalized,
      healthy: true,
      fail_count: 0,
      last_used: null,
      total_requests: 0,
      success_requests: 0,
      assigned_sso: [],
    };

    this.state.proxies[normalized] = proxy;
    this.state.enabled = true;
    await this.persistToD1(proxy);
    await this.persist();
    return { ok: true };
  }

  async removeProxy(url: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = normalizeProxyUrl(url);
    if (!normalized || !this.state.proxies[normalized]) {
      return { ok: false, error: "Proxy not found" };
    }

    // Unbind all SSOs from this proxy
    const proxy = this.state.proxies[normalized]!;
    for (const sso of [...proxy.assigned_sso]) {
      delete this.state.sso_assignments[sso];
      await this.removeD1Binding(sso);
    }

    delete this.state.proxies[normalized];
    await dbRun(this.env.DB, "DELETE FROM proxy_pool WHERE url = ?", [normalized]);
    await this.persist();

    if (Object.keys(this.state.proxies).length === 0) {
      this.state.enabled = false;
    }
    return { ok: true };
  }

  async assignToSso(sso: string, proxyUrl: string): Promise<{ ok: boolean; error?: string }> {
    const normalized = normalizeProxyUrl(proxyUrl);
    if (!normalized || !this.state.proxies[normalized]) {
      return { ok: false, error: "Proxy not found" };
    }

    // Remove old binding if exists
    const oldProxy = this.state.sso_assignments[sso];
    if (oldProxy && this.state.proxies[oldProxy]) {
      const oldInfo = this.state.proxies[oldProxy]!;
      oldInfo.assigned_sso = oldInfo.assigned_sso.filter((s) => s !== sso);
    }

    // Create new binding
    this.state.sso_assignments[sso] = normalized;
    this.state.proxies[normalized]!.assigned_sso.push(sso);
    await this.addD1Binding(sso, normalized);
    await this.persist();
    return { ok: true };
  }

  async unassignFromSso(sso: string): Promise<void> {
    const proxyUrl = this.state.sso_assignments[sso];
    if (proxyUrl && this.state.proxies[proxyUrl]) {
      const proxy = this.state.proxies[proxyUrl]!;
      proxy.assigned_sso = proxy.assigned_sso.filter((s) => s !== sso);
    }
    delete this.state.sso_assignments[sso];
    await this.removeD1Binding(sso);
    await this.persist();
  }

  private getHealthyProxies(): ProxyInfo[] {
    return Object.values(this.state.proxies).filter((p) => p.healthy);
  }

  private selectRoundRobin(): string | null {
    const healthy = this.getHealthyProxies();
    if (!healthy.length) return null;
    this.state.round_robin_index = (this.state.round_robin_index + 1) % healthy.length;
    return healthy[this.state.round_robin_index]!.url;
  }

  getProxyForSso(sso: string): string | null {
    if (!this.state.enabled) return null;

    const bound = this.state.sso_assignments[sso];
    if (bound && this.state.proxies[bound]?.healthy) {
      return bound;
    }

    // Unbind if unhealthy
    if (bound && this.state.proxies[bound] && !this.state.proxies[bound]!.healthy) {
      delete this.state.sso_assignments[sso];
      this.state.proxies[bound]!.assigned_sso = this.state.proxies[bound]!.assigned_sso.filter(
        (s) => s !== sso,
      );
      void this.removeD1Binding(sso);
    }

    // Auto-assign via round-robin
    const selected = this.selectRoundRobin();
    if (selected) {
      this.state.sso_assignments[sso] = selected;
      this.state.proxies[selected]!.assigned_sso.push(sso);
      void this.addD1Binding(sso, selected);
      void this.persist();
      return selected;
    }

    return null;
  }

  getRandomProxy(): string | null {
    if (!this.state.enabled) return null;
    const healthy = this.getHealthyProxies();
    if (!healthy.length) return null;
    const idx = Math.floor(Math.random() * healthy.length);
    return healthy[idx]!.url;
  }

  async markSuccess(proxyUrl: string): Promise<void> {
    const proxy = this.state.proxies[proxyUrl];
    if (!proxy) return;
    proxy.fail_count = 0;
    proxy.success_requests += 1;
    proxy.total_requests += 1;
    proxy.last_used = nowMs();
    if (!proxy.healthy) {
      proxy.healthy = true;
    }
    await this.persistToD1(proxy);
    await this.persist();
  }

  async markFailure(proxyUrl: string): Promise<void> {
    const proxy = this.state.proxies[proxyUrl];
    if (!proxy) return;
    proxy.fail_count += 1;
    proxy.total_requests += 1;
    proxy.last_used = nowMs();

    if (proxy.fail_count >= MAX_FAIL_COUNT) {
      proxy.healthy = false;
      // Unbind all SSOs from this proxy
      for (const sso of [...proxy.assigned_sso]) {
        delete this.state.sso_assignments[sso];
        await this.removeD1Binding(sso);
      }
      proxy.assigned_sso = [];
    }

    await this.persistToD1(proxy);
    await this.persist();
  }

  async forceRefresh(): Promise<string | null> {
    // Try to get a new random proxy from healthy pool
    const proxy = this.selectRoundRobin();
    if (proxy) return proxy;

    // If no healthy proxies, try to restore all to healthy
    for (const p of Object.values(this.state.proxies)) {
      p.healthy = true;
      p.fail_count = 0;
      await this.persistToD1(p);
    }
    await this.persist();
    return this.selectRoundRobin();
  }

  async resetHealth(): Promise<void> {
    for (const proxy of Object.values(this.state.proxies)) {
      proxy.healthy = true;
      proxy.fail_count = 0;
      await this.persistToD1(proxy);
    }
    await this.persist();
  }

  async clearAll(): Promise<void> {
    await dbRun(this.env.DB, "DELETE FROM proxy_sso_bindings", []);
    await dbRun(this.env.DB, "DELETE FROM proxy_pool", []);
    await this.env.KV_CACHE.delete(PROXY_STATE_KV_KEY);
    this.state = {
      proxies: {},
      sso_assignments: {},
      round_robin_index: 0,
      enabled: false,
    };
  }
}

let _poolInstance: ProxyPool | null = null;

export async function getProxyPool(env: Env): Promise<ProxyPool> {
  if (!_poolInstance) {
    _poolInstance = new ProxyPool(env);
    await _poolInstance.init();
  }
  return _poolInstance;
}

// For testing/reset purposes
export function resetProxyPoolInstance(): void {
  _poolInstance = null;
}
