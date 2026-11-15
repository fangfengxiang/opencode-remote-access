const { shell } = require("electron");
const { Ipc } = require("@opencode/plugin/gui");
const { Schema } = require("effect");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Buffer } = require("node:buffer");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const configuration = Schema.Struct({
  listenHost: Schema.String,
  listenPort: Schema.Number,
  username: Schema.String,
  password: Schema.String,
});
const listenerState = Schema.Struct({
  url: Schema.String,
  peers: Schema.Array(Schema.Struct({ ip: Schema.String, count: Schema.Number })),
});
const Remote = Ipc.define({
  id: "opencode-remote-access",
  events: { listenerChanged: listenerState },
  methods: {
    listener: { output: listenerState },
    status: { output: Schema.Struct({
      config: configuration,
      localPort: Schema.Number,
      url: Schema.String,
      configError: Schema.String,
    }) },
    save: { input: configuration },
    start: {},
    stop: {},
    openBrowser: {},
    pair: { output: Schema.String },
  },
});

const blankConfig = { listenHost: "", listenPort: 0, username: "", password: "" };
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

function validate(config) {
  const { listenHost, listenPort, username, password } = config;
  if (!net.isIPv4(listenHost) || listenHost === "0.0.0.0") {
    throw new Error("请输入要监听的具体 IPv4 地址。");
  }
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error("端口须为 1 到 65535 的整数。");
  }
  if (!username.trim() || username.includes(":") || controlCharacters.test(username)) {
    throw new Error("账号不能为空，且不能包含冒号或控制字符。");
  }
  if (!password.trim() || controlCharacters.test(password)) {
    throw new Error("密码不能为空，且不能包含控制字符。");
  }
  if (Buffer.byteLength(username) > 256 || Buffer.byteLength(password) > 1024) {
    throw new Error("账号和密码分别不能超过 256 字节和 1024 字节。");
  }
  return { listenHost, listenPort, username, password };
}

