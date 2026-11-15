const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("login log path, permissions, size, toggling and clear", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "remote-log-test-"));
  const module = { exports: {} };
  const opened = [];
  let changes = 0;
  let stored;
  try {
    const source = await fs.readFile(path.join(__dirname, "../src/login-log.cjs"), "utf8");
    vm.runInNewContext(source, {
      module, Buffer, process, setTimeout, clearTimeout,
      require: (id) => ({
        electron: { shell: { openPath: async (file) => { opened.push(file); return ""; } } },
        effect: { Schema: { Struct: (shape) => shape } },
        "node:os": { homedir: () => home },
      })[id] ?? require(id),
    });
    const ctx = {
      t: (key) => key,
      log: { write() {} },
      storage: { store: (_key, { initial }) => {
        stored ??= initial;
        return {
          get value() { return stored; },
          set(value) { stored = value; },
        };
      } },
    };
    const log = module.exports.createLoginLog(ctx, { onChange: () => { changes++; } });
    const original = await log.info();
    assert.equal(stored.path, "login.jsonl");
    assert.equal(original.path, path.join(home, ".opencode", "remote-access", "login.jsonl"));
    assert.equal(original.size, 0);
    await log.open();
    assert.deepEqual(opened, []);
    await assert.rejects(fs.stat(original.path), { code: "ENOENT" });
    const event = {
      ip: "192.0.2.10", timestamp: Date.now(), deviceId: "test-device", deviceLabel: "Browser",
      method: "basic", success: true, isLocal: true, password: "never-write-this-fixture-password",
    };
    log.record(event);
    await log.flush();
    assert.equal((await log.entries()).length, 1);
    assert.equal((await log.entries())[0].isLocal, true);
    if (process.platform !== "win32") assert.equal((await fs.stat(original.path)).mode & 0o777, 0o600);
    assert.equal((await log.info()).size, (await fs.stat(original.path)).size);
    assert.ok(!(await fs.readFile(original.path, "utf8")).includes(event.password));
    await log.configure({ enabled: false, path: original.path });
    assert.equal(stored.path, "login.jsonl");
    log.record(event);
    await log.flush();
    assert.equal((await log.entries()).length, 1);
    await log.open();
    assert.deepEqual(opened, [original.path]);
    await log.clear();
    assert.equal((await log.entries()).length, 0);
    assert.equal((await log.info()).size, 0);

    const ordinary = path.join(home, "keep.jsonl");
    await fs.writeFile(ordinary, "existing unrelated data\n");
    await assert.rejects(log.configure({ enabled: true, path: ordinary }), /error.logFile/);
    assert.equal(await fs.readFile(ordinary, "utf8"), "existing unrelated data\n");
    await assert.rejects(log.configure({ enabled: true, path: "relative.jsonl" }), /error.logPath/);
    const redirected = path.join(home, "configured", "sign-ins.jsonl");
    await log.configure({ enabled: true, path: redirected });
    assert.equal(stored.path, redirected);
    log.record(event);
    await log.flush();
    assert.equal((await log.info()).path, redirected);
    assert.equal((await log.entries()).length, 1);
    log.record({ ...event, method: "blocked", success: false });
    await log.flush();
    assert.equal((await log.entries()).at(-1).method, "blocked");
    assert.equal((await fs.stat(original.path)).size, 0);
    assert.ok(changes >= 4);
    stored = { enabled: false, path: original.path };
    const migrated = module.exports.createLoginLog(ctx, { onChange() {} });
    assert.equal(stored.path, "login.jsonl");
    assert.equal((await migrated.info()).path, original.path);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
