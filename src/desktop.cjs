const { Plugin, SettingsPage } = require("@opencode/plugin/gui");
const { createComponent, createSignal, onCleanup } = require("solid-js");
const { insert } = require("solid-js/web");
const { openGateway } = require("./gateway.cjs");
const { Remote, attachMain } = require("./main.cjs");
const { openControl } = require("./control.cjs");

exports.default = Plugin.define({
  main(ctx) {
    return attachMain(ctx, { openGateway, openControl });
  },

  setup(ctx) {
    const remote = ctx.main(Remote);
    const ui = ctx.ui;
    ctx.add(SettingsPage, {
      id: "opencode-remote-access",
      title: "远程访问",
      icon: "server",
      entries: [
        { id: "listen-address", title: "监听地址" },
        { id: "login", title: "登录凭据" },
        { id: "listener", title: "监听状态" },
      ],
      render() {
        const [host, setHost] = createSignal("");
        const [port, setPort] = createSignal("");
        const [localPort, setLocalPort] = createSignal(0);
        const portConflict = () => localPort() > 0 && Number(port()) === localPort();
        const [username, setUsername] = createSignal("");
        const [password, setPassword] = createSignal("");
        const [visible, setVisible] = createSignal(false);
        const [ready, setReady] = createSignal(false);
        const [busy, setBusy] = createSignal(false);
        const [error, setError] = createSignal("");
        const [pairing, setPairing] = createSignal("");
        const [listener, setListener] = createSignal({ url: "", peers: [] });
        const active = () => Boolean(listener().url);
        let subscribedUpdate = false;

        onCleanup(remote.on("listenerChanged", (snapshot) => {
          subscribedUpdate = true;
          if (snapshot.url !== listener().url) setPairing("");
          setListener(snapshot);
        }));
        void remote.listener().then((snapshot) => {
          if (!subscribedUpdate) setListener(snapshot);
        }).catch((failure) => setError(failure.message));

        async function refresh() {
          const state = await remote.status();
          setHost(state.config.listenHost);
          setPort(state.config.listenPort ? String(state.config.listenPort) : "");
          setLocalPort(state.localPort);
          setUsername(state.config.username);
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
            get children() { return typeof label === "function" ? label() : label; },
            get disabled() { return !ready() || busy() || disabled(); },
            get variant() { return variant(); },
            onClick: () => void act(run),
          });
        }

        function field(label, value, onInput, options = {}) {
          const input = createComponent(ui.TextInput, {
            label,
            get value() { return value(); },
            get type() { return options.type?.() || "text"; },
            get disabled() { return !ready() || busy(); },
            placeholder: options.placeholder,
            onInput,
          });
          return element("div", "min-width:0;display:grid;gap:4px", [
            element("span", "color:var(--v2-text-text-muted);font-size:12px", label),
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
            field("IP 地址", host, setHost, { placeholder: "本机 IP" }),
            field("端口", port, setPort),
          ],
        );

        const eye = createComponent(ui.IconButton, {
          size: "small",
          variant: "ghost",
          get icon() { return visible() ? "outline-eye-slash" : "outline-eye"; },
          get label() { return visible() ? "隐藏密码" : "显示密码"; },
          get pressed() { return visible(); },
          get disabled() { return !password(); },
          onClick: () => setVisible(!visible()),
        });
        const loginControls = element("div",
          "display:grid;width:clamp(228px,42vw,370px);max-width:100%;grid-template-columns:minmax(80px,1fr) minmax(0,1.6fr);gap:8px;align-items:end",
          [
            field("账号", username, setUsername),
            field("密码", password, setPassword, { type: () => visible() ? "text" : "password", control: eye }),
          ],
        );
        const saveButton = button("保存设置", async () => {
          const listenPort = Number(port());
          if (!/^\d+$/.test(port().trim()) || listenPort < 1 || listenPort > 65535) {
            throw new Error("端口必须是 1 至 65535 的整数。");
          }
          await remote.save({ listenHost: host().trim(), listenPort, username: username().trim(), password: password() });
          setVisible(false);
          setPairing("");
          setListener(await remote.listener());
        }, portConflict);

        const statusDot = element("span", "width:6px;height:6px;display:inline-block;border-radius:50%;flex:none", "");
        insert(statusDot, () => {
          statusDot.style.backgroundColor = active() ? "var(--v2-state-fg-success, #28a219)" : "var(--v2-text-text-faint, #8b8b8b)";
          return "";
        });
        const statusLabel = element("span", "display:inline-flex;align-items:center;gap:8px", [
          statusDot,
          () => active() ? "正在监听" : "未监听",
        ]);
        statusLabel.setAttribute("role", "status");
        const actions = element("div", "display:flex;flex-wrap:wrap;align-items:center;gap:6px", [
          button(() => active() ? "停止监听" : "启动监听", async () => {
            if (active()) {
              await remote.stop();
              setPairing("");
            } else {
              await remote.start();
            }
            setListener(await remote.listener());
          }, () => false, () => active() ? "neutral" : "contrast"),
          button("在浏览器中打开", () => remote.openBrowser(), () => !active()),
          button("生成配对二维码", async () => setPairing(await remote.pair()), () => !active()),
        ]);
        const errorMessage = element("p", "color:var(--v2-state-fg-error, #bc322a);white-space:pre-wrap", error);
        errorMessage.setAttribute("role", "alert");

        const setupSection = createComponent(ui.SettingsSection, {
          title: "配置",
          children: [
            row("listen-address", "监听地址", () => {
              if (!localPort()) return "填写本机网络接口的 IP 地址和端口。";
              if (portConflict()) return `端口 ${localPort()} 已由桌面服务使用，请换一个端口。`;
              return `桌面服务端口 ${localPort()}，请为远程入口选择其他端口。`;
            }, endpointControls),
            row("login", "登录凭据", "监听中保存设置会重新打开远程入口，远程设备需重新登录。", loginControls),
          ],
        });
        const listenerSection = createComponent(ui.SettingsSection, {
          title: "监听",
          get footer() { return error() ? errorMessage : undefined; },
          children: [
            row("listener", statusLabel, () => listener().url || "启动后可从能访问此地址的设备连接。", actions),
            () => pairing() ? pairingPreview(pairing()) : null,
          ],
        });
        const connectionSection = createComponent(ui.SettingsSection, {
          title: "当前连接",
          get children() {
            const peers = listener().peers;
            return peers.length
              ? peers.map(({ ip, count }) => row(undefined, ip, undefined, `${count} 个连接`))
              : row(undefined, "暂无连接", "连接建立后会按来源 IP 显示在这里。");
          },
        });

        return createComponent(ui.SettingsLayout, {
          title: "远程访问",
          description: "管理远程监听、登录凭据与实时连接。",
          actions: saveButton,
          children: [setupSection, listenerSection, connectionSection],
        });
      },
    });
  },
});