function attachMain(ctx, { openGateway, openControl }) {
  const configPath = path.join(os.homedir(), ".opencode", "remote.json");
  const run = promisify(execFile);
  let active;
  let controlLease;
  let pending = Promise.resolve();
  let disposing = false;

  const serial = (operation) => (...args) => {
    const result = pending.then(() => {
      if (disposing) throw new Error("远程访问插件正在关闭。");
      return operation(...args);
    });
    pending = result.catch(() => {});
    return result;
  };

  async function writeRemote(config) {
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, configPath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async function load() {
    let config;
    try {
      const metadata = await fs.lstat(configPath);
      if (!metadata.isFile()) throw new Error("remote.json 必须是普通文件。");
      if (metadata.mode & 0o077) await fs.chmod(configPath, 0o600);
      config = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { ...blankConfig };
      throw error;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("remote.json 必须包含一个配置对象。");
    }
    const values = {
      listenHost: config.listenHost ?? blankConfig.listenHost,
      listenPort: config.listenPort ?? blankConfig.listenPort,
      username: config.username ?? blankConfig.username,
      password: config.password ?? blankConfig.password,
    };
    if (typeof values.listenHost !== "string" || !Number.isInteger(values.listenPort) ||
        typeof values.username !== "string" || typeof values.password !== "string") {
      throw new Error("remote.json 的字段类型无效。");
    }
    return values;
  }

  function listener() {
    return active ? { url: active.gateway.url, peers: active.gateway.peers() } : { url: "", peers: [] };
  }

  function notifyListener() {
    if (!disposing) provider.emit("listenerChanged", listener());
  }

  function currentSidecar() {
    const endpoint = ctx.serverEndpoints.get("sidecar");
    if (!endpoint?.sameMachine || !endpoint.url) return undefined;
    const url = new URL(endpoint.url);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return { endpoint, port };
  }

  function checkRemotePort(config, sidecar) {
    if (config.listenPort === sidecar?.port) {
      throw new Error(`远程监听端口不能与桌面服务端口 ${sidecar.port} 相同。`);
    }
  }

  async function bindGateway(config) {
    const sidecar = currentSidecar();
    checkRemotePort(config, sidecar);
    if (!sidecar) throw new Error("OpenCode 本机服务尚未就绪。");

    const assigned = Object.values(os.networkInterfaces()).some((addresses) => addresses?.some(
      (address) => address.address === config.listenHost,
    ));
    if (!assigned) throw new Error("监听地址不在本机网卡上，请检查 VPN 或网络配置。");

    let bound;
    try {
      const gateway = await openGateway({
        host: config.listenHost,
        port: config.listenPort,
        username: config.username,
        password: config.password,
        upstreamUrl: sidecar.endpoint.url,
        upstreamHeaders: sidecar.endpoint.headers ?? {},
        onChange: () => {
          if (bound && active === bound) notifyListener();
        },
      });
      bound = { gateway, config };
      return bound;
    } catch (error) {
      if (error.code === "EADDRINUSE") throw new Error(`端口 ${config.listenPort} 已被占用，请选择其他端口。`);
      if (error.code === "EADDRNOTAVAIL") throw new Error("监听地址当前不可用，请检查 VPN 或网络配置。");
      if (error.code === "EACCES") throw new Error(`没有权限监听端口 ${config.listenPort}。`);
      throw error;
    }
  }

  async function start(config) {
    if (active) return;
    active = await bindGateway(validate(config));
    notifyListener();
  }

  async function closeGateway() {
    if (!active) return;
    const current = active;
    active = undefined;
    try {
      await current.gateway.close();
    } finally {
      notifyListener();
    }
  }

  async function stop() {
    controlLease = undefined;
    await closeGateway();
  }

  async function save(input) {
    const next = validate(input);
    checkRemotePort(next, currentSidecar());
    const previous = active;
    const changed = previous && Object.keys(next).some((key) => next[key] !== previous.config[key]);
    if (!changed) {
      await writeRemote(next);
      return;
    }

    // Bind a different endpoint before retiring the active gateway.
    if (previous.config.listenHost !== next.listenHost || previous.config.listenPort !== next.listenPort) {
      const replacement = await bindGateway(next);
      try {
        await writeRemote(next);
      } catch (error) {
        await replacement.gateway.close();
        throw error;
      }
      active = replacement;
      notifyListener();
      await previous.gateway.close();
      return;
    }

    try {
      await closeGateway();
      await start(next);
      await writeRemote(next);
    } catch (error) {
      try {
        await closeGateway();
        await start(previous.config);
      } catch {
        controlLease = undefined;
        throw new Error("保存失败，原监听也未能自动恢复。请检查网络和端口后重新启动监听。");
      }
      throw error;
    }
  }

  async function pair() {
    if (!active) throw new Error("请先启动远程监听。");
    const { gateway } = active;
    try {
      const [binary, ...prefix] = ctx.cli.command;
      const { stdout } = await run(binary, [...prefix, "pair", "--url", gateway.url], {
        timeout: 15000,
        signal: ctx.signal,
      });
      const output = stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd();
      for (const candidate of output.match(/https?:\/\/[^\s]+/gu) ?? []) {
        const url = new URL(candidate);
        const code = /^\/auth\/connect\/([A-Za-z0-9_-]{22})$/.exec(url.pathname)?.[1];
        if (url.origin === gateway.url && code && !url.search && !url.hash) {
          gateway.allowPairing(code);
          return output;
        }
      }
    } catch {
      throw new Error("无法生成配对码，请检查 OpenCode 本机服务。");
    }
    throw new Error("OpenCode 返回的配对链接与当前监听地址不匹配。");
  }

  const provider = ctx.provide(Remote, {
    listener,
    status: serial(async () => {
      const { url } = listener();
      const localPort = currentSidecar()?.port ?? 0;
      try {
        return { config: await load(), localPort, url, configError: "" };
      } catch {
        return { config: { ...blankConfig }, localPort, url, configError: "无法读取 remote.json，请检查配置或重新保存。" };
      }
    }),
    save: serial(save),
    start: serial(async () => { if (!active) await start(await load()); }),
    stop: serial(stop),
    openBrowser: serial(async () => {
      const { url } = listener();
      if (!url) throw new Error("请先启动远程监听。");
      await shell.openExternal(url);
    }),
    pair: serial(pair),
  });

  const control = openControl && Promise.resolve().then(() => openControl({
    listener,
    start: serial(async () => {
      if (active) return { snapshot: listener() };
      await start(await load());
      controlLease = randomUUID();
      return { snapshot: listener(), lease: controlLease };
    }),
    stop: serial(async (lease) => {
      if (lease && lease === controlLease) await stop();
    }),
    pair: serial(pair),
    credentials: serial(async () => {
      const { username, password } = active?.config ?? await load();
      return { username, password };
    }),
  })).catch(() => {
    if (!disposing) ctx.log.write("warn", "OpenCode Remote Access terminal control unavailable");
  });

  ctx.log.write("info", "OpenCode Remote Access gateway loaded");
  return async () => {
    disposing = true;
    await Promise.allSettled([control?.then((close) => close?.()), pending.then(stop)]);
  };
}

module.exports = { Remote, attachMain };
