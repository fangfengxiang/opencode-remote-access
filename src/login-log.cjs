const { shell } = require("electron");
const { Schema } = require("effect");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const HEADER = '{"format":"opencode-remote-access/login-v1"}\n';
const ENTRY_LIMIT = 500;
const FILE_LIMIT = 1024 * 1024;
const BATCH_LIMIT = 128;
const defaultLogPath = "login.jsonl";

function normalize(entry) {
  if (!entry || !Number.isSafeInteger(entry.timestamp) || !net.isIP(entry.ip) ||
      !["basic", "pair", "blocked"].includes(entry.method) || typeof entry.success !== "boolean") {
    return undefined;
  }
  return {
    timestamp: entry.timestamp,
    ip: entry.ip,
    deviceId: /^[A-Za-z0-9_-]{0,128}$/.test(entry.deviceId ?? "") ? (entry.deviceId ?? "") : "",
    deviceLabel: String(entry.deviceLabel ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 160),
    isLocal: Boolean(entry.isLocal ?? entry.local),
    method: entry.method,
    success: entry.success,
  };
}

function createLoginLog(ctx, { onChange }) {
  const directory = path.join(os.homedir(), ".opencode", "remote-access");
  const defaultFile = path.resolve(directory, defaultLogPath);
  const settings = ctx.storage.store("login-log-settings", {
    schema: Schema.Struct({ enabled: Schema.Boolean, path: Schema.String }),
    initial: { enabled: true, path: defaultLogPath },
  });
  if (settings.value.path === defaultFile) {
    try {
      settings.set({ ...settings.value, path: defaultLogPath });
    } catch {
      ctx.log.write("warn", "Remote access could not normalize the saved login log path");
    }
  }
  const selectedFile = () => path.resolve(directory, settings.value.path);
  let queue = Promise.resolve();
  let timer;
  let pending = [];

  const error = (key) => new Error(ctx.t(key));
  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  function safeFile(stat) {
    return stat.isFile() && stat.nlink === 1 &&
      (typeof process.getuid !== "function" || stat.uid === process.getuid());
  }

  async function read(file) {
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!safeFile(stat)) throw error("error.logFile");
      if (stat.size > FILE_LIMIT) throw error("error.logTooLarge");
      const bytes = await handle.readFile();
      if (!bytes.length) return { exists: true, entries: [] };
      if (bytes.length > FILE_LIMIT) throw error("error.logTooLarge");
      const text = bytes.toString("utf8");
      if (!text.startsWith(HEADER)) throw error("error.logFile");
      if (stat.mode & 0o077) await handle.chmod(0o600);
      const entries = [];
      for (const line of text.slice(HEADER.length).split("\n")) {
        if (!line) continue;
        try {
          const event = normalize(JSON.parse(line));
          if (event) entries.push(event);
        } catch {}
      }
      return { exists: true, entries: entries.slice(-ENTRY_LIMIT) };
    } catch (failure) {
      if (failure.code === "ENOENT") return { exists: false, entries: [] };
      if (failure.code) throw error("error.logFile");
      throw failure;
    } finally {
      await handle?.close();
    }
  }

  async function write(file, entries, exists) {
    const content = entries.length ? HEADER + entries.map((entry) => JSON.stringify(entry) + "\n").join("") : "";
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(file), `.opencode-log-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      if (exists) {
        const current = await fs.lstat(file);
        if (!safeFile(current)) throw error("error.logFile");
        await fs.rename(temporary, file);
      } else {
        // Linking into place avoids replacing a file created after the initial check.
        await fs.link(temporary, file);
      }
    } catch (failure) {
      if (failure.code) throw error("error.logSave");
      throw failure;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (!pending.length) return queue;
    const events = pending;
    pending = [];
    return enqueue(async () => {
      const file = selectedFile();
      const batch = events.filter((item) => item.file === file).map((item) => item.event);
      if (!batch.length) return;
      const current = await read(file);
      await write(file, [...current.entries, ...batch].slice(-ENTRY_LIMIT), current.exists);
      onChange();
    });
  }

  return {
    entries: () => enqueue(async () => (await read(selectedFile())).entries),
    info: () => enqueue(async () => {
      const file = selectedFile();
      const stat = await fs.lstat(file).catch(() => undefined);
      return { enabled: settings.value.enabled, path: file, size: stat && safeFile(stat) ? stat.size : 0 };
    }),
    async configure(next) {
      if (!path.isAbsolute(next.path) || next.path.includes("\0")) throw error("error.logPath");
      const file = path.normalize(next.path);
      await flush().catch(() => ctx.log.write("warn", "Remote access login log write failed"));
      return enqueue(async () => {
        await read(file);
        settings.set({ enabled: next.enabled, path: file === defaultFile ? defaultLogPath : file });
        onChange();
      });
    },
    open: () => enqueue(async () => {
      const file = selectedFile();
      const current = await read(file);
      if (!current.entries.length) return;
      if (await shell.openPath(file)) throw error("error.logOpen");
      onChange();
    }),
    async clear() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = [];
      return enqueue(async () => {
        const file = selectedFile();
        const current = await read(file);
        if (current.exists) await write(file, [], true);
        onChange();
      });
    },
    record(event) {
      const current = settings.value;
      if (!current.enabled) return;
      const entry = normalize(event);
      if (!entry) return;
      if (pending.length === BATCH_LIMIT) pending.shift();
      pending.push({ file: selectedFile(), event: entry });
      if (!timer) {
        timer = setTimeout(() => {
          void flush().catch(() => ctx.log.write("warn", "Remote access login log write failed"));
        }, 175);
      }
    },
    flush,
  };
}

module.exports = { createLoginLog };
