/**
 * 代理池管理器 - 完全对齐 grok2api-pro 的 proxy_pool.py
 * 支持多代理URL、SSO绑定、健康检查、失败熔断、Round-Robin调度、D1+KV双持久化
 */
import type { Env } from "../env";
import { dbAll, dbRun } from "../db";
import { nowMs } from "../utils/time";
import { fetchViaSocks5, isSocksProxy } from "./socks5";

const MAX_FAIL_COUNT = 3;
const PROXY_STATE_KV_KEY = "proxy_pool_state";

export interface ProxyInfo {
  url: string;
  healthy: boolean;
  fail_count: number;
  last_used: number;
  assigned_sso: string[];
  total_requests: number;
  success_requests: number;
}

export interface ProxyPoolState {
  proxies: Record<string, ProxyInfo>;
  sso_assignments: Record<string, string>;
  round_robin_index: number;
}

function normalizeProxy(raw: string): string {
  if (!raw) return "";
  let url = raw.trim().replace(/\/+$/, "");
  if (url.startsWith("sock5h://")) url = url.replace("sock5h://", "socks5h://");
  if (url.startsWith("sock5://")) url = url.replace("sock5://", "socks5h://");
  if (url.startsWith("socks5://")) url = url.replace("socks5://", "socks5h://");
  return url;
}

function validateProxy(url: string): boolean {
  if (!url) return false;
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("socks5://") ||
    url.startsWith("socks5h://")
  );
}

export class ProxyPool {
  private env: Env;
  private proxies: Map<string, ProxyInfo> = new Map();
  private sso_assignments: Map<string, string> = new Map();
  private round_robin_index: number = 0;

  constructor(env: Env) {
    this.env = env;
  }

  async init(): Promise<void> {
    const kvState = await this.env.KV_CACHE.get<ProxyPoolState>(PROXY_STATE_KV_KEY, "json");
    if (kvState && kvState.proxies) {
      this.proxies = new Map(Object.entries(kvState.proxies));
      this.sso_assignments = new Map(Object.entries(kvState.sso_assignments || {}));
      this.round_robin_index = kvState.round_robin_index || 0;
      return;
    }
    try {
      const rows = await dbAll<{
        url: string; healthy: number; fail_count: number;
        last_used: number | null; total_requests: number; success_requests: number;
      }>(this.env.DB, "SELECT * FROM proxy_pool");
      const bindings = await dbAll<{ sso: string; proxy_url: string }>(
        this.env.DB, "SELECT sso, proxy_url FROM proxy_sso_bindings"
      );
      for (const r of rows) {
        this.proxies.set(r.url, {
          url: r.url, healthy: Boolean(r.healthy), fail_count: r.fail_count,
          last_used: r.last_used || 0, total_requests: r.total_requests,
          success_requests: r.success_requests, assigned_sso: [],
        });
      }
      for (const b of bindings) {
        this.sso_assignments.set(b.sso, b.proxy_url);
        const p = this.proxies.get(b.proxy_url);
        if (p && !p.assigned_sso.includes(b.sso)) p.assigned_sso.push(b.sso);
      }
    } catch { /* ignore */ }
    await this._persist();
  }

  private async _persist(): Promise<void> {
    const state: ProxyPoolState = {
      proxies: Object.fromEntries(this.proxies),
      sso_assignments: Object.fromEntries(this.sso_assignments),
      round_robin_index: this.round_robin_index,
    };
    await this.env.KV_CACHE.put(PROXY_STATE_KV_KEY, JSON.stringify(state));
  }

  private async _persistD1(p: ProxyInfo): Promise<void> {
    await dbRun(this.env.DB,
      `INSERT INTO proxy_pool(url,healthy,fail_count,last_used,total_requests,success_requests,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET healthy=excluded.healthy,
       fail_count=excluded.fail_count,last_used=excluded.last_used,
       total_requests=excluded.total_requests,success_requests=excluded.success_requests,updated_at=excluded.updated_at`,
      [p.url, p.healthy ? 1 : 0, p.fail_count, p.last_used, p.total_requests, p.success_requests, nowMs(), nowMs()]
    );
  }

  private async _removeD1(url: string): Promise<void> {
    await dbRun(this.env.DB, "DELETE FROM proxy_pool WHERE url = ?", [url]);
  }

