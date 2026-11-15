const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const { randomBytes } = require("node:crypto");
const test = require("node:test");
const { openGateway } = require("../src/gateway.cjs");

const basic = (name, value) => "Basic " + Buffer.from(`${name}:${value}`).toString("base64");
const host = "127.0.0.1";
const native = basic("fixture-native", "fixture-local-secret");
const remote = basic("fixture-remote", "fixture-remote-secret");
const wrong = basic("fixture-remote", "fixture-mismatch");

function post(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST", headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve(text));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end("payload");
  });
}

function status(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
  });
}

function upgrade(url, path, authorization) {
  return new Promise((resolve, reject) => {
    const request = http.get(url + path, {
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        Connection: "Upgrade",
        Upgrade: "websocket",
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve({ code: response.statusCode });
    });
    request.on("upgrade", (response, socket, head) => resolve({ code: response.statusCode, socket, head }));
    request.on("error", reject);
  });
}

test("remote authentication, pairing, streams, connections and rotation", async () => {
  const codes = new Set();
  let lastRequest;
  const backend = http.createServer((req, res) => {
    lastRequest = { url: req.url, headers: req.headers, method: req.method };
    assert.equal(req.headers.authorization, native);
    assert.equal(req.headers.cookie, undefined);
    if (req.url.startsWith("/auth/connect/")) {
      const code = req.url.split("/").pop();
      assert.equal(req.headers.accept, "application/json");
      if (!codes.delete(code)) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ token: "fixture-local-paired-session" }));
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Set-Cookie": "backend=secret" });
      res.write("data: connected\n\n");
      req.on("close", () => res.end());
      return;
    }
    req.pipe(res);
  });
  backend.on("upgrade", (req, socket) => {
    assert.equal(req.headers.authorization, native);
    assert.equal(req.url, "/socket");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.pipe(socket);
    socket.on("error", () => socket.destroy());
  });
  backend.listen(0, host);
  await once(backend, "listening");
  let updates = 0;
  const options = {
    host,
    port: 0,
    username: "fixture-remote",
    password: "fixture-remote-secret",
    upstreamUrl: `http://${host}:${backend.address().port}`,
    upstreamHeaders: { Authorization: native },
    onChange: () => { updates += 1; },
  };
  let service = await openGateway(options);
  const response = (path, options) => fetch(service.url + path, options);
  try {
    const unauthenticated = await response("/api/info");
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get("www-authenticate"), /^Basic /);
    assert.equal(lastRequest, undefined);
    assert.equal((await response("/api/info", { headers: { Authorization: native } })).status, 401);
    assert.equal((await response("/api/info", { headers: { Authorization: wrong } })).status, 401);
    const posted = await post(service.url + "/echo?auth_token=discarded&keep=1", {
      Authorization: remote,
      Cookie: "browser-only=secret",
      "X-Forwarded-Host": "unexpected.invalid",
      Connection: "keep-alive, X-Drop-Me",
      "X-Drop-Me": "drop",
    });
    assert.equal(posted, "payload");
    assert.equal(new URL(service.url).host, lastRequest.headers.host);
    assert.equal(lastRequest.url, "/echo?keep=1");
    assert.equal(lastRequest.headers["x-forwarded-host"], undefined);
    assert.equal(lastRequest.headers["x-drop-me"], undefined);

    const htmlCode = randomBytes(16).toString("base64url");
    codes.add(htmlCode);
    assert.equal((await response(`/auth/connect/${htmlCode}`)).status, 401);
    service.allowPairing(htmlCode);
    const html = await response(`/auth/connect/${htmlCode}`, { headers: { Accept: "text/html" }, redirect: "manual" });
    assert.equal(html.status, 302);
    assert.equal(html.headers.get("location"), "/");
    const cookieHeader = html.headers.get("set-cookie");
    assert.match(cookieHeader, /HttpOnly; SameSite=Lax/);
    assert.doesNotMatch(cookieHeader, /fixture-local/);
    const cookie = cookieHeader.split(";")[0];
    assert.equal((await response("/", { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await response("/", { headers: { Cookie: cookie, Origin: "https://other.invalid" } })).status, 401);
    assert.equal((await response("/", { headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } })).status, 401);
    assert.equal((await response(`/auth/connect/${htmlCode}`)).status, 401);

    const jsonCode = randomBytes(16).toString("base64url");
    codes.add(jsonCode);
    service.allowPairing(jsonCode);
    const paired = await response(`/auth/connect/${jsonCode}`, { headers: { Accept: "application/json" } });
    assert.equal(paired.status, 200);
    const { token } = await paired.json();
    assert.notEqual(token, "fixture-local-paired-session");
    const app = basic("fixture-native-client", token);
    assert.equal((await response("/api/info", { headers: { Authorization: app } })).status, 200);
    assert.equal((await response("/", { headers: { Authorization: wrong, Cookie: cookie } })).status, 401);

    const stream = await response("/events", { headers: { Authorization: remote } });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("set-cookie"), null);
    const reader = stream.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "data: connected\n\n");
    await reader.cancel();

    const refused = await upgrade(service.url, "/socket");
    assert.equal(refused.code, 401);
    const upgraded = await upgrade(service.url, "/socket?auth_token=" + encodeURIComponent(app.slice(6)));
    assert.equal(upgraded.code, 101);
    upgraded.socket.on("error", () => upgraded.socket.destroy());
    const echo = once(upgraded.socket, "data");
    upgraded.socket.write("upgrade echo");
    assert.equal((await echo)[0].toString(), "upgrade echo");
    const raw = net.connect(Number(new URL(service.url).port), host);
    raw.on("error", () => raw.destroy());
    await once(raw, "connect");
    const sameIpConnections = service.peers().filter((peer) => peer.ip === host).reduce((total, peer) => total + peer.count, 0);
    assert.ok(sameIpConnections >= 2);
    assert.ok(updates > 0);

    const oldAddress = service.url;
    const unused = randomBytes(16).toString("base64url");
    codes.add(unused);
    service.allowPairing(unused);
    await service.close();
    assert.deepEqual(service.peers(), []);
    service = await openGateway({ ...options, port: Number(new URL(oldAddress).port), password: "fixture-rotated-secret" });
    assert.equal(await status(service.url, { Cookie: cookie }), 401);
    assert.equal(await status(service.url + `/auth/connect/${unused}`), 401);
    assert.equal(await status(service.url, { Authorization: app }), 401);
    assert.equal(await status(service.url, { Authorization: remote }), 401);
    assert.equal(await status(service.url, { Authorization: basic(options.username, "fixture-rotated-secret") }), 200);
  } finally {
    await service.close();
    await new Promise((resolve) => backend.close(resolve));
  }
});

