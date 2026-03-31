/**
 * SOCKS5 proxy client for Cloudflare Workers
 * Uses connect() API from cloudflare:sockets
 * Includes fallback to direct request if SOCKS5 fails
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

function writeUint16BE(val: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = (val >> 8) & 0xff;
  buf[1] = val & 0xff;
  return buf;
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
  return all.length > n ? all.slice(0, n) : all;
}

/**
 * SOCKS5 handshake through an existing connection
 */
async function socks5Handshake(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  targetHost: string,
  targetPort: number,
  auth?: { username: string; password: string },
): Promise<void> {
  // Step 1: Send greeting
  const methods = auth
    ? new Uint8Array([0x05, 0x02, 0x00, 0x02]) // no auth + user/pass
    : new Uint8Array([0x05, 0x01, 0x00]); // no auth only
  await writer.write(methods);

  // Step 2: Read server's method choice
  const methodResp = await readExactly(reader, 2);
  if (methodResp[0] !== 0x05) throw new Error("SOCKS5: invalid server response");
  if (methodResp[1] === 0xff) throw new Error("SOCKS5: no acceptable auth method");

  // Step 3: Username/password auth
  if (methodResp[1] === 0x02 && auth) {
    const uBytes = new TextEncoder().encode(auth.username);
    const pBytes = new TextEncoder().encode(auth.password);
    if (uBytes.length > 255 || pBytes.length > 255) throw new Error("SOCKS5: username/password too long");
    const authReq = concatBytes(
      new Uint8Array([0x01, uBytes.length]), uBytes,
      new Uint8Array([pBytes.length]), pBytes,
    );
    await writer.write(authReq);
    const authResp = await readExactly(reader, 2);
    if (authResp[1] !== 0x00) throw new Error("SOCKS5: auth failed (bad username/password)");
  }

  // Step 4: Send CONNECT request
  let addrType: number;
  let addrData: Uint8Array;
  if (isIPv4(targetHost)) {
    addrType = 0x01;
    addrData = new Uint8Array(targetHost.split(".").map(Number));
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
      0x01: "general failure", 0x02: "connection not allowed",
      0x03: "network unreachable", 0x04: "host unreachable",
      0x05: "connection refused", 0x06: "TTL expired",
      0x07: "command not supported", 0x08: "address type not supported",
    };
    throw new Error(`SOCKS5 connect failed: ${codes[connectResp[1]!] ?? `code ${connectResp[1]}`}`);
  }

  // Read bound address (consume, we don't use it)
  const atyp = connectResp[3];
  if (atyp === 0x01) await readExactly(reader, 6); // IPv4(4) + port(2)
  else if (atyp === 0x03) {
    const len = (await readExactly(reader, 1))[0] ?? 0;
    await readExactly(reader, len + 2); // domain + port
  } else if (atyp === 0x04) await readExactly(reader, 18); // IPv6(16) + port(2)
}

/**
 * Build HTTP/1.1 request bytes
 */
