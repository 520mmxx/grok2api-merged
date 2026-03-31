/**
 * SOCKS5 proxy client for Cloudflare Workers
 * Uses the connect() API from cloudflare:sockets to establish TCP tunnels.
 */
import { connect } from "cloudflare:sockets";

interface Socks5Target {
  host: string;
  port: number;
  username: string | undefined;
  password: string | undefined;
}

function parseProxyUrl(url: string): Socks5Target | null {
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return {
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 1080,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return null;
  }
}

function isIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

function ipToBytes(host: string): Uint8Array {
  return new Uint8Array(host.split(".").map(Number));
}

function writeUint16BE(val: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = (val >> 8) & 0xff;
  buf[1] = val & 0xff;
  return buf;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < n) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`SOCKS5: connection closed, expected ${n} bytes, got ${received}`);
    chunks.push(value);
    received += value.length;
  }
  const all = concatBytes(...chunks);
  if (all.length > n) return all.slice(0, n);
  return all;
}

async function socks5Handshake(
  conn: Socket,
  targetHost: string,
  targetPort: number,
  auth?: { username: string; password: string },
): Promise<void> {
  const reader = conn.readable.getReader();
  const writer = conn.writable.getWriter();

  try {
    // Step 1: Send greeting
    const methods = auth ? new Uint8Array([0x05, 0x02, 0x00, 0x02]) : new Uint8Array([0x05, 0x01, 0x00]);
    await writer.write(methods);

    // Step 2: Read server's method choice
    const methodResp = await readExactly(reader, 2);
    if (methodResp[0] !== 0x05) throw new Error("SOCKS5: invalid server response");
    if (methodResp[1] === 0xff) throw new Error("SOCKS5: no acceptable auth method");

    // Step 3: Username/password auth if required
    if (methodResp[1] === 0x02 && auth) {
      const uBytes = new TextEncoder().encode(auth.username);
      const pBytes = new TextEncoder().encode(auth.password);
      if (uBytes.length > 255 || pBytes.length > 255)
        throw new Error("SOCKS5: username/password too long");

      const authReq = concatBytes(new Uint8Array([0x01, uBytes.length]), uBytes, new Uint8Array([pBytes.length]), pBytes);
      await writer.write(authReq);

      const authResp = await readExactly(reader, 2);
      if (authResp[1] !== 0x00) throw new Error("SOCKS5: auth failed");
    }

    // Step 4: Send CONNECT request
    let addrType: number;
    let addrData: Uint8Array;
    if (isIPv4(targetHost)) {
      addrType = 0x01;
      addrData = ipToBytes(targetHost);
    } else {
      addrType = 0x03;
      const hostBytes = new TextEncoder().encode(targetHost);
      if (hostBytes.length > 255) throw new Error("SOCKS5: hostname too long");
      addrData = concatBytes(new Uint8Array([hostBytes.length]), hostBytes);
    }

    const connectReq = concatBytes(
      new Uint8Array([0x05, 0x01, 0x00, addrType]),
      addrData,
      writeUint16BE(targetPort),
    );
    await writer.write(connectReq);

    // Step 5: Read connect response
    const connectResp = await readExactly(reader, 4);
    if (connectResp[0] !== 0x05) throw new Error("SOCKS5: invalid response version");
    if (connectResp[1] !== 0x00) {
      const codes: Record<number, string> = {
        0x01: "general failure",
        0x02: "connection not allowed",
        0x03: "network unreachable",
        0x04: "host unreachable",
        0x05: "connection refused",
        0x06: "TTL expired",
        0x07: "command not supported",
        0x08: "address type not supported",
      };
      throw new Error(`SOCKS5 connect failed: ${codes[connectResp[1]!] ?? `code ${connectResp[1]}`}`);
    }

    // Read bound address (we don't need it, just consume the bytes)
    const atyp = connectResp[3];
    if (atyp === 0x01) await readExactly(reader, 4 + 2); // IPv4 + port
    else if (atyp === 0x03) {
      const lenByte = await readExactly(reader, 1);
      const lenVal = lenByte[0] ?? 0;
      await readExactly(reader, lenVal + 2); // domain + port
    } else if (atyp === 0x04) await readExactly(reader, 16 + 2); // IPv6 + port
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

/**
 * Build an HTTP/1.1 request bytes from method, headers, and body.
 */
function buildHttpRequest(
  method: string,
  targetUrl: string,
  headers: Record<string, string>,
  body?: string | null,
): Uint8Array<ArrayBuffer> {
  const url = new URL(targetUrl);
  const path = url.pathname + url.search;
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${url.host}`];

  const h = { ...headers };
  // Remove hop-by-hop headers
  delete h["host"];
  delete h["connection"];
  delete h["transfer-encoding"];
  for (const [k, v] of Object.entries(h)) {
    if (v) lines.push(`${k}: ${v}`);
  }

  const bodyBytes = body ? new TextEncoder().encode(body) : new Uint8Array(0);
  if (bodyBytes.length > 0) {
    lines.push(`Content-Length: ${bodyBytes.length}`);
  }
  lines.push("Connection: close");
  lines.push("");

  const headStr = lines.join("\r\n") + "\r\n";
  const headBytes = new TextEncoder().encode(headStr);

  return concatBytes(headBytes, bodyBytes);
}

/**
 * Read and parse an HTTP/1.1 response from a TCP reader.
 * Returns headers + a ReadableStream for the body.
 */
async function readHttpResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyStream: ReadableStream<Uint8Array>;
}> {
  // Read until we have the complete headers
  const headerChunks: Uint8Array[] = [];
  let headerBuf = new Uint8Array(0);
  let headerEndIdx = -1;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    headerChunks.push(value);
    headerBuf = concatBytes(...headerChunks);
    const headerText = new TextDecoder().decode(headerBuf);
    headerEndIdx = headerText.indexOf("\r\n\r\n");
    if (headerEndIdx !== -1) break;
  }

  if (headerEndIdx === -1) throw new Error("SOCKS5: incomplete HTTP response headers");

  const headerText = new TextDecoder().decode(headerBuf);
  const headerSection = headerText.slice(0, headerEndIdx);
  const headerLines = headerSection.split("\r\n");
  const statusLine = headerLines[0] ?? "";
  const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)\s*(.*)$/);
  if (!statusMatch) throw new Error(`SOCKS5: invalid HTTP status line: ${statusLine}`);

  const status = parseInt(statusMatch[1]!, 10);
  const statusText = statusMatch[2] ?? "";
  const headers: Record<string, string> = {};
  for (let i = 1; i < headerLines.length; i++) {
    const colonIdx = headerLines[i]!.indexOf(":");
    if (colonIdx > 0) {
      const key = headerLines[i]!.slice(0, colonIdx).trim().toLowerCase();
      const val = headerLines[i]!.slice(colonIdx + 1).trim();
      headers[key] = val;
    }
  }

  // Body bytes already received after headers
  const bodyStart = headerEndIdx + 4;
  const initialBody = headerBuf.slice(bodyStart);

  // Create a ReadableStream from the remaining data + reader
  const bodyStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (initialBody.length > 0) controller.enqueue(initialBody);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        // ignore errors during body reading
      } finally {
        controller.close();
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
    },
  });

  return { status, statusText, headers, bodyStream };
}

/**
 * Fetch through a SOCKS5 proxy using connect() API.
 * Returns a Response object compatible with the standard fetch API.
 */
export async function fetchViaSocks5(
  proxyUrl: string,
  targetUrl: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<Response> {
  const proxy = parseProxyUrl(proxyUrl);
  if (!proxy) throw new Error(`Invalid SOCKS5 proxy URL: ${proxyUrl}`);

  const target = new URL(targetUrl);
  const targetHost = target.hostname;
  const targetPort = target.protocol === "https:" ? 443 : parseInt(target.port || "80", 10);
  const useTLS = target.protocol === "https:";

  const timeoutMs = options.timeoutMs ?? 30000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Connect to SOCKS5 proxy
    const conn: Socket = connect(
      { hostname: proxy.host, port: proxy.port },
      { secureTransport: "off", allowHalfOpen: false },
    );

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        conn.close();
        controller.abort();
      });
    }

    // SOCKS5 handshake
    await socks5Handshake(conn, targetHost, targetPort, proxy.username && proxy.password
      ? { username: proxy.username, password: proxy.password }
      : undefined,
    );

    // If HTTPS, upgrade to TLS
    let stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
    if (useTLS) {
      const tlsConn: Socket = conn.startTls({ expectedServerHostname: targetHost });
      stream = { readable: tlsConn.readable, writable: tlsConn.writable };
    } else {
      stream = { readable: conn.readable, writable: conn.writable };
    }

    // Build and send HTTP request
    const method = options.method ?? "GET";
    const requestBytes = buildHttpRequest(method, targetUrl, options.headers ?? {}, options.body);

    const writer = stream.writable.getWriter();
    await writer.write(requestBytes);
    writer.releaseLock();

    // Read response
    const reader = stream.readable.getReader();
    const resp = await readHttpResponse(reader);

    clearTimeout(timeout);

    return new Response(resp.bodyStream, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

export function isSocksProxy(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("socks5://") || url.startsWith("socks5h://");
}

export function isHttpProxy(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}
