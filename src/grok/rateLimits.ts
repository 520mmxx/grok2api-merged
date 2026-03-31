import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { toRateLimitModel } from "./models";
import { fetchViaSocks5, isSocksProxy } from "../proxy/socks5";

const RATE_LIMIT_API = "https://grok.com/rest/rate-limits";

export async function checkRateLimits(
  cookie: string,
  settings: GrokSettings,
  model: string,
  proxyUrl?: string,
): Promise<Record<string, unknown> | null> {
  const rateModel = toRateLimitModel(model);
  const headers = getDynamicHeaders(settings, "/rest/rate-limits");
  headers.Cookie = cookie;
  const body = JSON.stringify({ requestKind: "DEFAULT", modelName: rateModel });

  const p = proxyUrl ? proxyUrl.trim().replace(/\/+$/, "").replace(/^socks5:\/\//, "socks5h://") : undefined;

  let resp: Response;
  if (p && isSocksProxy(p)) {
    resp = await fetchViaSocks5(p, RATE_LIMIT_API, { method: "POST", headers, body, timeoutMs: 15000 });
  } else if (p && (p.startsWith("http://") || p.startsWith("https://"))) {
    resp = await fetch(p, {
      method: "POST",
      headers: { ...headers, "X-Target-URL": RATE_LIMIT_API },
      body,
    });
  } else {
    resp = await fetch(RATE_LIMIT_API, { method: "POST", headers, body });
  }

  if (!resp.ok) return null;
  return (await resp.json()) as Record<string, unknown>;
}