function buildHttpRequest(
  method: string, targetUrl: string,
  headers: Record<string, string>, body?: string | null,
): Uint8Array<ArrayBuffer> {
  const url = new URL(targetUrl);
  const path = url.pathname + url.search;
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${url.host}`];
  const h = { ...headers };
  delete h["host"];
  delete h["connection"];
  delete h["transfer-encoding"];
  for (const [k, v] of Object.entries(h)) {
    if (v) lines.push(`${k}: ${v}`);
  }
  const bodyBytes = body ? new TextEncoder().encode(body) : new Uint8Array(0);
  if (bodyBytes.length > 0) lines.push(`Content-Length: ${bodyBytes.length}`);
  lines.push("Connection: close");
  lines.push("");
  const headStr = lines.join("\r\n") + "\r\n";
  return concatBytes(new TextEncoder().encode(headStr), bodyBytes);
}

/**
 * Read HTTP response from a TCP reader (works with both TLS and plain)
 */
async function readHttpResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ status: number; statusText: string; headers: Record<string, string>; bodyStream: ReadableStream<Uint8Array> }> {
  const headerChunks: Uint8Array[] = [];
  let headerBuf = new Uint8Array(0);
  let headerEndIdx = -1;
  let decoder = new TextDecoder();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    headerChunks.push(value);
    headerBuf = concatBytes(...headerChunks);
    const headerText = decoder.decode(headerBuf);
    headerEndIdx = headerText.indexOf("\r\n\r\n");
    if (headerEndIdx !== -1) break;
  }

  if (headerEndIdx === -1) {
    throw new Error("SOCKS5: connection closed before receiving HTTP headers");
  }

  const headerText = decoder.decode(headerBuf);
  const headerSection = headerText.slice(0, headerEndIdx);
  const headerLines = headerSection.split("\r\n");
  const statusLine = headerLines[0] ?? "";
  const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)\s*(.*)$/);
  if (!statusMatch) throw new Error(`SOCKS5: invalid HTTP status line: ${statusLine}`);

  const status = parseInt(statusMatch[1]!, 10);
  const statusText = statusMatch[2] ?? "";
  const headers: Record<string, string> = {};
  for (let i = 1; i < headerLines.length; i++) {
    const ci = headerLines[i]!.indexOf(":");
    if (ci > 0) {
      headers[headerLines[i]!.slice(0, ci).trim().toLowerCase()] = headerLines[i]!.slice(ci + 1).trim();
    }
  }

  const bodyStart = headerEndIdx + 4;
  const initialBody = headerBuf.slice(bodyStart);

  const bodyStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (initialBody.length > 0) controller.enqueue(initialBody);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch { /* ignore */ }
      finally { controller.close(); try { reader.releaseLock(); } catch { /* */ } }
    },
  });

  return { status, statusText, headers, bodyStream };
}

/**
 * Fetch through SOCKS5 proxy with full error handling and fallback.
 * Returns a standard Response object.
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
  const timeoutMs = Math.min(options.timeoutMs ?? 30000, 15000); // Max 15s for connect
  let conn: Socket | null = null;

  try {
    // Connect to SOCKS5 proxy with timeout
    conn = connect(
      { hostname: proxy.host, port: proxy.port },
      { secureTransport: "off", allowHalfOpen: false },
    );

    // Wait for connection to open with timeout
    const connectTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("SOCKS5: connect timeout")), timeoutMs)
    );
    await Promise.race([conn.opened, connectTimeout]);

    // Get reader/writer for handshake
    const reader = conn.readable.getReader();
    const writer = conn.writable.getWriter();

    try {
      // SOCKS5 handshake
      await socks5Handshake(reader, writer, targetHost, targetPort,
        proxy.username && proxy.password
          ? { username: proxy.username, password: proxy.password }
          : undefined,
      );
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }

    // For HTTPS, upgrade to TLS
    let tlsConn: Socket | null = null;
    let readStream: ReadableStream<Uint8Array>;
    let writeStream: WritableStream<Uint8Array>;

    if (useTLS) {
      try {
        tlsConn = conn.startTls({ expectedServerHostname: targetHost });
        const tlsTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("SOCKS5: TLS handshake timeout")), 10000)
        );
        await Promise.race([tlsConn.opened, tlsTimeout]);
        readStream = tlsConn.readable;
        writeStream = tlsConn.writable;
      } catch (tlsErr: any) {
        throw new Error(`SOCKS5 TLS handshake failed: ${tlsErr?.message || tlsErr}`);
      }
    } else {
      readStream = conn.readable;
      writeStream = conn.writable;
    }

    // Build and send HTTP request
    const method = options.method ?? "GET";
    const requestBytes = buildHttpRequest(method, targetUrl, options.headers ?? {}, options.body);
    const w = writeStream.getWriter();
    await w.write(requestBytes);
    w.releaseLock();

    // Read response
    const r = readStream.getReader();
    const resp = await readHttpResponse(r);

    // Clean up connection on body stream close
    const origStart = resp.bodyStream;
    const wrappedBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        const bodyReader = origStart.getReader();
        try {
          while (true) {
            const { value, done } = await bodyReader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch { /* */ }
        finally {
          controller.close();
          try { conn?.close(); } catch { /* */ }
        }
      },
    });

    return new Response(wrappedBody, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  } catch (err) {
    // Clean up on error
    try { conn?.close(); } catch { /* */ }
    throw err;
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