function pairingPreview(output) {
  const block = document.createElement("div");
  block.style.cssText = "padding:16px 20px;display:grid;gap:8px;overflow-wrap:anywhere;user-select:text";
  const link = output.match(/https?:\/\/[^\s]+\/auth\/connect\/[^\s]+/)?.[0];
  const rows = output.split(/\r?\n/).filter((line) => /^[ █▀▄]+$/.test(line) && /[█▀▄]/.test(line));
  if (!rows.length) {
    block.textContent = output;
    return block;
  }

  const scale = 5;
  const margin = 4;
  const canvas = document.createElement("canvas");
  canvas.width = (Math.max(...rows.map((line) => line.length)) + margin * 2) * scale;
  canvas.height = (rows.length * 2 + margin * 2) * scale;
  canvas.setAttribute("aria-label", "OpenCode 配对二维码");
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  rows.forEach((line, y) => Array.from(line).forEach((pixel, x) => {
    if (pixel === "█" || pixel === "▀") context.fillRect((x + margin) * scale, (y * 2 + margin) * scale, scale, scale);
    if (pixel === "█" || pixel === "▄") context.fillRect((x + margin) * scale, (y * 2 + margin + 1) * scale, scale, scale);
  }));
  const note = document.createElement("p");
  note.textContent = "用 OpenCode App 扫码，或在远程浏览器打开一次性链接。有效期 5 分钟。";
  block.append(canvas, note);
  if (link) {
    const text = document.createElement("p");
    text.textContent = link;
    block.append(text);
  }
  return block;
}