  private async _bindD1(sso: string, url: string): Promise<void> {
    await dbRun(this.env.DB,
      `INSERT INTO proxy_sso_bindings(sso,proxy_url,bound_at) VALUES(?,?,?)
       ON CONFLICT(sso) DO UPDATE SET proxy_url=excluded.proxy_url,bound_at=excluded.bound_at`,
      [sso, url, nowMs()]
    );
  }

  private async _unbindD1(sso: string): Promise<void> {
    await dbRun(this.env.DB, "DELETE FROM proxy_sso_bindings WHERE sso = ?", [sso]);
  }

  async addProxy(url: string): Promise<{ success: boolean; message: string }> {
    const n = normalizeProxy(url);
    if (!n || !validateProxy(n)) return { success: false, message: "代理格式无效" };
    if (this.proxies.has(n)) return { success: true, message: "代理已存在" };
    const info: ProxyInfo = { url: n, healthy: true, fail_count: 0, last_used: 0, assigned_sso: [], total_requests: 0, success_requests: 0 };
    this.proxies.set(n, info);
    await this._persistD1(info);
    await this._persist();
    return { success: true, message: "代理添加成功" };
  }

  async removeProxy(url: string): Promise<{ success: boolean; message: string }> {
    const n = normalizeProxy(url);
    const p = this.proxies.get(n);
    if (!p) return { success: false, message: "代理不存在" };
    for (const sso of [...p.assigned_sso]) { this.sso_assignments.delete(sso); await this._unbindD1(sso); }
    this.proxies.delete(n);
    await this._removeD1(n);
    await this._persist();
    return { success: true, message: "代理删除成功" };
  }

  async assignToSso(proxyUrl: string, sso: string): Promise<{ success: boolean; message: string }> {
    const n = normalizeProxy(proxyUrl);
    if (!this.proxies.has(n)) return { success: false, message: "代理不存在" };
    const old = this.sso_assignments.get(sso);
    if (old && this.proxies.has(old)) {
      const o = this.proxies.get(old)!;
      o.assigned_sso = o.assigned_sso.filter((s) => s !== sso);
    }
    this.sso_assignments.set(sso, n);
    const p = this.proxies.get(n)!;
    if (!p.assigned_sso.includes(sso)) p.assigned_sso.push(sso);
    await this._bindD1(sso, n);
    await this._persistD1(p);
    await this._persist();
    return { success: true, message: "绑定成功" };
  }

  async unassignFromSso(sso: string): Promise<{ success: boolean; message: string }> {
    const url = this.sso_assignments.get(sso);
    if (!url) return { success: false, message: "SSO未绑定代理" };
    const p = this.proxies.get(url);
    if (p) { p.assigned_sso = p.assigned_sso.filter((s) => s !== sso); await this._persistD1(p); }
    this.sso_assignments.delete(sso);
    await this._unbindD1(sso);
    await this._persist();
    return { success: true, message: "解绑成功" };
  }

  async getProxyForSso(sso: string): Promise<string | null> {
    if (sso && this.sso_assignments.has(sso)) {
      const url = this.sso_assignments.get(sso)!;
      const p = this.proxies.get(url);
      if (p && p.healthy) return url;
      await this.unassignFromSso(sso);
    }
    const sel = await this._selectRoundRobin();
    if (sso && sel) await this.assignToSso(sel, sso);
    return sel;
  }

  private async _selectRoundRobin(): Promise<string | null> {
    const healthy = [...this.proxies.values()].filter((p) => p.healthy);
    if (!healthy.length) return null;
    this.round_robin_index = this.round_robin_index % healthy.length;
    const sel = healthy[this.round_robin_index]!.url;
    this.round_robin_index++;
    const p = this.proxies.get(sel)!;
    p.last_used = nowMs();
    p.total_requests++;
    await this._persistD1(p);
    await this._persist();
    return sel;
  }

  getRandomProxy(): string | null {
    const h = [...this.proxies.values()].filter((p) => p.healthy);
    if (!h.length) return null;
    return h[Math.floor(Math.random() * h.length)]!.url;
  }

  async forceRefresh(): Promise<string | null> { return await this._selectRoundRobin(); }

  async markFailure(proxyUrl: string): Promise<void> {
    const n = normalizeProxy(proxyUrl);
    const p = this.proxies.get(n);
    if (!p) return;
    p.fail_count++;
    if (p.fail_count >= MAX_FAIL_COUNT) {
      p.healthy = false;
      for (const sso of [...p.assigned_sso]) { this.sso_assignments.delete(sso); await this._unbindD1(sso); }
      p.assigned_sso = [];
    }
    await this._persistD1(p);
    await this._persist();
  }

