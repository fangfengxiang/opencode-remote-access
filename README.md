# OpenCode 远程访问

**简体中文** · [English](README.en.md)

在 **OpenCode Desktop → 设置 → 远程访问**中管理监听地址、远程登录和设备。插件提供 HTTP 或 HTTPS Web 入口，支持密码登录、一次性配对和登录日志。设置页使用 OpenCode 原生组件，自动跟随桌面端语言，支持简体中文、繁體中文、English 和 Русский。

![远程访问设置页简体中文示例，密码已遮挡](docs/remote-access.png)

## 安装与更新

使用支持 GUI 插件的 OpenCode Desktop 稳定版。安装后打开桌面端，在 **设置 → 远程访问**中找到插件。

```bash
opencode plugin add github:fangfengxiang/opencode-remote-access
```

更新已有安装时，OpenCode v2.3.0 无参数命令会更新所有可更新的插件。

```bash
opencode plugin update
```

从本地开发目录切换到 GitHub 安装时，先在 OpenCode 全局插件配置中移除本地目录条目。

## 使用

1. 选择客户端可访问的本机 IPv4 地址。使用 Tailscale 时，可用 `tailscale ip -4` 查看。
2. 填写监听端口、用户名和密码。远程端口需要与桌面服务端口不同。
3. 可选填写 **来源 IP 白名单**。支持单个 IP 和 CIDR 网段，用逗号或空格分隔。留空允许所有来源，同机浏览器也按白名单校验。
4. 点击 **保存**，然后 **启动监听**。监听运行期间，**保存**会把变更留到下次启动，**保存并重启**会立即应用。
5. 点击 **在浏览器中打开**，浏览器用一次性链接自动登录。也可生成配对二维码。相机模式打开浏览器链接，OpenCode App 模式提供原生二维码。配对链接有效期为 5 分钟。

改动远程监听会使旧配对会话失效。桌面端使用它自己的本机服务。配置保存在用户目录下的 `~/.opencode/remote.json`。

## HTTPS

在 **监听 → HTTPS** 开关启用。已有监听会重新启动，浏览器按钮和配对链接随之使用 HTTPS。

- **自动证书**。证书和私钥两项留空时，插件通过系统 PATH 中的 OpenSSL 生成自签名证书。开启后设置页会显示公钥证书路径，供客户端信任。证书需要得到访问设备的信任才能通过校验。
- **自备证书**。在 **证书设置**中选择 PEM 证书和配套的未加密 PEM 私钥。证书可包含完整证书链。证书应覆盖访问用的 IP，或填写证书涵盖的 **访问域名**，再将该域名解析到监听 IP。
- **按模式连接**。监听地址和端口沿用原配置。切换后请使用界面显示的 URL。

OpenCode v2.3.0 的 `opencode serve` 提供本机 Web 服务，远程 TLS 由插件网关处理。[OpenCode Web 文档](https://opencode.ai/docs/cli/web)

## 连接和日志

- **当前连接**显示来源 IP 和可用的设备信息。同机访问显示「本机」。设备型号由客户端提供，别名可在连接、登录日志或设备别名区管理。
- **登录日志**默认使用插件用户数据目录下的相对文件名 `login.jsonl`，界面显示解析后的绝对路径和文件大小。待选择的自定义日志文件使用绝对路径。
- 可以查看记录、打开文件、调整路径、停止记录或清空。空日志会禁用查看和清空按钮。
- 保留最近 500 条登录记录。白名单拦截写入同一日志，结果显示「被拦截」。

## 桌面端兼容性

| 环境 | 验证范围 |
| --- | --- |
| macOS | 使用本机 OpenCode Desktop v2.3.0 验证插件加载和 Web 入口。 |
| Ubuntu | 使用支持 GUI 插件的 OpenCode Desktop Linux 版。Ubuntu 24.04 LTS 容器通过网关、TLS 和日志测试。尚未完成 Linux Desktop GUI 实测。 |
| Windows | 桌面功能使用 Electron 和 Node.js 的跨平台接口。尚未在 Windows Desktop 实机验收。 |

自动生成证书需要 PATH 中的 OpenSSL。提供现有 PEM 证书和私钥时，Node.js 负责加载证书。

[OpenCode Desktop 官方安装包](https://opencode.ai/docs#desktop)

## 可选终端命令

macOS 和 Linux 可以安装 `oc-listen` 和 `oc-qr`。安装脚本使用 Python 3.8 或更新版本。

```bash
git clone https://github.com/fangfengxiang/opencode-remote-access.git
cd opencode-remote-access
./install.sh --commands-only
```

将 `~/.opencode/bin` 放入 `PATH`。快捷命令通过 Unix 套接字调用正在运行的桌面端。Windows 可通过桌面设置使用监听和配对。

## 文档与开发

- [功能说明](docs/features.md)
- [设计文档](docs/design.md)
- [MIT 许可证](LICENSE)
- [第三方组件](docs/third-party.md)
- [社区与相关项目](docs/community.md)

```bash
node scripts/build.cjs
node scripts/build.cjs --check
npm test
```

本地开发时可用 `./install.sh` 注册源码目录。发布时提交 `src/` 和预构建的 `gui-experimental.cjs`。

## 作者

[fangfengxiang](https://github.com/fangfengxiang) · Codex

[AI 文档索引](llms.txt)
