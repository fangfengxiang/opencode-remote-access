const { sourceFilter } = require("./source-filter.cjs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { Buffer } = require("node:buffer");
const { createHash, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const PAIR_MS = 5 * 60 * 1000;
const MAX_PAIRINGS = 256;
const DEVICE_COOKIE = "opencode_remote_device";
const DEVICE_SECONDS = 180 * 24 * 60 * 60;
const MAX_RECENT_LOGINS = 1024;
const SUCCESS_LOG_MS = 10 * 60 * 1000;
const FAILURE_LOG_MS = 5 * 1000;
const PAIR_CODE = /^[A-Za-z0-9_-]{22}$/;
const PAIR_PATH = /^\/auth\/connect\/([A-Za-z0-9_-]{22})$/;
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

function stripHeaders(headers) {
  const connectionHeaders = new Set(String(headers.connection ?? "").toLowerCase().split(",").map((header) => header.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([header]) =>
    !HOP_HEADERS.has(header) && !connectionHeaders.has(header),
  ));
}

function normalizedIP(ip = "") {
  return ip.replace(/^::ffff:/i, "");
}

function cookieValue(headers, name) {
  const prefix = `${name}=`;
  for (const cookie of String(headers.cookie ?? "").split(";")) {
    const value = cookie.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return "";
}

function deviceMetadata(headers) {
  const ua = String(headers["user-agent"] ?? "").slice(0, 512);
  const platformHint = String(headers["sec-ch-ua-platform"] ?? "").slice(0, 32).replace(/^"|"$/g, "");
  const modelHint = String(headers["sec-ch-ua-model"] ?? "").slice(0, 100).replace(/^"|"$/g, "");
  let platform = "";
  if (/^android$/i.test(platformHint) || /Android/i.test(ua)) platform = "Android";
  else if (/^iOS$/i.test(platformHint) || /iPhone|iPad|iPod/i.test(ua)) platform = "iOS";
  else if (/^macOS$/i.test(platformHint) || /Macintosh|Mac OS X/i.test(ua)) platform = "macOS";
  else if (/^Windows$/i.test(platformHint) || /Windows/i.test(ua)) platform = "Windows";
  else if (/^Chrome OS$/i.test(platformHint) || /CrOS/i.test(ua)) platform = "ChromeOS";
  else if (/^Linux$/i.test(platformHint) || /Linux/i.test(ua)) platform = "Linux";

  let browser = "";
  if (/Opencode/i.test(ua)) browser = "OpenCode App";
  else if (/Edg(?:A|iOS)?\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/SamsungBrowser\//.test(ua)) browser = "Samsung Internet";
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = "Firefox";
  else if (/Chrome\/|CriOS\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";
  else if (/curl\//.test(ua)) browser = "curl";

  let model = modelHint;
  if (!model && platform === "Android") {
    model = /Android[^;)]*;\s*([^;)]+?)\s+Build\//i.exec(ua)?.[1] ?? "";
  }
  model = model.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 64);
  if (/^(?:K|Android|Unknown)$/i.test(model)) model = "";
  if (!model) model = /\b(iPhone|iPad|iPod)\b/i.exec(ua)?.[0] ?? "";
  return {
    label: Array.from(new Set([model, platform, browser].filter(Boolean))).join(" · "),
    // Hash this transient value before it leaves the gateway.
    seed: ua || [platform, model, browser].join(" "),
  };
}

function secretDigest(value) {
  return createHash("sha256").update(value).digest();
}

function isLoopback(host) {
  return host === "localhost" || host === "[::1]" || (net.isIPv4(host) && host.startsWith("127."));
}

function authenticateToken(input, expected) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(input ?? "")) return undefined;
  const decoded = Buffer.from(input, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 1) return undefined;
  if (timingSafeEqual(secretDigest(decoded), expected)) return true;
  return decoded.slice(colon + 1);
}

function reply(response, code, message, extra = {}) {
  const body = JSON.stringify({ message });
  response.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...extra,
  });
  response.end(body);
}

