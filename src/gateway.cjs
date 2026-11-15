const http = require("node:http");
const net = require("node:net");
const { Buffer } = require("node:buffer");
const { createHash, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const PAIR_MS = 5 * 60 * 1000;
const MAX_PAIRINGS = 256;
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

async function openGateway({ host, port, username, password, upstreamUrl, upstreamHeaders = {}, onChange = () => {} }) {
  if (!net.isIP(host) || host === "0.0.0.0" || host === "::") throw new Error("请输入具体的本机监听 IP。");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("监听端口无效。");
  if (typeof username !== "string" || !username.trim() || /[:\u0000-\u001f\u007f-\u009f]/.test(username)) {
    throw new Error("账号不能为空，也不能包含冒号或控制字符。");
  }
  if (typeof password !== "string" || !password.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(password)) {
    throw new Error("密码不能为空，也不能包含控制字符。");
  }

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
  const activeSockets = new Set();
  const peerCounts = new Map();
  const challenge = 'Basic realm="OpenCode Remote", charset="UTF-8"';
  const bindHost = net.isIPv6(host) ? `[${host}]` : host;
  let url;
  let authority;
  let cookieName;
  let closing;

  function sessionToken() {
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const nonce = randomBytes(24).toString("base64url");
    const id = `${expires}.${nonce}`;
    const signature = createHmac("sha256", key).update(id).digest("base64url");
    return `${id}.${signature}`;
  }

  function validSession(token = "") {
    const match = /^(\d{1,12})\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match || Number(match[1]) <= Math.floor(Date.now() / 1000)) return false;
    const signature = createHmac("sha256", key).update(`${match[1]}.${match[2]}`).digest("base64url");
    return timingSafeEqual(Buffer.from(match[3]), Buffer.from(signature));
  }

  function requestPath(request) {
    if (request.headers.host !== authority || !request.url?.startsWith("/") ||
        request.url.startsWith("//") || /[\\#]/.test(request.url)) return undefined;
    return new URL(request.url, url);
  }

  function isAuthorized(request, target) {
    const query = target.searchParams.get("auth_token");
    if (request.headers.authorization || query) {
      const credential = request.headers.authorization
        ? /^Basic\s+([^\s]+)$/i.exec(request.headers.authorization)?.[1]
        : query;
      const parsed = authenticateToken(credential, expected);
      return parsed === true || validSession(parsed);
    }
    const origin = request.headers.origin;
    const site = request.headers["sec-fetch-site"];
    if ((origin && origin !== url) || (site && site !== "same-origin" && site !== "none")) return false;
    for (const cookie of String(request.headers.cookie ?? "").split(";")) {
      const name = `${cookieName}=`;
      const value = cookie.trim();
      if (value.startsWith(name)) return validSession(value.slice(name.length));
    }
    return false;
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
      if (!response.destroyed && !response.headersSent) reply(response, code, message);
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
        const token = sessionToken();
        if (/\btext\/html\b/i.test(request.headers.accept ?? "")) {
          response.writeHead(302, {
            Location: "/",
            "Cache-Control": "no-store",
            "Set-Cookie": `${cookieName}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax`,
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
    const target = requestPath(request);
    if (!target) return reply(response, 400, "监听地址无效。");
    const code = request.method === "GET" && PAIR_PATH.exec(request.url.split("?", 1)[0])?.[1];
    if (code) {
      const expires = pairingCodes.get(code);
      pairingCodes.delete(code);
      if (!expires || expires <= Date.now()) {
        request.resume();
        return reply(response, 401, "配对链接无效或已使用。");
      }
      redeem(request, response, target.pathname);
      return;
    }
    if (!isAuthorized(request, target)) {
      request.resume();
      return reply(response, 401, "需要远程登录。", { "WWW-Authenticate": challenge });
    }

    const outgoing = http.request(proxyOptions(request, target), (result) => {
      const headers = stripHeaders(result.headers);
      delete headers["set-cookie"];
      delete headers["www-authenticate"];
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

  const server = http.createServer(forward);
  server.on("upgrade", (request, client, clientHead) => {
    client.on("error", () => client.destroy());
    const target = requestPath(request);
    if (!target || request.headers.upgrade?.toLowerCase() !== "websocket") {
      return endUpgrade(client, 400);
    }
    if (!isAuthorized(request, target)) {
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
    const ip = normalizedIP(socket.remoteAddress);
    activeSockets.add(socket);
    if (ip) peerCounts.set(ip, (peerCounts.get(ip) ?? 0) + 1);
    if (ip && !closing) onChange();
    socket.once("close", () => {
      activeSockets.delete(socket);
      if (ip && !closing) {
        const count = peerCounts.get(ip) - 1;
        if (count) peerCounts.set(ip, count);
        else peerCounts.delete(ip);
        onChange();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const endpoint = new URL(`http://${bindHost}:${server.address().port}`);
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
      pairingCodes.set(code, now + PAIR_MS);
    },
    peers: () => Array.from(peerCounts, ([ip, count]) => ({ ip, count })).sort((left, right) => left.ip.localeCompare(right.ip)),
    close() {
      if (closing) return closing;
      closing = new Promise((resolve) => server.close(resolve));
      for (const socket of activeSockets) socket.destroy();
      peerCounts.clear();
      pairingCodes.clear();
      return closing;
    },
  };
}

module.exports = { openGateway };
