import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { toRateLimitModel } from "./models";

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

  let targetUrl = RATE_LIMIT_API;
  if (proxyUrl) {
    const p = proxyUrl.replace(/\/+$/, "");
    const proxyUrlObj = new URL(p);
    if (proxyUrlObj.pathname !== "/" && proxyUrlObj.pathname !== "") {
      targetUrl = `${p}?url=${encodeURIComponent(RATE_LIMIT_API)}`;
    } else {
      const t = new URL(RATE_LIMIT_API);
      t.hostname = proxyUrlObj.hostname;
      t.port = proxyUrlObj.port;
      t.protocol = proxyUrlObj.protocol;
      targetUrl = t.toString();
    }
  }

  const resp = await fetch(targetUrl, { method: "POST", headers, body });
  if (!resp.ok) return null;
  return (await resp.json()) as Record<string, unknown>;
}

