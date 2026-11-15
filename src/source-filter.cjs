const { BlockList, isIP } = require("node:net");

function sourceFilter(value) {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid IP allowlist");
  const text = value.trim();
  if (!text) return () => true;
  const entries = text.split(/[\s,，;；]+/u).filter(Boolean);
  if (!entries.length || entries.length > 256) throw new Error("Invalid IP allowlist");
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix, ...extra] = entry.split("/");
    const ip = isIP(address);
    const family = ip === 4 ? "ipv4" : "ipv6";
    if (!ip || address.includes("%") || extra.length) throw new Error("Invalid IP allowlist entry");
    if (prefix === undefined) {
      list.addAddress(address, family);
    } else {
      const bits = Number(prefix);
      if (!/^\d{1,3}$/u.test(prefix) || bits > (ip === 4 ? 32 : 128)) throw new Error("Invalid IP prefix");
      list.addSubnet(address, bits, family);
    }
  }
  return (address) => {
    const ip = isIP(address);
    return ip !== 0 && list.check(address, ip === 4 ? "ipv4" : "ipv6");
  };
}

module.exports = { sourceFilter };