test("device identity, model metadata, and credential attempts without secret data", async () => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, undefined);
    if (req.url.startsWith("/auth/connect/")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ token: "fixture-upstream-token" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end("<title>fixture</title>");
  });
  upstream.listen(0, host);
  await once(upstream, "listening");

  const attempts = [];
  const options = {
    host, port: 0, username: "fixture-remote", password: "fixture-remote-secret",
    upstreamUrl: `http://${host}:${upstream.address().port}`,
    deviceKey: randomBytes(32),
    onLogin: (entry) => attempts.push(entry),
  };
  let service = await openGateway(options);
  const mobile = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/ABC) Chrome/120.0",
    "Sec-CH-UA-Model": '"Pixel 7"',
    Accept: "text/html",
  };
  const request = (headers, path = "/") => fetch(service.url + path, { headers, redirect: "manual" });
  try {
    const challenge = await request(mobile);
    assert.equal(challenge.status, 401);
    assert.equal(challenge.headers.get("set-cookie"), null);
    assert.deepEqual(attempts, []);

    for (let i = 0; i < 2; i++) assert.equal((await request({ ...mobile, Authorization: wrong })).status, 401);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].success, false);

    const first = await request({ ...mobile, Authorization: remote });
    assert.equal(first.status, 200);
    assert.match(first.headers.get("set-cookie"), /opencode_remote_device=[^;]+; Path=\/;.*HttpOnly; SameSite=Lax/);
    const deviceCookie = first.headers.get("set-cookie").split(";")[0];
    const deviceId = attempts.at(-1).deviceId;
    const keep = { ...mobile, Cookie: deviceCookie, Authorization: remote };
    assert.match(deviceId, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(attempts.at(-1).deviceLabel, "Pixel 7 · Android · Chrome");
    assert.equal(attempts.at(-1).local, true);
    for (let i = 0; i < 3; i++) assert.equal((await request(keep)).status, 200);
    assert.equal(attempts.length, 2);

    const laterCookie = await new Promise((resolve, reject) => {
      const probe = http.get(service.url, {
        agent: false,
        headers: { ...mobile, Authorization: remote, Cookie: "opencode_remote_device=bad.token" },
      }, (response) => {
        response.resume();
        resolve(response.headers["set-cookie"][0].split(";")[0]);
      });
      probe.on("error", reject);
    });
    assert.notEqual(laterCookie, deviceCookie);

    const nativeCode = randomBytes(16).toString("base64url");
    const now = Date.now();
    const expiresAt = service.allowPairing(nativeCode);
    assert.ok(expiresAt - now >= 300000 && expiresAt - now < 301000);
    const paired = await request({ Accept: "application/json", "User-Agent": "OpenCodeClient/1" }, `/auth/connect/${nativeCode}`);
    assert.equal(paired.status, 200);
    const { token } = await paired.json();
    const pairedIdentity = attempts.at(-1).deviceId;
    assert.equal(attempts.at(-1).method, "pair");
    assert.match(attempts.at(-1).deviceLabel, /OpenCode App/);
    assert.equal((await request({ Authorization: basic("native", token), "User-Agent": "OpenCodeClient/2" })).status, 200);
    assert.ok(service.peers().some((entry) => entry.deviceId === pairedIdentity));
    assert.doesNotMatch(JSON.stringify(attempts), /fixture-remote-secret|fixture-upstream-token|Mozilla\/5\.0/);

    await service.close();
    service = await openGateway({ ...options, password: "fixture-rotated-secret" });
    assert.equal((await request({ ...mobile, Cookie: deviceCookie })).status, 401);
    assert.equal((await request({ ...mobile, Cookie: deviceCookie, Authorization: remote })).status, 401);
    assert.equal((await request({ ...mobile, Cookie: deviceCookie, Authorization: basic(options.username, "fixture-rotated-secret") })).status, 200);
    assert.equal(attempts.at(-1).deviceId, deviceId);
    assert.equal(attempts.at(-1).success, true);
  } finally {
    await service.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("a nonempty source allowlist blocks HTTP, pairing and upgrades before authentication", async () => {
  const { sourceFilter } = require("../src/source-filter.cjs");
  assert.ok(sourceFilter("")("192.0.2.6"));
  assert.ok(sourceFilter("192.0.2.6, 2001:db8::/48")("2001:db8::6"));
  assert.ok(!sourceFilter("192.0.2.6, 2001:db8::/48")("192.0.2.7"));
  assert.throws(() => sourceFilter("192.0.2.6/33"));
  assert.throws(() => sourceFilter("example.invalid"));

  let upstreamRequests = 0;
  const backend = http.createServer((_request, response) => {
    upstreamRequests++;
    response.end("upstream");
  });
  backend.listen(0, host);
  await once(backend, "listening");
  const options = {
    host,
    port: 0,
    username: "fixture-remote",
    password: "fixture-remote-secret",
    upstreamUrl: `http://${host}:${backend.address().port}`,
    upstreamHeaders: { Authorization: native },
  };
  const events = [];
  let gateway;
  try {
    gateway = await openGateway({ ...options, allowedSources: "192.0.2.6/32", onLogin: (event) => events.push(event) });
    const authorization = { Authorization: remote, "X-Forwarded-For": "192.0.2.6" };
    const response = await fetch(`${gateway.url}/api/info`, { headers: authorization });
    assert.equal(response.status, 403);
    await response.text();
    const code = randomBytes(16).toString("base64url");
    gateway.allowPairing(code);
    assert.equal(await status(`${gateway.url}/auth/connect/${code}`, authorization), 403);
    assert.equal((await upgrade(gateway.url, "/socket", remote)).code, 403);
    assert.equal(gateway.peers().length, 0);
    assert.equal(upstreamRequests, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].method, "blocked");
    assert.equal(events[0].success, false);
    assert.equal(events[0].ip, host);
    await gateway.close();

    gateway = await openGateway({ ...options, allowedSources: "127.0.0.0/8" });
    assert.equal(await status(`${gateway.url}/api/info`, { Authorization: remote }), 200);
    assert.equal(upstreamRequests, 1);
  } finally {
    await gateway?.close();
    await new Promise((resolve) => backend.close(resolve));
  }
});
