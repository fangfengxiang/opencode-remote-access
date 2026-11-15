const { createComponent, createSignal, onCleanup } = require("solid-js");
const { insert } = require("solid-js/web");
const qrcode = require("./qrcode-generator.cjs");

const scale = 5;
const margin = 4;

function makeCanvas(width, height, label, paint) {
  const canvas = document.createElement("canvas");
  canvas.width = (width + margin * 2) * scale;
  canvas.height = (height + margin * 2) * scale;
  canvas.style.cssText = "max-width:100%;height:auto";
  canvas.setAttribute("aria-label", label);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  paint((x, y) => context.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale));
  return canvas;
}

function cameraCanvas(link, label) {
  const code = qrcode(0, "M");
  code.addData(link);
  code.make();
  const modules = code.getModuleCount();
  return makeCanvas(modules, modules, label, (pixel) => {
    for (let y = 0; y < modules; y++) {
      for (let x = 0; x < modules; x++) {
        if (code.isDark(y, x)) pixel(x, y);
      }
    }
  });
}

function nativeCanvas(output, label) {
  const rows = output.split(/\r?\n/).filter((line) => /^[ █▀▄]+$/.test(line) && /[█▀▄]/.test(line));
  if (!rows.length) return undefined;
  return makeCanvas(Math.max(...rows.map((line) => line.length)), rows.length * 2, label, (pixel) => {
    rows.forEach((line, y) => Array.from(line).forEach((symbol, x) => {
      if (symbol === "█" || symbol === "▀") pixel(x, y * 2);
      if (symbol === "█" || symbol === "▄") pixel(x, y * 2 + 1);
    }));
  });
}

function secondsUntil(expiresAt, now = Date.now()) {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function remainingText(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function pairingPreview({ output, expiresAt }, t, ui) {
  const link = output.match(/https?:\/\/[^\s]+\/auth\/connect\/[A-Za-z0-9_-]{22}(?=\s|$)/u)?.[0];
  const camera = link ? cameraCanvas(link, t("cameraQr")) : undefined;
  const app = nativeCanvas(output, t("appQr"));
  const [mode, setMode] = createSignal(camera ? "camera" : "app");
  const [remaining, setRemaining] = createSignal(secondsUntil(expiresAt));
  const expired = () => remaining() <= 0;
  if (!expired()) {
    const timer = setInterval(() => {
      setRemaining(secondsUntil(expiresAt));
      if (expired()) clearInterval(timer);
    }, 250);
    onCleanup(() => clearInterval(timer));
  }

  const root = document.createElement("div");
  root.style.cssText = "padding:16px 20px;display:grid;gap:8px;overflow-wrap:anywhere;user-select:text";
  const controls = document.createElement("div");
  controls.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:6px";
  const timer = document.createElement("span");
  timer.setAttribute("role", "timer");
  timer.style.cssText = "color:var(--v2-text-text-muted);font-variant-numeric:tabular-nums";
  insert(timer, () => expired() ? t("pairingExpired") : t("pairingCountdown", { time: remainingText(remaining()) }));
  const modeButton = (value, key) => createComponent(ui.Button, {
    size: "small",
    get variant() { return mode() === value ? "neutral" : "ghost"; },
    get children() { return t(key); },
    onClick: () => setMode(value),
  });
  insert(controls, [
    () => !expired() && camera && app
      ? [modeButton("camera", "cameraQr"), modeButton("app", "appQr")]
      : null,
    timer,
  ]);
  const visual = document.createElement("div");
  const covered = document.createElement("div");
  covered.style.cssText = "display:grid;place-items:center;width:min(220px,100%);min-height:100px;border-radius:6px;background:var(--v2-background-bg-layer-01);color:var(--v2-text-text-muted)";
  insert(covered, () => t("pairingExpired"));
  insert(visual, () => expired() ? covered : mode() === "camera" ? camera : app);
  const note = document.createElement("p");
  insert(note, () => t(expired() ? "pairingExpiredHint" : "pairingHint"));
  root.append(controls, visual, note);
  if (link) {
    const address = document.createElement("p");
    const strike = document.createElement("s");
    strike.textContent = link;
    strike.style.color = "var(--v2-text-text-muted)";
    insert(address, () => expired() ? strike : link);
    root.append(address);
  }
  return root;
}

module.exports = { pairingPreview, secondsUntil, remainingText };
