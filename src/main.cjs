const { dialog, shell } = require("electron");
const { Ipc } = require("@opencode/plugin/gui");
const { Schema } = require("effect");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { Buffer } = require("node:buffer");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createLoginLog } = require("./login-log.cjs");
const { sourceFilter } = require("./source-filter.cjs");
const { defaultHttps, validateHttps, listenerTls } = require("./tls.cjs");

const connectionFields = {
  listenHost: Schema.String,
  listenPort: Schema.Number,
  username: Schema.String,
  password: Schema.String,
  allowedSources: Schema.String,
};
const connection = Schema.Struct(connectionFields);
const httpsSettings = Schema.Struct({
  enabled: Schema.Boolean,
  hostname: Schema.String,
  certificatePath: Schema.String,
  keyPath: Schema.String,
});
const configuration = Schema.Struct({ ...connectionFields, https: httpsSettings });
const deviceFields = {
  ip: Schema.String,
  deviceId: Schema.String,
  deviceLabel: Schema.String,
  isLocal: Schema.Boolean,
};
const aliasFields = {
  deviceId: Schema.String,
  alias: Schema.String,
};
const eventFields = {
  ...deviceFields,
  timestamp: Schema.Number,
  method: Schema.String,
  success: Schema.Boolean,
};
const listenerState = Schema.Struct({
  url: Schema.String,
  peers: Schema.Array(Schema.Struct({ ...deviceFields, count: Schema.Number, alias: Schema.String })),
  restarting: Schema.Boolean,
  restartPending: Schema.Boolean,
  generatedCertificatePath: Schema.String,
});
const loginLogs = Schema.Array(Schema.Struct({ ...eventFields, alias: Schema.String }));
const deviceAliases = Schema.Array(Schema.Struct(aliasFields));
const loginLogSettings = { enabled: Schema.Boolean, path: Schema.String };
const loginLogInfo = Schema.Struct({ ...loginLogSettings, size: Schema.Number });
const Remote = Ipc.define({
  // Desktop caches window methods by IPC ID across plugin reloads.
  id: "opencode-remote-access.v2",
  events: {
    listenerChanged: listenerState,
    loginLogsChanged: loginLogs,
    loginLogInfoChanged: loginLogInfo,
    deviceAliasesChanged: deviceAliases,
  },
  methods: {
    listener: { output: listenerState },
    status: { output: Schema.Struct({
      config: configuration,
      localPort: Schema.Number,
      url: Schema.String,
      configError: Schema.String,
      restartPending: Schema.Boolean,
    }) },
    save: { input: connection },
    saveAndRestart: { input: connection },
    configureHttps: { input: httpsSettings, output: httpsSettings },
    pickHttpsFile: { input: Schema.String, output: Schema.String },
    start: {},
    stop: {},
    openBrowser: {},
    pair: { output: Schema.Struct({ output: Schema.String, expiresAt: Schema.Number }) },
    loginLogs: { output: loginLogs },
    clearLoginLogs: {},
    loginLogInfo: { output: loginLogInfo },
    configureLoginLog: { input: Schema.Struct(loginLogSettings) },
    openLoginLog: {},
    deviceAliases: { output: deviceAliases },
    setDeviceAlias: { input: Schema.Struct(aliasFields) },
  },
});

const blankConfig = { listenHost: "", listenPort: 0, username: "", password: "", allowedSources: "", https: defaultHttps };
const aliasLimit = 300;
const deviceIdPattern = /^[A-Za-z0-9_-]{22}$/u;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

function validate(config, error) {
  const { listenHost, listenPort, username, password, allowedSources } = config;
  if (!net.isIPv4(listenHost) || listenHost === "0.0.0.0") {
    throw error("error.invalidIp");
  }
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw error("error.invalidPort");
  }
  if (!username.trim() || username.includes(":") || controlCharacters.test(username)) {
    throw error("error.invalidUsername");
  }
  if (!password.trim() || controlCharacters.test(password)) {
    throw error("error.invalidPassword");
  }
  if (Buffer.byteLength(username) > 256 || Buffer.byteLength(password) > 1024) {
    throw error("error.credentialsTooLong");
  }
  try {
    sourceFilter(allowedSources);
  } catch {
    throw error("error.allowlist");
  }
  return {
    listenHost, listenPort, username, password,
    allowedSources: allowedSources.trim(),
    https: validateHttps(config.https, error),
  };
}

