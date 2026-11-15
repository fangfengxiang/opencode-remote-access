const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "remote-main-fixture-"));
  const configFile = path.join(home, ".opencode", "remote.json");
  const listenHost = "192.0.2.20";
  const otherHost = "192.0.2.21";
  const initial = {
    listenHost,
    listenPort: 39287,
    username: "demo-user",
    password: "fixture-password-only",
    allowedSources: "",
  };
  const changed = { ...initial, username: "renamed-user", password: "new-fixture-password" };
  let methods;
  let controller;
  let close;
  let generation = 0;
  let replaceError;
  let writeError;
  const starts = [];
  const stops = [];
  const events = [];
  const cliCalls = [];
  const opened = [];
  const allowedCodes = [];
  const pairCode = "mock-only-pair-code-01";
  const pairExpiry = 1_789_000_000_000;
  const deviceId = "fixture-device-id-1234";
  const stores = new Map();
  let logs = [];
  let info = { enabled: true, path: path.join(home, "login.jsonl"), size: 0 };
  let loginLogOpened = false;
  let clearedDebounce = 0;
  const guiEvents = [];

  try {
    const source = await fs.readFile(path.join(__dirname, "../src/main.cjs"), "utf8");
    const target = { exports: {} };
    const runtimeFs = Object.create(fs, {
      rename: {
        value: async (...args) => {
          if (writeError) throw new Error(writeError);
          return fs.rename(...args);
        },
      },
    });
    vm.runInNewContext(source, {
      Buffer, URL,
      module: target,
      require: (id) => ({
        "./source-filter.cjs": require("../src/source-filter.cjs"),
        electron: { shell: { openExternal: (url) => opened.push(url) } },
        "@opencode/plugin/gui": { Ipc: { define: (value) => value } },
        effect: { Schema: { Struct: (value) => value, Array: (value) => [value] } },
        "./login-log.cjs": {
          createLoginLog: (_ctx, { onChange }) => ({
            entries: async () => logs,
            info: async () => info,
            configure: async (settings) => {
              info = { ...settings, size: info.size };
              onChange();
            },
            open: async () => { loginLogOpened = true; },
            clear: async () => {
              logs = [];
              info = { ...info, size: 0 };
              onChange();
            },
            record: (event) => {
              if (!info.enabled) return;
              const { isLocal, ...fields } = event;
              logs = [...logs, { ...fields, local: isLocal }];
              info = { ...info, size: Buffer.byteLength(logs.map((entry) => JSON.stringify(entry)).join("\n")) };
              onChange();
            },
            flush: async () => {},
          }),
        },
        "node:os": {
          homedir: () => home,
          networkInterfaces: () => ({ fixture: [{ address: listenHost }, { address: otherHost }] }),
        },
        "node:fs/promises": runtimeFs,
        "node:util": {
          promisify: () => async (command, args) => {
            cliCalls.push({ command, args: [...args] });
            return { stdout: `\x1b[31m${args.at(-1)}/auth/connect/${pairCode}\x1b[0m\n` };
          },
        },
      })[id] ?? require(id),
    });
    const { attachMain } = target.exports;
    close = attachMain({
      serverEndpoints: {
        get: (id) => {
          assert.equal(id, "sidecar");
          return {
            sameMachine: true,
            url: "http://localhost:54789",
            headers: { authorization: "Basic fixture-only" },
          };
        },
      },
      cli: { command: ["fixture-cli", "desktop-relative-prefix"] },
      t: (key, params) => params ? key + ":" + JSON.stringify(params) : key,
      storage: { store: (key, { initial }) => {
        if (!stores.has(key)) stores.set(key, initial);
        return { get value() { return stores.get(key); }, set: (value) => stores.set(key, value) };
      } },
      provide: (_schema, impl) => {
        methods = impl;
        return { emit: (event, data) => {
          guiEvents.push({ event, data });
          if (event === "listenerChanged") events.push(data);
        } };
      },
      log: { write: () => {} },
      get lifecycle() { throw new Error("desktop restart is forbidden in this fixture"); },
    }, {
      openGateway: async (params) => {
        if (replaceError?.(params)) throw Object.assign(new Error("simulated bind failure"), { code: "EADDRINUSE" });
        const index = ++generation;
        starts.push(params);
        assert.equal(params.upstreamUrl, "http://localhost:54789");
        assert.equal(params.upstreamHeaders.authorization, "Basic fixture-only");
        return {
          url: `http://${params.host}:${params.port}`,
          peers: () => [{ ip: params.host, deviceId, deviceLabel: "Fixture browser", local: false, count: 1 }],
          allowPairing: (code) => { allowedCodes.push(code); return pairExpiry; },
          clearLoginDebounce: () => { clearedDebounce += 1; },
          close: async () => stops.push(index),
        };
      },
      openControl: (handlers) => { controller = handlers; },
    });

    assert.deepEqual(JSON.parse(JSON.stringify((await methods.status()).config)), {
      listenHost: "", listenPort: 0, username: "", password: "", allowedSources: "",
    });
    await assert.rejects(methods.start(), /error.invalidIp/);
    await assert.rejects(methods.save({ ...initial, listenHost: "0.0.0.0" }), /error.invalidIp/);
    await assert.rejects(methods.save({ ...initial, username: "invalid:user" }), /error.invalidUsername/);
    await assert.rejects(methods.save({ ...initial, listenPort: 54789 }), /54789/);
    assert.equal((await methods.status()).localPort, 54789);

    await assert.rejects(methods.save({ ...initial, allowedSources: "192.0.2.0/70" }), /error.allowlist/);
    await methods.save(initial);
    assert.deepEqual(JSON.parse(await fs.readFile(configFile)), initial);
    assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
    const claimed = await controller.start();
    assert.ok(claimed.lease);
    assert.equal(claimed.snapshot.url, `http://${listenHost}:${initial.listenPort}`);
    assert.equal((await controller.start()).lease, undefined);
    await controller.stop("incorrect-lease");
    assert.equal(methods.listener().url, claimed.snapshot.url);
    await methods.openBrowser();
    assert.deepEqual(opened, [claimed.snapshot.url]);
    const paired = await methods.pair();
    assert.equal(paired.output, `${claimed.snapshot.url}/auth/connect/${pairCode}`);
    assert.equal(paired.expiresAt, pairExpiry);
    assert.equal(await controller.pair(), paired.output);
    assert.deepEqual(allowedCodes, [pairCode, pairCode]);
    assert.deepEqual(cliCalls, Array(2).fill({
      command: "fixture-cli",
      args: ["desktop-relative-prefix", "pair", "--url", claimed.snapshot.url],
    }));

    assert.equal(methods.listener().peers[0].isLocal, true);
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(starts[0].deviceKey));
    starts[0].onLogin({
      timestamp: 42, ip: listenHost, deviceId, deviceLabel: "Fixture browser",
      local: false, method: "basic", success: true, credential: "must-not-be-recorded",
    });
    const firstLog = (await methods.loginLogs())[0];
    assert.equal(firstLog.isLocal, true);
    assert.equal(firstLog.alias, "");
    assert.equal(firstLog.credential, undefined);
    assert.ok((await methods.loginLogInfo()).size);
    await methods.setDeviceAlias({ deviceId, alias: "Desk" });
    assert.equal(methods.listener().peers[0].alias, "Desk");
    assert.equal((await methods.loginLogs())[0].alias, "Desk");
    assert.equal(methods.deviceAliases()[0].deviceId, deviceId);
    assert.ok(guiEvents.some(({ event }) => event === "deviceAliasesChanged"));
    await methods.setDeviceAlias({ deviceId, alias: "" });
    assert.equal(methods.deviceAliases().length, 0);
    await methods.openLoginLog();
    assert.equal(loginLogOpened, true);
    await methods.clearLoginLogs();
    assert.equal((await methods.loginLogs()).length, 0);
    assert.equal(clearedDebounce, 1);
    assert.equal((await methods.loginLogInfo()).size, 0);
    await methods.configureLoginLog({ enabled: false, path: path.join(home, "custom.jsonl") });
    assert.equal((await methods.loginLogInfo()).enabled, false);

    await methods.save(changed);
    assert.equal(starts.length, 1);
    assert.equal(stops.length, 0);
    assert.equal((await controller.credentials()).password, initial.password);
    assert.equal(methods.listener().restartPending, true);
    assert.equal((await methods.status()).restartPending, true);
    assert.deepEqual(JSON.parse(await fs.readFile(configFile)), changed);

    await methods.saveAndRestart(changed);
    assert.equal(starts.length, 2);
    assert.equal(starts[1].deviceKey, starts[0].deviceKey);
    assert.equal(methods.listener().restartPending, false);
    assert.ok(events.some(({ restarting }) => restarting));
    assert.equal(events.at(-1).restarting, false);
    assert.equal(starts[1].username, changed.username);
    assert.equal(starts[1].password, changed.password);
    assert.equal((await controller.credentials()).username, changed.username);
    assert.deepEqual(stops, [1]);
    assert.deepEqual(JSON.parse(await fs.readFile(configFile)), changed);

    await assert.rejects(methods.save({ ...changed, listenHost: otherHost, listenPort: 54789 }), /54789/);
    assert.equal(methods.listener().url, claimed.snapshot.url);
    assert.deepEqual(stops, [1]);
    replaceError = ({ port }) => port === changed.listenPort + 1;
    await assert.rejects(methods.saveAndRestart({ ...changed, listenPort: changed.listenPort + 1 }), /error.portInUse/);
    assert.equal(methods.listener().url, claimed.snapshot.url);
    assert.equal(starts.at(-1).username, changed.username);
    assert.deepEqual(stops, [1]);
    assert.deepEqual(JSON.parse(await fs.readFile(configFile)), changed);

    writeError = "simulated config rename failure";
    await assert.rejects(methods.saveAndRestart({ ...changed, password: initial.password }), /error.saveFailed/);
    assert.deepEqual(JSON.parse(await fs.readFile(configFile)), changed);
    assert.equal((await controller.credentials()).password, changed.password);
    assert.deepEqual(await fs.readdir(path.dirname(configFile)), ["remote.json"]);

    await controller.stop(claimed.lease);
    assert.equal(methods.listener().url, "");
    assert.ok(events.length);
    assert.equal(events.at(-1).url, "");
    await fs.writeFile(configFile, JSON.stringify({ ...changed, listenPort: 54789 }));
    await assert.rejects(methods.start(), /54789/);
    assert.equal(methods.listener().url, "");

    console.log("PASS: validation, save-only and staged restart, rollback, pair expiration, local peer labels, alias changes and login log controls.");
  } finally {
    await close?.();
    await fs.rm(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
