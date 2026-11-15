const assert = require("node:assert/strict");
const { randomBytes, X509Certificate } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openGateway } = require("../src/gateway.cjs");
const { defaultHttps, validateHttps, listenerTls } = require("../src/tls.cjs");

const host = "127.0.0.1";
const problem = (key) => new Error(key);
const basic = "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64");

test("HTTPS validates provided PEM files and generates reusable IP or DNS certificates", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "remote-https-certs-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = { ...defaultHttps, enabled: true };
  assert.throws(() => validateHttps({ ...settings, certificatePath: "certificate.pem" }, problem), /httpsPathPair/);
  assert.throws(() => validateHttps({ ...settings, certificatePath: "certificate.pem", keyPath: "key.pem" }, problem), /httpsAbsolutePaths/);
  assert.throws(() => validateHttps({ ...settings, hostname: "https://host.example" }, problem), /httpsHostname/);
  assert.equal(validateHttps({ ...settings, hostname: "Täst.example." }, problem).hostname, "xn--tst-qla.example");
  assert.equal(await listenerTls(defaultHttps, host, directory, problem), undefined);

  const ipMaterial = await listenerTls(settings, host, directory, problem);
  assert.equal(new X509Certificate(ipMaterial.cert).checkIP(host), host);
  const reused = await listenerTls(settings, host, directory, problem);
  assert.deepEqual(reused.cert, ipMaterial.cert);
  assert.deepEqual(reused.key, ipMaterial.key);
  const keyPath = path.join(path.dirname(reused.generatedCertificatePath), "private-key.pem");
  if (process.platform !== "win32") assert.equal((await fs.stat(keyPath)).mode & 0o777, 0o600);

  const dnsSettings = { ...settings, hostname: "remote.example" };
  const dnsMaterial = await listenerTls(dnsSettings, host, directory, problem);
  assert.equal(new X509Certificate(dnsMaterial.cert).checkHost(dnsSettings.hostname), dnsSettings.hostname);
  const supplied = {
    ...dnsSettings,
    certificatePath: dnsMaterial.generatedCertificatePath,
    keyPath: path.join(path.dirname(dnsMaterial.generatedCertificatePath), "private-key.pem"),
  };
  const custom = await listenerTls(supplied, host, directory, problem);
  assert.equal(custom.hostname, dnsSettings.hostname);
  assert.equal(custom.generatedCertificatePath, undefined);
  await assert.rejects(listenerTls({ ...supplied, hostname: "" }, host, directory, problem), /httpsCertificateHost/);
  await assert.rejects(listenerTls({ ...supplied, keyPath }, host, directory, problem), /httpsInvalidPem/);
  await assert.rejects(listenerTls({ ...supplied, keyPath: path.join(directory, "missing") }, host, directory, problem), /httpsRead/);
});

function get(url, material, requestPath, headers = {}, upgrade = false) {
  const origin = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: host,
      port: Number(origin.port),
      servername: material.hostname || undefined,
      ca: material.cert,
      agent: false,
      path: requestPath,
      headers: { Host: origin.host, ...headers },
    }, (res) => {
      res.resume();
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      res.once("error", reject);
    });
    if (upgrade) req.once("upgrade", (res, socket) => resolve({ status: res.statusCode, socket }));
    req.once("error", reject);
  });
}

test("HTTPS gateway retains authentication, secure pairing cookies, WSS and the source allowlist", { timeout: 10_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "remote-https-gateway-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const material = await listenerTls({ ...defaultHttps, enabled: true, hostname: "remote.example" }, host, directory, problem);
  const backend = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Basic fixture-upstream");
    assert.equal(req.headers.cookie, undefined);
    if (req.url.startsWith("/auth/connect/")) return res.end(JSON.stringify({ token: "fixture-server-pairing-token" }));
    res.end("fixture");
  });
  backend.on("upgrade", (req, socket) => {
    assert.equal(req.headers.authorization, "Basic fixture-upstream");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.pipe(socket);
  });
  backend.listen(0, host);
  await once(backend, "listening");
  const config = {
    host,
    port: 0,
    username: "fixture-user",
    password: "fixture-password",
    upstreamUrl: `http://${host}:${backend.address().port}`,
    upstreamHeaders: { authorization: "Basic fixture-upstream" },
    tls: material,
  };
  const events = [];
  let gateway;
  try {
    gateway = await openGateway({ ...config, onLogin: (event) => events.push(event) });
    assert.match(gateway.url, /^https:\/\/remote\.example:\d+$/);
    assert.equal((await get(gateway.url, material, "/")).status, 401);
    const basicAuth = await get(gateway.url, material, "/", { Authorization: basic, Accept: "text/html" });
    assert.equal(basicAuth.status, 200);
    assert.match(basicAuth.headers["set-cookie"][0], /; Secure\b/);

    const code = randomBytes(16).toString("base64url");
    gateway.allowPairing(code);
    const paired = await get(gateway.url, material, `/auth/connect/${code}`, { Accept: "text/html" });
    assert.equal(paired.status, 302);
    assert.ok(paired.headers["set-cookie"].every((cookie) => /; Secure\b/.test(cookie)));
    const cookie = paired.headers["set-cookie"].map((value) => value.split(";", 1)[0]).join("; ");
    assert.equal((await get(gateway.url, material, "/api/info", { Cookie: cookie, Origin: gateway.url })).status, 200);
    assert.equal((await get(gateway.url, material, "/api/info", {
      Cookie: cookie, Origin: gateway.url, Authorization: "Basic c3RhbGU6Y3JlZGVudGlhbHM=",
    })).status, 401);
    assert.deepEqual(events.filter((event) => event.success).map((event) => event.method), ["basic", "pair"]);
    assert.ok(events.every((event) => event.ip === host));
    const { status, socket } = await get(gateway.url, material, "/socket", {
      Authorization: basic, Connection: "Upgrade", Upgrade: "websocket",
    }, true);
    assert.equal(status, 101);
    const echo = once(socket, "data");
    socket.write("encrypted echo");
    assert.equal((await echo)[0].toString(), "encrypted echo");
    assert.ok(gateway.peers().some((peer) => peer.ip === host));
    const closed = once(socket, "close");
    await gateway.close();
    await closed;

    gateway = await openGateway({
      ...config, allowedSources: "192.0.2.10", onLogin: (event) => events.push(event),
    });
    assert.equal((await get(gateway.url, material, "/", { Authorization: basic })).status, 403);
    assert.equal(events.at(-1).method, "blocked");
    assert.equal(gateway.peers().length, 0);
  } finally {
    await gateway?.close();
    await new Promise((resolve) => backend.close(resolve));
  }
});
