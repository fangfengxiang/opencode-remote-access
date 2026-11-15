#!/bin/sh
set -eu

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--commands-only" ]; }; then
    printf '%s\n' '用法: ./install.sh [--commands-only]' >&2
    exit 2
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' '请先安装 Python 3.8 或更新版本。' >&2
    exit 1
fi

exec python3 - "$repo_dir" "${1:-}" <<'PY'
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

STRING = r'"(?:\\.|[^"\\])*"'
COMMENTS = re.compile(rf'{STRING}|//[^\r\n]*|/\*[\s\S]*?\*/')
TRAILING_COMMAS = re.compile(rf'{STRING}|,(?=\s*[\]}}])')


def blank_comment(match):
    if match[0].startswith("/"):
        return re.sub(r"[^\r\n]", " ", match[0])
    return match[0]


def clean_jsonc(document):
    # Spaces keep the parsed offsets aligned with the original JSONC.
    clean = COMMENTS.sub(blank_comment, document)

    def blank_trailing_comma(match):
        if match[0] != ",":
            return match[0]
        previous = clean[:match.start()].rstrip()
        if not previous or previous[-1] in "[{,":
            raise ValueError("配置中的尾逗号前缺少元素。")
        return " "

    return TRAILING_COMMAS.sub(blank_trailing_comma, clean)


def value_offset(source, key):
    decoder = json.JSONDecoder()
    whitespace = re.compile(r"[ \t\r\n]*")

    def skip_space(index):
        return whitespace.match(source, index).end()

    index = skip_space(source.index("{") + 1)
    found = None
    while source[index] != "}":
        name, end = decoder.raw_decode(source, index)
        value = skip_space(skip_space(end) + 1)
        if name == key:
            if found is not None:
                raise ValueError(f"配置里存在重复的 {key} 字段。")
            found = value
        _, end = decoder.raw_decode(source, value)
        index = skip_space(end)
        if source[index] == ",":
            index = skip_space(index + 1)
    return found


def matches_plugin(item, plugin, config_dir):
    ref = item.get("package") if isinstance(item, dict) else item
    if not isinstance(ref, str):
        return False
    if ref == plugin:
        return True
    if not ref.startswith(("/", "./", "../", "~/")):
        return False
    return (config_dir / Path(ref).expanduser()).resolve() == Path(plugin)


def register_plugin(document, plugin, config_dir):
    bom = "\ufeff" if document.startswith("\ufeff") else ""
    if bom:
        document = document[1:]
    source = clean_jsonc(document)
    config = json.loads(source)
    if not isinstance(config, dict):
        raise ValueError("OpenCode 全局配置必须是 JSON 对象。")
    newline = "\r\n" if "\r\n" in document else "\n"
    entry = json.dumps(plugin, ensure_ascii=False)
    if "plugins" in config:
        plugins = config["plugins"]
        if not isinstance(plugins, list):
            raise ValueError("OpenCode 全局配置中的 plugins 必须是数组。")
        offset = value_offset(source, "plugins") + 1
        if any(matches_plugin(item, plugin, config_dir) for item in plugins):
            return bom + document
        comma = "," if plugins else ""
        insertion = f"{newline}    {entry}{comma}"
    else:
        offset = source.index("{") + 1
        comma = "," if config else ""
        insertion = f'{newline}  "plugins": [{entry}]{comma}'
    if not document[offset:].startswith(("\r", "\n")):
        insertion += newline
    updated = document[:offset] + insertion + document[offset:]
    json.loads(clean_jsonc(updated))
    return bom + updated


def replace_file(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            os.fchmod(file.fileno(), mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    repo = Path(sys.argv[1])
    entry = repo / "gui-experimental.cjs"
    if not entry.is_file():
        raise ValueError("找不到插件文件 gui-experimental.cjs，请从完整的仓库运行安装。")
    command = (repo / "bin/oc-listen").read_bytes()

    home = Path.home()
    commands_only = sys.argv[2] == "--commands-only"
    if not commands_only:
        config_dir = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config") / "opencode"
        config = config_dir / "opencode.jsonc"
        json_config = config_dir / "opencode.json"
        if not config.exists() and json_config.exists():
            config = json_config
        target = config.resolve()
        original = target.read_bytes().decode("utf-8") if target.exists() else "{}\n"
        updated = register_plugin(original, str(repo), config_dir)
    bin_dir = home / ".opencode/bin"
    for name in ("oc-listen", "oc-qr"):
        replace_file(bin_dir / name, command, 0o755)

    if not commands_only:
        if updated != original:
            mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o600
            replace_file(target, updated.encode("utf-8"), mode)
        print(f"已注册 OpenCode 远程访问插件（{config}）")
        print("在 OpenCode Desktop 中打开「设置 → 远程访问」。若未出现，重新打开桌面端。")
    print(f"已安装 oc-listen 和 oc-qr（{bin_dir}）")


try:
    main()
except (OSError, ValueError) as error:
    raise SystemExit(f"安装失败：{error}")
PY