function attachMain(ctx, { openGateway, openControl }) {
  const configPath = path.join(os.homedir(), ".opencode", "remote.json");
  const tlsDirectory = path.join(path.dirname(configPath), "remote-access", "tls");
  const run = promisify(execFile);
  const problem = (key, values) => new Error(ctx.t(key, values));
  const deviceKeyStore = ctx.storage.store("device-key", { schema: Schema.String, initial: "" });
  if (!deviceKeyStore.value) deviceKeyStore.set(randomBytes(32).toString("base64url"));
  const aliasesStore = ctx.storage.store("device-aliases", { schema: deviceAliases, initial: [] });
  let provider;
  let loginLogRevision = 0;
  const loginLog = createLoginLog(ctx, { onChange: () => void notifyLoginLogChanges() });
  let active;
  let savedConfig;
  let restarting = false;
  let controlLease;
  let pending = Promise.resolve();
  let disposing = false;

  const serial = (operation) => (...args) => {
    const result = pending.then(() => {
      if (disposing) throw problem("error.pluginClosing");
      return operation(...args);
    });
    pending = result.catch(() => {});
    return result;
  };

  async function writeRemote(config) {
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, configPath);
    } catch {
      throw problem("error.saveFailed");
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    savedConfig = config;
  }

  async function load() {
    let config;
    try {
      const metadata = await fs.lstat(configPath);
      if (!metadata.isFile()) throw new Error("remote.json 必须是普通文件。");
      if (metadata.mode & 0o077) await fs.chmod(configPath, 0o600);
      config = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return (savedConfig = { ...blankConfig });
      }
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
      allowedSources: config.allowedSources ?? blankConfig.allowedSources,
      https: validateHttps(config.https, problem),
    };
    if (typeof values.listenHost !== "string" || !Number.isInteger(values.listenPort) ||
        typeof values.username !== "string" || typeof values.password !== "string" ||
        typeof values.allowedSources !== "string") {
      throw new Error("remote.json 的字段类型无效。");
    }
    savedConfig = values;
    return values;
  }

  function pendingRestart() {
    return Boolean(active && savedConfig &&
      (Object.keys(connectionFields).some((key) => savedConfig[key] !== active.config[key]) ||
        Object.keys(defaultHttps).some((key) => savedConfig.https[key] !== active.config.https[key])));
  }

  function displayDevice(device, host) {
    const deviceId = device.deviceId || "";
    return {
      ip: device.ip,
      deviceId,
      deviceLabel: device.deviceLabel || "",
      isLocal: Boolean(device.local || device.ip === host),
      alias: aliasesStore.value.find((entry) => entry.deviceId === deviceId)?.alias || "",
    };
  }

  function listener() {
    return {
      url: active?.gateway.url || "",
      peers: active?.gateway.peers().map((device) => ({
        ...displayDevice(device, active.config.listenHost),
        count: device.count,
      })) || [],
      restarting,
      restartPending: pendingRestart(),
      generatedCertificatePath: active?.tls?.generatedCertificatePath || "",
    };
  }

  async function listLoginLogs() {
    const events = await loginLog.entries();
    const labels = new Map(aliasesStore.value.map(({ deviceId, alias }) => [deviceId, alias]));
    return events.map(({ timestamp, ip, deviceId, deviceLabel, local, isLocal, method, success }) => ({
      timestamp, ip, deviceId, deviceLabel, isLocal: Boolean(local ?? isLocal), method, success,
      alias: labels.get(deviceId) || "",
    })).reverse();
  }

  async function notifyLoginLogChanges() {
    if (!provider || disposing) return;
    const revision = ++loginLogRevision;
    try {
      const [entries, info] = await Promise.all([listLoginLogs(), loginLog.info()]);
      if (disposing || revision !== loginLogRevision) return;
      provider.emit("loginLogsChanged", entries);
      provider.emit("loginLogInfoChanged", info);
    } catch {
      ctx.log.write("warn", "OpenCode Remote Access failed to refresh login logs");
    }
  }

  function recordLogin(event, host) {
    const { timestamp, method, success } = event;
    if (disposing || !Number.isFinite(timestamp) || !["basic", "pair", "blocked"].includes(method) ||
        typeof success !== "boolean" || !net.isIP(event.ip)) return;
    const { ip, deviceId, deviceLabel, isLocal } = displayDevice(event, host);
    try {
      loginLog.record({ timestamp, ip, deviceId, deviceLabel, isLocal, method, success });
    } catch {
      ctx.log.write("warn", "OpenCode Remote Access failed to store a login event");
    }
  }

  function setDeviceAlias({ deviceId, alias }) {
    if (!deviceIdPattern.test(deviceId)) throw problem("error.invalidDeviceId");
    const value = alias.trim();
    if (value.length > 80 || controlCharacters.test(value)) throw problem("error.invalidDeviceAlias");
    const entries = aliasesStore.value.filter((entry) => entry.deviceId !== deviceId);
    if (value) {
      if (entries.length >= aliasLimit) throw problem("error.aliasLimit");
      entries.push({ deviceId, alias: value });
    }
    try {
      aliasesStore.set(entries);
    } catch {
      throw problem("error.aliasSaveFailed");
    }
    provider.emit("deviceAliasesChanged", aliasesStore.value);
    notifyListener();
    void notifyLoginLogChanges();
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
      throw problem("error.portConflict", { port: sidecar.port });
    }
  }

  async function bindGateway(config, tls) {
    const sidecar = currentSidecar();
    checkRemotePort(config, sidecar);
    if (!sidecar) throw problem("error.sidecarNotReady");

    const assigned = Object.values(os.networkInterfaces()).some((addresses) => addresses?.some(
      (address) => address.address === config.listenHost,
    ));
    if (!assigned) throw problem("error.ipNotAssigned");

    let bound;
    try {
      const gateway = await openGateway({
        host: config.listenHost,
        port: config.listenPort,
        username: config.username,
        password: config.password,
        allowedSources: config.allowedSources,
        upstreamUrl: sidecar.endpoint.url,
        upstreamHeaders: sidecar.endpoint.headers ?? {},
        tls,
        deviceKey: deviceKeyStore.value,
        onLogin: (event) => {
          if (bound && active === bound) recordLogin(event, config.listenHost);
        },
        onChange: () => {
          if (bound && active === bound) notifyListener();
        },
      });
      bound = { gateway, config, tls };
      return bound;
    } catch (error) {
      if (error.code === "EADDRINUSE") throw problem("error.portInUse", { port: config.listenPort });
      if (error.code === "EADDRNOTAVAIL") throw problem("error.ipUnavailable");
      if (error.code === "EACCES") throw problem("error.portPermission", { port: config.listenPort });
      throw problem("error.startFailed");
    }
  }

  function prepareTls(config) {
    return listenerTls(config.https, config.listenHost, tlsDirectory, problem, ctx.signal);
  }

  async function start(config) {
    if (active) return;
    const next = validate(config, problem);
    checkRemotePort(next, currentSidecar());
    active = await bindGateway(next, await prepareTls(next));
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

  async function withSavedHttps(input) {
    const stored = await load().catch(() => savedConfig ?? active?.config ?? blankConfig);
    const next = validate({ ...input, https: stored.https }, problem);
    checkRemotePort(next, currentSidecar());
    return next;
  }

  async function save(input) {
    const next = await withSavedHttps(input);
    await writeRemote(next);
    notifyListener();
  }

  async function replaceListener(stored, next) {
    const previous = active;
    if (!previous) {
      await writeRemote(stored);
      notifyListener();
      return;
    }

    restarting = true;
    notifyListener();
    try {
      const tls = await prepareTls(next);
      if (previous.config.listenHost !== next.listenHost || previous.config.listenPort !== next.listenPort) {
        // Validate the replacement binding before disturbing the active endpoint.
        const replacement = await bindGateway(next, tls);
        try {
          await writeRemote(stored);
        } catch (error) {
          await replacement.gateway.close();
          throw error;
        }
        active = replacement;
        await previous.gateway.close();
        return;
      }

      try {
        await closeGateway();
        active = await bindGateway(next, tls);
        await writeRemote(stored);
      } catch (error) {
        try {
          await closeGateway();
          active = await bindGateway(previous.config, previous.tls);
        } catch {
          controlLease = undefined;
          throw problem("error.restoreFailed");
        }
        throw error;
      }
    } finally {
      restarting = false;
      notifyListener();
    }
  }

  async function saveAndRestart(input) {
    const next = await withSavedHttps(input);
    await replaceListener(next, next);
  }

  async function configureHttps(input) {
    const https = validateHttps(input, problem);
    const stored = await load().catch(() => { throw problem("error.configRead"); });
    const nextSaved = { ...stored, https };
    if (!active || (!https.enabled && !active.config.https.enabled)) {
      if (https.enabled && https.certificatePath) await prepareTls(nextSaved);
      await writeRemote(nextSaved);
      if (active) active.config = { ...active.config, https };
      notifyListener();
    } else {
      await replaceListener(nextSaved, { ...active.config, https });
    }
    return https;
  }

  async function pickHttpsFile(kind) {
    if (kind !== "certificate" && kind !== "key") throw problem("error.httpsSettings");
    try {
      const selection = await dialog.showOpenDialog({
        title: ctx.t(kind === "certificate" ? "httpsCertificatePath" : "httpsKeyPath"),
        properties: ["openFile"],
        filters: [
          { name: "PEM", extensions: ["pem", "crt", "key", "cert"] },
          { name: ctx.t("httpsAllFiles"), extensions: ["*"] },
        ],
      });
      return selection.canceled ? "" : selection.filePaths[0] || "";
    } catch {
      throw problem("error.httpsFilePicker");
    }
  }

  async function pair() {
    if (!active) throw problem("error.listenerStopped");
    const { gateway } = active;
    try {
      const [binary, ...prefix] = ctx.cli.command;
      const { stdout } = await run(binary, [...prefix, "pair", "--url", gateway.url], {
        timeout: 15000,
        signal: ctx.signal,
      });
      const output = stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd();
      for (const candidate of output.match(/https?:\/\/[^\s]+/gu) ?? []) {
        let url;
        try {
          url = new URL(candidate);
        } catch {
          continue;
        }
        const code = /^\/auth\/connect\/([A-Za-z0-9_-]{22})$/.exec(url.pathname)?.[1];
        if (url.origin === gateway.url && code && !url.search && !url.hash) {
          const expiresAt = gateway.allowPairing(code);
          return { output, expiresAt, link: url.href };
        }
      }
    } catch {
      throw problem("error.pairFailed");
    }
    throw problem("error.pairAddressMismatch");
  }

  provider = ctx.provide(Remote, {
    listener,
    status: serial(async () => {
      const { url } = listener();
      const localPort = currentSidecar()?.port ?? 0;
      try {
        const config = await load();
        return { config, localPort, url, configError: "", restartPending: pendingRestart() };
      } catch {
        return {
          config: { ...blankConfig }, localPort, url,
          configError: ctx.t("error.configRead"), restartPending: pendingRestart(),
        };
      }
    }),
    save: serial(save),
    saveAndRestart: serial(saveAndRestart),
    configureHttps: serial(configureHttps),
    pickHttpsFile: serial(pickHttpsFile),
    start: serial(async () => { if (!active) await start(await load()); }),
    stop: serial(stop),
    openBrowser: serial(async () => {
      const { link } = await pair();
      try {
        await shell.openExternal(link);
      } catch {
        throw problem("error.browserFailed");
      }
    }),
    pair: serial(async () => {
      const { output, expiresAt } = await pair();
      return { output, expiresAt };
    }),
    loginLogs: listLoginLogs,
    loginLogInfo: () => loginLog.info(),
    configureLoginLog: serial(async (options) => { await loginLog.configure(options); }),
    openLoginLog: serial(async () => { await loginLog.open(); }),
    clearLoginLogs: serial(async () => {
      await loginLog.clear();
      active?.gateway.clearLoginDebounce?.();
    }),
    deviceAliases: () => aliasesStore.value,
    setDeviceAlias: serial(setDeviceAlias),
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
    pair: serial(async () => (await pair()).output),
    credentials: serial(async () => {
      const { username, password } = active?.config ?? await load();
      return { username, password };
    }),
  })).catch(() => {
    if (!disposing) ctx.log.write("warn", "OpenCode Remote Access terminal control unavailable");
  });

  ctx.log.write("info", "OpenCode Remote Access HTTPS settings loaded");
  return async () => {
    disposing = true;
    await Promise.allSettled([
      control?.then((close) => close?.()),
      pending.then(stop),
      Promise.resolve().then(() => loginLog.flush()),
    ]);
  };
}

module.exports = { Remote, attachMain };
