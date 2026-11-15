const { execFile } = require("node:child_process");
const { createHash, X509Certificate } = require("node:crypto");
const { constants } = require("node:fs");
const fs = require("node:fs/promises");
const { isIP } = require("node:net");
const path = require("node:path");
const { createSecureContext } = require("node:tls");
const { domainToASCII } = require("node:url");
const { promisify } = require("node:util");

const limit = 1024 * 1024;
const minVersion = "TLSv1.2";
const defaultHttps = Object.freeze({ enabled: false, hostname: "", certificatePath: "", keyPath: "" });

function validateHttps(input = defaultHttps, problem) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw problem("error.httpsSettings");
  const { enabled, certificatePath, keyPath, hostname } = { ...defaultHttps, ...input };
  if (typeof enabled !== "boolean" || [certificatePath, keyPath, hostname].some((value) => typeof value !== "string")) {
    throw problem("error.httpsSettings");
  }

  const rawHostname = hostname.trim();
  let name = "";
  if (rawHostname) {
    if (/[\s/\\:?#@%]/u.test(rawHostname)) throw problem("error.httpsHostname");
    name = domainToASCII(rawHostname).toLowerCase().replace(/\.$/u, "");
    const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
    if (!name || name.length > 253 || isIP(name) || !name.split(".").every((label) => validLabel.test(label))) {
      throw problem("error.httpsHostname");
    }
  }

  const cert = certificatePath.trim();
  const key = keyPath.trim();
  if (Boolean(cert) !== Boolean(key)) throw problem("error.httpsPathPair");
  if ([cert, key].some((file) => file && (!path.isAbsolute(file) || file.includes("\0")))) {
    throw problem("error.httpsAbsolutePaths");
  }
  return { enabled, hostname: name, certificatePath: cert, keyPath: key };
}

async function readPem(file) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > limit) throw new Error("Invalid PEM file");
    const contents = await handle.readFile();
    if (contents.length > limit) throw new Error("PEM file exceeds size limit");
    return contents;
  } finally {
    await handle.close();
  }
}

async function readMaterial(certificatePath, keyPath, host, problem) {
  let cert, key, certificate;
  try {
    [cert, key] = await Promise.all([readPem(certificatePath), readPem(keyPath)]);
  } catch {
    throw problem("error.httpsRead");
  }
  try {
    certificate = new X509Certificate(cert);
    createSecureContext({ cert, key, minVersion });
  } catch {
    throw problem("error.httpsInvalidPem");
  }
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw problem("error.httpsValidity");
  }
  if (host && !(isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host, { subject: "never" }))) {
    throw problem("error.httpsCertificateHost", { host });
  }
  return { cert, key, minVersion };
}

async function generatedMaterial(directory, host, problem, signal) {
  const identity = createHash("sha256").update(host).digest("hex").slice(0, 24);
  const cache = path.join(directory, identity);
  const certificatePath = path.join(cache, "certificate.pem");
  const keyPath = path.join(cache, "private-key.pem");
  try {
    const material = await readMaterial(certificatePath, keyPath, host, problem);
    return { ...material, generatedCertificatePath: certificatePath };
  } catch {
    // A different identity has its own cache. Regenerate a missing or invalid pair for this one.
  }

  let temporary;
  try {
    await fs.mkdir(cache, { recursive: true, mode: 0o700 });
    temporary = await fs.mkdtemp(path.join(cache, ".pending-"));
    const config = path.join(temporary, "request.cnf");
    const cert = path.join(temporary, "certificate.pem");
    const key = path.join(temporary, "private-key.pem");
    await fs.writeFile(config, [
      "[req]",
      "prompt = no",
      "distinguished_name = dn",
      "x509_extensions = server",
      "[dn]",
      "CN = OpenCode Remote Access",
      "[server]",
      "basicConstraints = critical,CA:FALSE",
      "keyUsage = critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage = serverAuth",
      `subjectAltName = ${isIP(host) ? "IP" : "DNS"}:${host}`,
      "",
    ].join("\n"), { flag: "wx", mode: 0o600 });
    await promisify(execFile)("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "365", "-nodes",
      "-config", config, "-out", cert, "-keyout", key,
    ], { signal, timeout: 20_000, windowsHide: true });
    await fs.chmod(key, 0o600);
    await fs.chmod(cert, 0o600);
    const material = await readMaterial(cert, key, host, problem);
    await fs.rename(key, keyPath);
    await fs.rename(cert, certificatePath);
    return { ...material, generatedCertificatePath: certificatePath };
  } catch (failure) {
    if (failure.code === "ENOENT" && failure.syscall?.startsWith("spawn")) throw problem("error.httpsOpenSsl");
    throw problem("error.httpsGenerate");
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

async function listenerTls(settings, host, directory, problem, signal) {
  if (!settings.enabled) return undefined;
  const name = settings.hostname || host;
  if (settings.certificatePath) {
    return { ...await readMaterial(settings.certificatePath, settings.keyPath, name, problem), hostname: settings.hostname };
  }
  return { ...await generatedMaterial(directory, name, problem, signal), hostname: settings.hostname };
}

module.exports = { defaultHttps, validateHttps, listenerTls };
