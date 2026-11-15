const { Plugin, SettingsPage } = require("@opencode/plugin/gui");
const { createComponent, createSignal, onCleanup } = require("solid-js");
const { insert } = require("solid-js/web");
const { openGateway } = require("./gateway.cjs");
const { Remote, attachMain } = require("./main.cjs");
const { openControl } = require("./control.cjs");
const { i18n } = require("./i18n.cjs");
const { pairingPreview } = require("./pairing.cjs");

exports.default = Plugin.define({
  i18n,
  main(ctx) {
    return attachMain(ctx, { openGateway, openControl });
  },

  setup(ctx) {
    const remote = ctx.main(Remote);
    const ui = ctx.ui;
    const t = (key, values) => ctx.t(key, values);
    ctx.add(SettingsPage, {
      id: "opencode-remote-access",
      get title() { return t("title"); },
      icon: "outline-globe",
      get entries() {
        return [
          { id: "listen-address", title: t("listenAddress") },
          { id: "login", title: t("credentials") },
          { id: "listener", title: t("listenerStatus") },
          { id: "allowed-sources", title: t("allowedSources") },
          { id: "login-log-file", title: t("signInLogs") },
        ];
      },
      render() {
        const [host, setHost] = createSignal("");
        const [port, setPort] = createSignal("");
        const [localPort, setLocalPort] = createSignal(0);
        const portConflict = () => localPort() > 0 && Number(port()) === localPort();
        const [username, setUsername] = createSignal("");
        const [allowedSources, setAllowedSources] = createSignal("");
        const [password, setPassword] = createSignal("");
        const [visible, setVisible] = createSignal(false);
        const [ready, setReady] = createSignal(false);
        const [busy, setBusy] = createSignal(false);
        const [error, setError] = createSignal("");
        const [pairing, setPairing] = createSignal();
        const [listener, setListener] = createSignal({ url: "", peers: [], restarting: false, restartPending: false });
        const [restartRequested, setRestartRequested] = createSignal(false);
        const [savedNotice, setSavedNotice] = createSignal("");
        const [logInfo, setLogInfo] = createSignal({ enabled: false, path: "", size: 0 });
        const [logPath, setLogPath] = createSignal("");
        const [logs, setLogs] = createSignal([]);
        const [aliases, setAliases] = createSignal([]);
        const [showLogs, setShowLogs] = createSignal(false);
        const [visibleLogs, setVisibleLogs] = createSignal(25);
        const active = () => Boolean(listener().url);
        const restarting = () => restartRequested() || listener().restarting;
        let subscribedUpdate = false;

        function updateListener(snapshot) {
          if (snapshot.url !== listener().url || snapshot.restarting) setPairing(undefined);
          setListener(snapshot);
        }
        function updateLogInfo(snapshot) {
          if (!logPath() || logPath() === logInfo().path) setLogPath(snapshot.path);
          setLogInfo(snapshot);
        }
        function subscribe(event, get, apply) {
          let updated = false;
          let mounted = true;
          const unsubscribe = remote.on(event, (value) => {
            updated = true;
            apply(value);
          });
          onCleanup(() => { mounted = false; unsubscribe(); });
          void get().then((value) => {
            if (mounted && !updated) apply(value);
          }).catch((failure) => {
            if (mounted) setError(failure.message);
          });
        }
        onCleanup(remote.on("listenerChanged", (snapshot) => {
          subscribedUpdate = true;
          updateListener(snapshot);
        }));
        subscribe("loginLogInfoChanged", () => remote.loginLogInfo(), updateLogInfo);
        subscribe("loginLogsChanged", () => remote.loginLogs(), setLogs);
        subscribe("deviceAliasesChanged", () => remote.deviceAliases(), setAliases);
        void remote.listener().then((snapshot) => {
          if (!subscribedUpdate) setListener(snapshot);
        }).catch((failure) => setError(failure.message));

        async function refresh() {
          const state = await remote.status();
          setHost(state.config.listenHost);
          setPort(state.config.listenPort ? String(state.config.listenPort) : "");
          setLocalPort(state.localPort);
          setUsername(state.config.username);
          setAllowedSources(state.config.allowedSources);
          setPassword(state.config.password);
          setError(state.configError);
        }
        void refresh().catch((failure) => setError(failure.message)).finally(() => setReady(true));

        async function act(operation) {
          if (busy()) return;
          setBusy(true);
          setError("");
          try {
            await operation();
          } catch (failure) {
            setError(failure.message || String(failure));
          } finally {
            setBusy(false);
          }
        }

        function element(tag, style, children) {
          const node = document.createElement(tag);
          node.style.cssText = style;
          insert(node, children);
          return node;
        }

        function button(label, run, disabled = () => false, variant = () => "neutral") {
          return createComponent(ui.Button, {
            size: "small",
            get children() { return typeof label === "function" ? label() : t(label); },
            get disabled() { return !ready() || busy() || disabled(); },
            get variant() { return variant(); },
            onClick: () => void act(run),
          });
        }

        function field(label, value, onInput, options = {}) {
          const input = createComponent(ui.TextInput, {
            get label() { return t(label); },
            get value() { return value(); },
            get type() { return options.type?.() || "text"; },
            get disabled() { return !ready() || busy(); },
            get placeholder() { return options.placeholder ? t(options.placeholder) : undefined; },
            onInput,
          });
          return element("div", "min-width:0;display:grid;gap:4px", [
            element("span", "color:var(--v2-text-text-muted);font-size:12px", () => t(label)),
            options.control
              ? element("div", "min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:3px", [input, options.control])
              : input,
          ]);
        }

        function row(id, title, description, children) {
          return createComponent(ui.SettingsRow, {
            id,
            get title() { return typeof title === "function" ? title() : title; },
            get description() { return typeof description === "function" ? description() : description; },
            children,
          });
        }

        const endpointControls = element("div",
          "display:grid;width:clamp(228px,42vw,370px);max-width:100%;grid-template-columns:minmax(0,3fr) minmax(66px,1fr);gap:8px;align-items:end",
          [
            field("ipAddress", host, setHost, { placeholder: "localIp" }),
            field("port", port, setPort),
          ],
        );

        const eye = createComponent(ui.IconButton, {
          size: "small",
          variant: "ghost",
          get icon() { return visible() ? "outline-eye-slash" : "outline-eye"; },
          get label() { return t(visible() ? "hidePassword" : "revealPassword"); },
          get pressed() { return visible(); },
          get disabled() { return !password(); },
          onClick: () => setVisible(!visible()),
        });
        const loginControls = element("div",
          "display:grid;width:clamp(228px,42vw,370px);max-width:100%;grid-template-columns:minmax(80px,1fr) minmax(0,1.6fr);gap:8px;align-items:end",
          [
            field("username", username, setUsername),
            field("password", password, setPassword, { type: () => visible() ? "text" : "password", control: eye }),
          ],
        );
        function configuration() {
          const listenPort = Number(port());
          if (!/^\d+$/.test(port().trim()) || listenPort < 1 || listenPort > 65535) {
            throw new Error(t("error.invalidPort"));
          }
          return {
            listenHost: host().trim(), listenPort, username: username().trim(),
            password: password(), allowedSources: allowedSources(),
          };
        }
        async function saveSettings(restart) {
          const config = configuration();
          setSavedNotice("");
          if (restart) setRestartRequested(true);
          try {
            if (restart) {
              await remote.saveAndRestart(config);
              setPairing(undefined);
            } else {
              await remote.save(config);
            }
            setVisible(false);
            updateListener(await remote.listener());
            setSavedNotice(restart ? "restartSuccess" : "saveSuccess");
          } finally {
            if (restart) setRestartRequested(false);
          }
        }
        const saveActions = element("div", "padding:12px 20px;display:flex;justify-content:flex-end;align-items:center;flex-wrap:wrap;gap:6px", [
          element("span", "margin-inline-end:auto;color:var(--v2-text-text-muted)", () => savedNotice() ? t(savedNotice()) : ""),
          button("save", () => saveSettings(false), portConflict),
          button("saveRestart", () => saveSettings(true), () => !active() || portConflict(), () => "contrast"),
        ]);

        const statusDot = element("span", "width:6px;height:6px;display:inline-block;border-radius:50%;flex:none", "");
        insert(statusDot, () => {
          statusDot.style.backgroundColor = restarting()
            ? "var(--v2-state-fg-warning, #c18118)"
            : active() ? "var(--v2-state-fg-success, #28a219)" : "var(--v2-text-text-faint, #8b8b8b)";
          return "";
        });
        const statusLabel = element("span", "display:inline-flex;align-items:center;gap:8px", [
          statusDot,
          () => t(restarting() ? "restarting" : active() ? "listening" : "stopped"),
        ]);
        statusLabel.setAttribute("role", "status");
        const actions = element("div", "display:flex;flex-wrap:wrap;align-items:center;gap:6px", [
          button(() => t(active() ? "stop" : "start"), async () => {
            if (active()) {
              await remote.stop();
              setPairing(undefined);
            } else {
              await remote.start();
            }
            updateListener(await remote.listener());
          }, restarting, () => active() ? "neutral" : "contrast"),
          button("openBrowser", () => remote.openBrowser(), () => !active() || restarting()),
          button("generateQr", async () => setPairing(await remote.pair()), () => !active() || restarting()),
        ]);
        const errorMessage = element("p", "color:var(--v2-state-fg-error, #bc322a);white-space:pre-wrap", error);
        errorMessage.setAttribute("role", "alert");

        function closeDialogButton(key, onClick, variant = "neutral") {
          return createComponent(ui.Button, {
            size: "small", variant,
            get children() { return t(key); },
            onClick,
          });
        }

        function editAlias(item) {
          ctx.dialogs.open((dialog) => {
            const [alias, setAlias] = createSignal(item.alias ?? "");
            const [dialogError, setDialogError] = createSignal("");
            const [saving, setSaving] = createSignal(false);
            async function apply(value) {
              if (saving()) return;
              setSaving(true);
              try {
                await remote.setDeviceAlias({ deviceId: item.deviceId, alias: value });
                dialog.close();
              } catch (failure) {
                setDialogError(failure.message);
              } finally {
                setSaving(false);
              }
            }
            const content = element("div", "display:grid;gap:8px;padding-block:4px", [
              createComponent(ui.TextInput, {
                get label() { return t("aliasLabel"); },
                get value() { return alias(); },
                get disabled() { return saving(); },
                onInput: setAlias,
                onSubmit: () => void apply(alias()),
              }),
              element("p", "color:var(--v2-state-fg-error)", dialogError),
            ]);
            const footer = element("div", "display:flex;justify-content:flex-end;gap:6px", [
              ...(item.alias ? [closeDialogButton("removeAlias", () => void apply(""), "danger")] : []),
              closeDialogButton("cancel", dialog.close),
              closeDialogButton("save", () => void apply(alias()), "contrast"),
            ]);
            return createComponent(ui.Dialog, {
              get title() { return t("deviceAliases"); },
              children: content,
              footer,
            });
          });
        }

        function confirmClear() {
          ctx.dialogs.open((dialog) => createComponent(ui.Dialog, {
            get title() { return t("clearLogsConfirm"); },
            get description() { return t("clearLogsDescription"); },
            footer: element("div", "display:flex;justify-content:flex-end;gap:6px", [
              closeDialogButton("cancel", dialog.close),
              closeDialogButton("clear", () => {
                dialog.close();
                void act(async () => {
                  await remote.clearLoginLogs();
                  setLogs(await remote.loginLogs());
                  updateLogInfo(await remote.loginLogInfo());
                });
              }, "danger"),
            ]),
          }));
        }

        function peerTitle(item) {
          return item.isLocal ? t("thisComputer") : item.alias || item.deviceLabel || item.ip || t("unknownDevice");
        }

        function peerDetails(item) {
          return [item.ip, item.isLocal ? item.alias : "", item.deviceLabel && item.deviceLabel !== peerTitle(item) ? item.deviceLabel : ""]
            .filter((value) => value && value !== peerTitle(item)).join(" · ");
        }

        function aliasAction(item) {
          return item.deviceId
            ? button(item.alias ? "editAlias" : "setAlias", () => editAlias(item))
            : undefined;
        }

        const setupSection = createComponent(ui.SettingsSection, {
          get title() { return t("configuration"); },
          children: [
            row("listen-address", () => t("listenAddress"), () => {
              const local = localPort();
              if (!local) return t("listenAddressHelp");
              return t(portConflict() ? "listenAddressConflict" : "listenAddressHint", { port: local });
            }, endpointControls),
            row("login", () => t("credentials"), () => t("credentialsHelp"), loginControls),
            row("allowed-sources", () => t("allowedSources"), () => t("allowedSourcesHelp"),
              element("div", "width:clamp(228px,42vw,370px);max-width:100%", createComponent(ui.TextInput, {
                get label() { return t("allowedSources"); },
                get value() { return allowedSources(); },
                get disabled() { return !ready() || busy(); },
                placeholder: "192.0.2.8, 198.51.100.0/24",
                onInput: setAllowedSources,
              }))),
            saveActions,
          ],
        });
        const listenerSection = createComponent(ui.SettingsSection, {
          get title() { return t("listener"); },
          children: [
            row("listener", statusLabel, () => {
              if (listener().restartPending) return [listener().url, t("pending")].filter(Boolean).join(" · ");
              return listener().url || (!restarting() ? t("listenerHelp") : "");
            }, actions),
            () => pairing() ? pairingPreview(pairing(), t, ui) : null,
          ],
        });
        const connectionsSection = createComponent(ui.SettingsSection, {
          get title() { return t("connections"); },
          get children() {
            const peers = listener().peers;
            return peers.length
              ? peers.map((peer) => row(undefined, () => peerTitle(peer), () => peerDetails(peer),
                element("div", "display:flex;align-items:center;flex-wrap:wrap;gap:8px", [
                  () => t(peer.count === 1 ? "connectionCountOne" : "connectionCount", { count: peer.count }),
                  aliasAction(peer),
                ])))
              : row(undefined, () => t("noConnections"), () => t("noConnectionsHelp"));
          },
        });
        const aliasesSection = createComponent(ui.SettingsSection, {
          get title() { return t("deviceAliases"); },
          get children() {
            return aliases().length
              ? aliases().map((item) => row(undefined, item.alias, item.deviceId, aliasAction(item)))
              : row(undefined, () => t("noAliases"), () => t("noAliasesHelp"));
          },
        });

        const logSwitch = createComponent(ui.Switch, {
          get label() { return t("logRecording"); },
          hideLabel: true,
          get checked() { return logInfo().enabled; },
          get disabled() { return !logInfo().path || busy(); },
          onChange: (enabled) => void act(async () => {
            await remote.configureLoginLog({ enabled, path: logInfo().path });
            updateLogInfo(await remote.loginLogInfo());
          }),
        });
        const pathControls = element("div", "width:clamp(228px,42vw,380px);max-width:100%;display:grid;gap:6px", [
          createComponent(ui.TextInput, {
            get label() { return t("logPath"); },
            get value() { return logPath(); },
            get disabled() { return !logInfo().path || busy(); },
            onInput: setLogPath,
          }),
          element("div", "display:flex;justify-content:flex-end;flex-wrap:wrap;gap:6px", [
            button("applyLogPath", async () => {
              await remote.configureLoginLog({ enabled: logInfo().enabled, path: logPath() });
              const info = await remote.loginLogInfo();
              setLogPath(info.path);
              setLogInfo(info);
            }, () => !logPath() || logPath() === logInfo().path),
            button("openLogFile", () => remote.openLoginLog(), () => !logInfo().path),
          ]),
        ]);
        const logActions = element("div", "padding:12px 20px;display:flex;justify-content:flex-end;flex-wrap:wrap;gap:6px", [
          button(() => t(showLogs() ? "hideLogs" : "viewLogs"), async () => {
            if (!showLogs()) {
              setLogs(await remote.loginLogs());
              setVisibleLogs(25);
            }
            setShowLogs(!showLogs());
          }),
          button("clearLogs", confirmClear, () => !logInfo().size),
        ]);
        const logSection = createComponent(ui.SettingsSection, {
          get title() { return t("signInLogs"); },
          children: [
            row("login-log-recording", () => t("logRecording"), () => t("logRecordingHelp"), logSwitch),
            row("login-log-file", () => t("logPath"), element("div", "display:grid;gap:4px;overflow-wrap:anywhere", [
              element("span", "user-select:text", () => logInfo().path),
              () => t("fileSize", { size: `${logInfo().size.toLocaleString(t("dateLocale"))} B` }),
            ]), pathControls),
            logActions,
            () => {
              if (!showLogs()) return null;
              const entries = logs();
              if (!entries.length) return row(undefined, () => t("noLogs"));
              return [
                ...entries.slice(0, visibleLogs()).map((item) => row(
                  undefined,
                  () => `${peerTitle(item)} · ${t(item.method === "blocked" ? "blocked" : item.success ? "success" : "rejected")}`,
                  () => [
                    new Date(item.timestamp).toLocaleString(t("dateLocale")),
                    t(item.method === "blocked" ? "methodBlocked" : item.method === "pair" ? "methodPair" : "methodBasic"),
                    peerDetails(item),
                  ].filter(Boolean).join(" · "),
                  aliasAction(item),
                )),
                entries.length > visibleLogs()
                  ? element("div", "padding:12px 20px", button("showMore", () => setVisibleLogs(visibleLogs() + 25)))
                  : null,
              ];
            },
          ],
        });

        return createComponent(ui.SettingsLayout, {
          get title() { return t("title"); },
          get description() { return t("description"); },
          children: [() => error() ? errorMessage : null, setupSection, listenerSection, connectionsSection, aliasesSection, logSection],
        });
      },
    });
  },
});
