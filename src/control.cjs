const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

async function removeStaleSocket(socketPath) {
  let entry;
  try {
    entry = await fs.lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!entry.isSocket() || entry.uid !== process.getuid()) {
    throw new Error("Cannot replace the existing local control socket.");
  }
  const active = await new Promise((resolve, reject) => {
    const check = net.connect(socketPath);
    check.once("connect", () => { check.destroy(); resolve(true); });
    check.once("error", (error) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
  if (active) throw new Error("A desktop control socket is already active.");
  await fs.rm(socketPath, { force: true });
}

async function openControl(handlers) {
  // The optional terminal shortcuts use a Unix socket. The Desktop IPC is independent.
  if (process.platform === "win32") return;
  const directory = path.join(os.homedir(), ".opencode", "remote-access");
  const socketPath = path.join(directory, "control.sock");
  await fs.mkdir(directory, { mode: 0o700, recursive: true });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid()) {
    throw new Error("Remote control requires a private local directory.");
  }
  if ((info.mode & 0o777) !== 0o700) await fs.chmod(directory, 0o700);
  await removeStaleSocket(socketPath);

  const clients = new Set();
  let closing = false;
  const server = net.createServer((socket) => {
    let input = "";
    let lease;
    let disconnected = false;
    const release = () => {
      if (!lease) return;
      const token = lease;
      lease = undefined;
      void handlers.stop(token).catch(() => {});
    };
    clients.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      disconnected = true;
      clients.delete(socket);
      release();
    });
    socket.on("data", receive);

    function receive(chunk) {
      input += chunk;
      if (input.length > 256) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      socket.removeListener("data", receive);
      socket.setTimeout(0);
      void run(input.trim());
    }

    async function run(command) {
      try {
        let result;
        if (closing) throw new Error("桌面插件正在退出。");
        switch (command) {
          case "listen": {
            const started = await handlers.start();
            lease = started.lease;
            if (disconnected) {
              release();
              return;
            }
            const credentials = await handlers.credentials();
            result = { url: started.snapshot.url, ...credentials, foreground: Boolean(lease) };
            break;
          }
          case "pair":
            result = await handlers.pair();
            break;
          case "status":
            result = handlers.listener();
            break;
          default:
            throw new Error("无法识别的远程访问命令。");
        }
        const reply = JSON.stringify({ ok: true, result }) + "\n";
        if (lease) socket.write(reply);
        else socket.end(reply);
      } catch (error) {
        release();
        socket.end(JSON.stringify({ ok: false, message: error.message }) + "\n");
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      server.on("error", () => {});
      resolve();
    });
  });
  return async () => {
    closing = true;
    const stopped = new Promise((resolve) => server.close(resolve));
    for (const socket of clients) socket.destroy();
    await stopped;
  };
}

module.exports = { openControl };
