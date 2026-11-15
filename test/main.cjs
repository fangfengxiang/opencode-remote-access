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
        electron: { shell: { openExternal: (url) => opened.push(url) } },
        "@opencode/plugin/gui": { Ipc: { define: (value) => value } },
        effect: { Schema: { Struct: (value) => value, Array: (value) => [value] } },
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
      provide: (_schema, impl) => {
        methods = impl;
        return { emit: (_event, data) => events.push(data) };
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
          peers: () => [],
          allowPairing: (code) => allowedCodes.push(code),
          close: async () => stops.push(index),
        };
      },
      openControl: (handlers) => { controller = handlers; },
    });

    assert.deepEqual(JSON.parse(JSON.stringify((await methods.status()).config)), {
      listenHost: "", listenPort: 0, username: "", password: "",
    });
    await assert.rejects(methods.start(), /IPv4/);
    await assert.rejects(methods.save({ ...initial, listenHost: "0.0.0.0" }), /IPv4/);
    await assert.rejects(methods.save({ ...initial, username: "invalid:user" }), /冒号/);
    await assert.rejects(methods.save({ ...initial, listenPort: 54789 }), /54789/);
    assert.equal((await methods.status()).localPort, 54789);

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
    assert.equal(await methods.pair(), `${claimed.snapshot.url}/auth/connect/${pairCode}`);
    assert.deepEqual(allowedCodes, [pairCode]);
    assert.deepEqual(cliCalls, [{
      command: "fixture-cli",
      args: ["desktop-relative-prefix", "pair", "--url", claimed.snapshot.url],
    }]);

    await methods.save(changed);
    assert.equal(starts.length, 2);
    assert.equal(starts[1].username, changed.username);
    assert.equal(starts[1].password, changed.password);
    assert.equal((await controller.credentials()).username, changed.username);
    assert.deepEqual(stops, [1]);
    assert.deepEqual(JSON.parse(await fs.readFile(configFile)), changed);

    await assert.rejects(methods.save({ ...changed, listenHost: otherHost, listenPort: 54789 }), /54789/);
    assert.equal(methods.listener().url, claimed.snapshot.url);
    assert.deepEqual(stops, [1]);
    replaceError = ({ port }) => port === changed.listenPort + 1;
    await assert.rejects(methods.save({ ...changed, listenPort: changed.listenPort + 1 }), /占用/);
    assert.equal(methods.listener().url, claimed.snapshot.url);
    assert.equal(starts.at(-1).username, changed.username);
    assert.deepEqual(stops, [1]);
    assert.deepEqual(JSON.parse(await fs.readFile(configFile)), changed);

    writeError = "simulated config rename failure";
    await assert.rejects(methods.save({ ...changed, password: initial.password }), /rename failure/);
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

    console.log("PASS: blank and validated dynamic config, owner-only atomic write, discovered sidecar, lease ownership, browser/pair, listener-only rotation and both rollback paths.");
  } finally {
    await close?.();
    await fs.rm(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