function endUpgrade(socket, code, extra = "") {
  socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nConnection: close\r\n${extra}\r\n`);
}

async function openGateway({
  host,
  port,
  username,
  password,
  upstreamUrl,
  upstreamHeaders = {},
  tls,
  allowedSources = "",
  deviceKey = randomBytes(32),
  onChange = () => {},
  onLogin = () => {},
}) {
  if (!net.isIP(host) || host === "0.0.0.0" || host === "::") throw new Error("请输入具体的本机监听 IP。");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("监听端口无效。");
  if (typeof username !== "string" || !username.trim() || /[:\u0000-\u001f\u007f-\u009f]/.test(username)) {
    throw new Error("账号不能为空，也不能包含冒号或控制字符。");
  }
  if (typeof password !== "string" || !password.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(password)) {
    throw new Error("密码不能为空，也不能包含控制字符。");
  }

  const permits = sourceFilter(allowedSources);
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== "http:" || !isLoopback(upstream.hostname) || upstream.username || upstream.password ||
      upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("OpenCode 后台地址必须是本机 HTTP 服务。");
  }
  const localHostname = upstream.hostname === "[::1]" ? "::1" : upstream.hostname;
  const trustedHeaders = Object.fromEntries(Object.entries(upstreamHeaders).map(([name, value]) => [name.toLowerCase(), value]));
  const expected = secretDigest(`${username}:${password}`);
  const key = randomBytes(32);
  const pairingCodes = new Map();
  const wireSockets = new Set();
  const activeSockets = new Map();
  const recentLogins = new Map();
  const challenge = 'Basic realm="OpenCode Remote", charset="UTF-8"';
  const urlHost = tls?.hostname || (net.isIPv6(host) ? `[${host}]` : host);
  const scheme = tls ? "https" : "http";
  const cookieSecurity = tls ? "; Secure" : "";
  let url;
  let authority;
  let cookieName;
  let closing;

  function sessionToken(deviceId) {
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const identity = deviceId || randomBytes(16).toString("base64url");
    const nonce = identity + randomBytes(8).toString("base64url").slice(0, 10);
    const id = `${expires}.${nonce}`;
    const signature = createHmac("sha256", key).update(id).digest("base64url");
    return `${id}.${signature}`;
  }

  function sessionDevice(token = "") {
    const match = /^(\d{1,12})\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match || Number(match[1]) <= Math.floor(Date.now() / 1000)) return "";
    const signature = createHmac("sha256", key).update(`${match[1]}.${match[2]}`).digest("base64url");
    return timingSafeEqual(Buffer.from(match[3]), Buffer.from(signature)) ? match[2].slice(0, 22) : "";
  }

  function requestPath(request) {
    if (request.headers.host !== authority || !request.url?.startsWith("/") ||
        request.url.startsWith("//") || /[\\#]/.test(request.url)) return undefined;
    return new URL(request.url, url);
  }

  function authenticate(request, target) {
    const query = target.searchParams.get("auth_token");
    if (request.headers.authorization || query) {
      const credential = request.headers.authorization
        ? /^Basic\s+([^\s]+)$/i.exec(request.headers.authorization)?.[1]
        : query;
      const parsed = authenticateToken(credential, expected);
      if (parsed === true) return { allowed: true, basic: true };
      const deviceId = sessionDevice(parsed);
      if (deviceId) return { allowed: true, basic: false, deviceId };
      return { allowed: false, basic: Boolean(credential) };
    }
    const origin = request.headers.origin;
    const site = request.headers["sec-fetch-site"];
    const sameOrigin = (!origin || origin === url) && (!site || site === "same-origin" || site === "none");
    const deviceId = sameOrigin ? sessionDevice(cookieValue(request.headers, cookieName)) : "";
    return { allowed: Boolean(deviceId), basic: false, deviceId };
  }

  function deviceDigest(value) {
    return createHmac("sha256", deviceKey).update(value).digest("base64url");
  }

  function signedDevice(request) {
    const token = cookieValue(request.headers, DEVICE_COOKIE);
    const match = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return "";
    const [, id, signature] = match;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(deviceDigest(`cookie:${id}`))) ? id : "";
  }

  function browserNavigation(request) {
    return request.headers["sec-fetch-mode"] === "navigate" || /\btext\/html\b/i.test(request.headers.accept ?? "");
  }

  function describePeer(request, issueDevice = false, sessionIdentity = "") {
    const socket = activeSockets.get(request.socket);
    if (!socket?.ip) return undefined;
    const metadata = deviceMetadata(request.headers);
    const fallback = deviceDigest(JSON.stringify(["fallback", socket.ip, metadata.seed])).slice(0, 22);
    let id = sessionIdentity || signedDevice(request);
    let cookie;
    if (!id && issueDevice) {
      socket.browserId ??= randomBytes(16).toString("base64url");
      id = socket.browserId;
      const token = `${id}.${deviceDigest(`cookie:${id}`)}`;
      cookie = `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${DEVICE_SECONDS}; HttpOnly; SameSite=Lax${cookieSecurity}`;
    }
    id ||= socket.browserId || fallback;
    if (socket.deviceId !== id || socket.deviceLabel !== metadata.label) {
      socket.deviceId = id;
      socket.deviceLabel = metadata.label;
      if (!closing) onChange();
    }
    return {
      ip: socket.ip,
      local: socket.local,
      deviceId: id,
      deviceLabel: metadata.label,
      cookie,
    };
  }

  function recordLogin(peer, method, success) {
    if (!peer || closing) return;
    const timestamp = Date.now();
    const identity = success ? peer.deviceId : peer.ip;
    const key = JSON.stringify([identity, method, success]);
    if ((recentLogins.get(key) ?? 0) > timestamp) return;
    if (recentLogins.size >= MAX_RECENT_LOGINS) {
      for (const [id, expires] of recentLogins) {
        if (expires <= timestamp) recentLogins.delete(id);
      }
      if (recentLogins.size >= MAX_RECENT_LOGINS) recentLogins.delete(recentLogins.keys().next().value);
    }
    recentLogins.set(key, timestamp + (success ? SUCCESS_LOG_MS : FAILURE_LOG_MS));
    const { ip, deviceId, deviceLabel, local } = peer;
    onLogin({ timestamp, ip, deviceId, deviceLabel, local, method, success });
  }

  function proxyOptions(request, target, upgrade = false) {
    const path = new URL(target);
    if (path.searchParams.has("auth_token")) path.searchParams.delete("auth_token");
    const headers = stripHeaders(request.headers);
    for (const header of Object.keys(headers)) {
      if (header === "authorization" || header === "cookie" || header === "forwarded" || header.startsWith("x-forwarded-")) {
        delete headers[header];
      }
    }
    return {
      hostname: localHostname,
      port: upstream.port || undefined,
      method: request.method,
      path: path.pathname + path.search,
      headers: {
        ...headers, ...trustedHeaders, host: authority,
        ...(upgrade ? { connection: "Upgrade", upgrade: "websocket" } : {}),
      },
    };
  }

  function redeem(request, response, path) {
    request.resume();
    const fail = (code, message) => {
      if (!response.destroyed && !response.headersSent) {
        recordLogin(describePeer(request), "pair", false);
        reply(response, code, message);
      }
    };
    // OpenCode consumes the original code. Only the gateway's own token is returned to peers.
    const pairing = http.get({
      hostname: localHostname,
      port: upstream.port || undefined,
      path,
      headers: { ...trustedHeaders, host: authority, accept: "application/json" },
      timeout: 5000,
    }, (result) => {
      if (result.statusCode !== 200) {
        result.resume();
        fail(result.statusCode === 400 || result.statusCode === 401 ? 401 : 502, "配对链接无效或已使用。");
        return;
      }

      let payload = "";
      result.setEncoding("utf8");
      result.on("data", (chunk) => {
        payload += chunk;
        if (payload.length > 4096) result.destroy(new Error("Invalid pairing response"));
      });
      result.on("error", () => fail(502, "无法完成配对。"));
      result.on("end", () => {
        if (response.destroyed || response.headersSent) return;
        let paired = false;
        try { paired = typeof JSON.parse(payload).token === "string"; } catch {}
        if (!paired) {
          fail(502, "无法完成配对。");
          return;
        }
        const browser = /\btext\/html\b/i.test(request.headers.accept ?? "");
        const peer = describePeer(request, browser);
        const token = sessionToken(peer?.deviceId);
        recordLogin(peer, "pair", true);
        if (browser) {
          const cookies = [`${cookieName}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax${cookieSecurity}`];
          if (peer?.cookie) cookies.push(peer.cookie);
          response.writeHead(302, {
            Location: "/",
            "Cache-Control": "no-store",
            "Set-Cookie": cookies,
          });
          response.end();
        } else {
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ token }));
        }
      });
    });
    pairing.on("timeout", () => pairing.destroy());
    pairing.on("error", () => fail(502, "无法连接本机 OpenCode 服务。"));
    response.on("close", () => { if (!response.writableEnded) pairing.destroy(); });
  }

  function forward(request, response) {
    if (activeSockets.get(request.socket)?.blocked !== false) {
      request.resume();
      return reply(response, 403, "Source IP blocked.", { Connection: "close" });
    }
    const target = requestPath(request);
    if (!target) return reply(response, 400, "监听地址无效。");
    const code = request.method === "GET" && PAIR_PATH.exec(request.url.split("?", 1)[0])?.[1];
    if (code) {
      const expires = pairingCodes.get(code);
      pairingCodes.delete(code);
      if (!expires || expires <= Date.now()) {
        request.resume();
        recordLogin(describePeer(request), "pair", false);
        return reply(response, 401, "配对链接无效或已使用。");
      }
      redeem(request, response, target.pathname);
      return;
    }
    const auth = authenticate(request, target);
    const peer = describePeer(request, auth.allowed && auth.basic && browserNavigation(request), auth.deviceId);
    if (auth.basic) recordLogin(peer, "basic", auth.allowed);
    if (!auth.allowed) {
      request.resume();
      return reply(response, 401, "需要远程登录。", { "WWW-Authenticate": challenge });
    }

    const outgoing = http.request(proxyOptions(request, target), (result) => {
      const headers = stripHeaders(result.headers);
      delete headers["set-cookie"];
      delete headers["www-authenticate"];
      if (peer?.cookie) headers["set-cookie"] = peer.cookie;
      response.writeHead(result.statusCode, headers);
      result.on("error", () => response.destroy());
      result.pipe(response);
    });
    outgoing.on("error", () => {
      if (response.headersSent) response.destroy();
      else if (!response.destroyed) reply(response, 502, "无法连接本机 OpenCode 服务。");
    });
    request.on("error", () => outgoing.destroy());
    response.on("close", () => { if (!response.writableEnded) outgoing.destroy(); });
    request.pipe(outgoing);
  }

  const server = tls
    ? https.createServer({ cert: tls.cert, key: tls.key, minVersion: tls.minVersion, handshakeTimeout: 10_000 }, forward)
    : http.createServer(forward);
  server.on("upgrade", (request, client, clientHead) => {
    client.on("error", () => client.destroy());
    if (activeSockets.get(client)?.blocked !== false) return endUpgrade(client, 403);
    const target = requestPath(request);
    if (!target || request.headers.upgrade?.toLowerCase() !== "websocket") {
      return endUpgrade(client, 400);
    }
    const auth = authenticate(request, target);
    const peer = describePeer(request, false, auth.deviceId);
    if (auth.basic) recordLogin(peer, "basic", auth.allowed);
    if (!auth.allowed) {
      return endUpgrade(client, 401, `WWW-Authenticate: ${challenge}\r\n`);
    }
    const outgoing = http.request(proxyOptions(request, target, true));
    client.on("close", () => outgoing.destroy());
    outgoing.on("error", () => endUpgrade(client, 502));
    outgoing.on("response", (response) => {
      response.resume();
      endUpgrade(client, response.statusCode);
    });
    outgoing.on("upgrade", (response, socket, head) => {
      const headers = stripHeaders(response.headers);
      delete headers["set-cookie"];
      delete headers["www-authenticate"];
      const lines = ["HTTP/1.1 101 Switching Protocols", "Connection: Upgrade", "Upgrade: websocket"];
      for (const [name, value] of Object.entries(headers)) {
        for (const entry of [].concat(value)) lines.push(`${name}: ${entry}`);
      }
      client.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) client.write(head);
      if (clientHead.length) socket.write(clientHead);
      socket.on("error", () => client.destroy());
      socket.on("close", () => client.destroy());
      client.on("close", () => socket.destroy());
      client.pipe(socket);
      socket.pipe(client);
    });
    outgoing.end();
  });

  server.on("connection", (socket) => {
    wireSockets.add(socket);
    socket.once("close", () => wireSockets.delete(socket));
  });

  server.on(tls ? "secureConnection" : "connection", (socket) => {
    const ip = normalizedIP(socket.remoteAddress);
    const local = ip === normalizedIP(host) || ip === "::1" || (net.isIPv4(ip) && ip.startsWith("127."));
    const blocked = !permits(ip);
    const peer = { ip, local, deviceId: "", deviceLabel: "", blocked };
    activeSockets.set(socket, peer);
    if (blocked) {
      recordLogin(peer, "blocked", false);
      socket.setTimeout(4000, () => socket.destroy());
    } else if (ip && !closing) {
      onChange();
    }
    socket.once("close", () => {
      activeSockets.delete(socket);
      if (ip && !blocked && !closing) onChange();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const endpoint = new URL(`${scheme}://${urlHost}:${server.address().port}`);
      authority = endpoint.host;
      url = endpoint.origin;
      cookieName = `opencode_remote_session_${server.address().port}`;
      resolve();
    });
  });
  return {
    url,
    allowPairing(code) {
      if (closing || !PAIR_CODE.test(code)) throw new Error("配对码无效。");
      const now = Date.now();
      for (const [stored, expires] of pairingCodes) {
        if (expires <= now) pairingCodes.delete(stored);
      }
      if (pairingCodes.size >= MAX_PAIRINGS) pairingCodes.delete(pairingCodes.keys().next().value);
      const expiresAt = now + PAIR_MS;
      pairingCodes.set(code, expiresAt);
      return expiresAt;
    },
    peers() {
      const groups = new Map();
      for (const { ip, local, deviceId, deviceLabel, blocked } of activeSockets.values()) {
        if (!ip || blocked) continue;
        const key = JSON.stringify([ip, deviceId]);
        const existing = groups.get(key);
        if (existing) {
          existing.count += 1;
          if (!existing.deviceLabel && deviceLabel) existing.deviceLabel = deviceLabel;
        } else {
          groups.set(key, { ip, local, deviceId, deviceLabel, count: 1 });
        }
      }
      return Array.from(groups.values()).sort((left, right) =>
        left.ip.localeCompare(right.ip) || left.deviceId.localeCompare(right.deviceId),
      );
    },
    clearLoginDebounce: () => recentLogins.clear(),
    close() {
      if (closing) return closing;
      closing = new Promise((resolve) => server.close(resolve));
      if (tls) {
        for (const socket of activeSockets.keys()) socket.destroy();
      }
      for (const socket of wireSockets) socket.destroy();
      wireSockets.clear();
      activeSockets.clear();
      pairingCodes.clear();
      recentLogins.clear();
      return closing;
    },
  };
}

module.exports = { openGateway };