  async markSuccess(proxyUrl: string): Promise<void> {
    const n = normalizeProxy(proxyUrl);
    const p = this.proxies.get(n);
    if (!p) return;
    p.fail_count = 0;
    p.success_requests++;
    if (!p.healthy) p.healthy = true;
    await this._persistD1(p);
    await this._persist();
  }

  async resetHealth(proxyUrl: string): Promise<void> {
    const n = normalizeProxy(proxyUrl);
    const p = this.proxies.get(n);
    if (!p) return;
    p.fail_count = 0;
    p.healthy = true;
    await this._persistD1(p);
    await this._persist();
  }

  async resetAllHealth(): Promise<void> {
    for (const p of this.proxies.values()) { p.fail_count = 0; p.healthy = true; await this._persistD1(p); }
    await this._persist();
  }

  getAllProxies(): ProxyInfo[] { return [...this.proxies.values()]; }
  getSsoAssignments(): Record<string, string> { return Object.fromEntries(this.sso_assignments); }
  isEnabled(): boolean { return this.proxies.size > 0; }

  async testProxy(url: string): Promise<{ success: boolean; message: string; status_code?: number; response_time?: number }> {
    const n = normalizeProxy(url);
    const start = Date.now();
    // Use httpbin.org for testing (doesn't block proxy IPs like Cloudflare does)
    const testUrl = "https://httpbin.org/get";

    try {
      if (isSocksProxy(n)) {
        // SOCKS5: test via connect() + SOCKS5 handshake
        try {
          const resp = await fetchViaSocks5(n, testUrl, {
            method: "GET",
            headers: { "User-Agent": "Mozilla/5.0" },
            timeoutMs: 15000,
          });
          const elapsed = Math.round((Date.now() - start) / 10) / 100;
          if (resp.status >= 200 && resp.status < 500) {
            return {
              success: true,
              message: resp.status === 403
                ? "代理连通正常（403表示目标站点拦截，但代理可用）"
                : `代理连通正常 (HTTP ${resp.status})`,
              status_code: resp.status,
              response_time: elapsed,
            };
          }
          return { success: false, message: `代理返回异常状态码: ${resp.status}`, status_code: resp.status, response_time: elapsed };
        } catch (socksErr: any) {
          const elapsed = Math.round((Date.now() - start) / 10) / 100;
          const msg = String(socksErr?.message || socksErr);
          if (msg.includes("timeout")) return { success: false, message: "代理连接超时", response_time: elapsed };
          if (msg.includes("auth failed")) return { success: false, message: "代理认证失败（用户名/密码错误）", response_time: elapsed };
          if (msg.includes("refused")) return { success: false, message: "代理连接被拒绝", response_time: elapsed };
          if (msg.includes("unreachable")) return { success: false, message: "代理地址不可达", response_time: elapsed };
          if (msg.includes("TLS")) return { success: true, message: `代理握手成功，但TLS升级失败（代理本身可用）: ${msg}`, response_time: elapsed };
          return { success: false, message: `代理连接失败: ${msg}`, response_time: elapsed };
        }
      } else if (n.startsWith("http://") || n.startsWith("https://")) {
        // HTTP proxy: test basic connectivity
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        try {
          const resp = await fetch(n, { method: "HEAD", signal: ctrl.signal });
          clearTimeout(t);
          const elapsed = Math.round((Date.now() - start) / 10) / 100;
          return { success: true, message: `代理可连接 (HTTP ${resp.status})`, status_code: resp.status, response_time: elapsed };
        } catch (e: any) {
          clearTimeout(t);
          const elapsed = Math.round((Date.now() - start) / 10) / 100;
          return { success: false, message: `代理连接失败: ${e?.message || e}`, response_time: elapsed };
        }
      }
      return { success: false, message: "不支持的代理类型" };
    } catch (e: any) {
      const elapsed = Math.round((Date.now() - start) / 10) / 100;
      return { success: false, message: `代理测试异常: ${e?.message || e}`, response_time: elapsed };
    }
  }

  async clearAll(): Promise<void> {
    await dbRun(this.env.DB, "DELETE FROM proxy_sso_bindings", []);
    await dbRun(this.env.DB, "DELETE FROM proxy_pool", []);
    await this.env.KV_CACHE.delete(PROXY_STATE_KV_KEY);
    this.proxies.clear();
    this.sso_assignments.clear();
    this.round_robin_index = 0;
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

export function resetProxyPoolInstance(): void {
  _poolInstance = null;
}
