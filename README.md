# OpenCode 远程访问

在 **OpenCode Desktop → 设置 → 远程访问**中配置监听地址、端口和远程登录凭据。远程设备可以用账号密码登录，也可以用一次性配对链接和二维码接入。页面跟随桌面端语言，提供简体中文和英文。远程 Web 入口使用 HTTP，适合通过 Tailscale 等加密私网访问。

![OpenCode 远程访问设置界面，使用演示地址与遮挡密码](docs/remote-access.png)

## 安装

在支持桌面 GUI 插件的 OpenCode 上运行：

```bash
opencode plugin add github:fangfengxiang/opencode-remote-access
```

重新打开 OpenCode Desktop，在 **设置 → 远程访问**中找到插件。OpenCode 加载仓库自带的 CommonJS 文件。

更新已安装的 GitHub 插件。OpenCode v2.3.0 使用无参数命令更新所有可更新的插件。

```bash
opencode plugin update
```

如果以前通过本地目录安装过，可以从 OpenCode 全局配置的 `plugins` 数组移除旧目录条目，再运行原生安装命令。

## 使用

1. 在 Mac 上连接远程设备将使用的网络。使用 Tailscale 时，可用 `tailscale ip -4` 查看当前机器的 IPv4 地址。
2. 填写监听 IP、端口和远程账号密码。IP 使用本机分配的具体地址，端口需要与桌面服务不同。
3. 点击 **保存**写入配置，再开启监听。监听中可点 **保存并重启**立即应用，页面会显示重启状态。
4. 可选填写 **来源 IP 白名单**。填写单个 IP 或 CIDR 网段，用逗号或空格分隔。留空时不限制来源。本机浏览器也按白名单校验。
5. 点击 **在浏览器中打开**测试 Web 入口，或生成配对二维码。相机模式编码可在浏览器打开的链接，OpenCode App 模式使用原生配对格式。两种模式共用一个有效期为 5 分钟的一次性链接。

修改配置只影响远程监听。**保存**保留当前入口，改动在下次开启监听时生效。**保存并重启**会切换远程入口，先前已配对的远程设备需要重新登录或配对。

监听配置保存在 `~/.opencode/remote.json`，包含监听 IP、端口、用户名、密码和来源 IP 白名单。请保留该文件的用户专用访问权限。

## 连接和日志

- **当前连接**按来源 IP 和设备标识显示连接数。同一台电脑通过监听 IP 访问时显示「本机」。可在当前连接或登录日志中添加别名，之后在设备别名区域编辑或删除。
- 设备标识用于区分浏览器或客户端。设备型号依赖客户端提供的信息。浏览器数据清理、代理和客户端配置变化可能影响识别。
- **登录日志**默认记录在 `~/.opencode/remote-access/login.jsonl`。设置页显示绝对路径和大小，支持修改路径、开启或关闭记录、查看、打开文件和清空。改路径后，新记录写入新文件，原文件可在原路径查看。
- 日志保留最近 500 条登录记录，记录时间、来源、设备标识、认证方式和结果。白名单拦截会写入同一日志，结果显示「被拦截」。

## 可选终端命令

如果也想通过终端控制监听，可下载快捷命令。安装脚本使用 Python 3.8 或更新版本。

```bash
git clone https://github.com/fangfengxiang/opencode-remote-access.git
cd opencode-remote-access
./install.sh --commands-only
```

将 `~/.opencode/bin` 加入 `PATH`。运行 `oc-listen` 控制监听和查看登录信息，运行 `oc-qr` 生成配对信息。使用这些命令时需保持 OpenCode Desktop 开启。

## 文档与开发

- [支持的功能](docs/features.md)
- [设计文档](docs/design.md)
- [第三方组件](docs/third-party.md)

修改源代码后生成并校验桌面入口：

```bash
node scripts/build.cjs
node scripts/build.cjs --check
npm test
```

本地开发可在源码目录执行 `./install.sh` 注册当前目录。发布时提交 `src/` 和生成的 `gui-experimental.cjs`。
