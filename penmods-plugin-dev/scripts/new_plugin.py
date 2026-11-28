#!/usr/bin/env python3
"""生成 PenMods 插件脚手架。

用法：
    python new_plugin.py com.example.myplugin "My Plugin" --out ./plugins
    python new_plugin.py com.example.myplugin "My Plugin" --out ./plugins --with-so
    python new_plugin.py com.example.myplugin "My Plugin" --out ./plugins --icon ./logo.png

产出目录结构与 metadata.json 字段依据 PenMods 仓库 doc/PLUGIN_DEV_GUIDE.md 与
src/plugin/PluginManager.cpp（parseMetadata）：
    <out>/<plugin_id>/
        metadata.json          必须；缺 id 的插件会被静默忽略
        Main.qml               插件页入口（main_qml）
        icon.png               可选
        sdk/PluginSDK.h        (--with-so)
        src/plugin.cpp         (--with-so)
        build.sh               (--with-so，zig 交叉编译 aarch64-linux-gnu.2.27)

纯 QML 插件不需要编译；--with-so 才生成原生骨架。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent / "assets" / "plugin-template"
DEVICE_PLUGIN_ROOT = "/userdisk/PenMods/plugins"  # 注意是 /userdisk，不是 /userdata


def sanitize_so_name(plugin_id: str) -> str:
    tail = plugin_id.rsplit(".", 1)[-1]
    tail = re.sub(r"[^A-Za-z0-9_]", "_", tail) or "plugin"
    return f"lib{tail}.so"


def render(text: str, subs: dict[str, str]) -> str:
    for key, value in subs.items():
        text = text.replace(f"__{key}__", value)
    return text


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="生成 PenMods 插件脚手架")
    parser.add_argument("plugin_id", help="全局唯一且不随版本变化的 id，建议反向域名，例如 com.example.myplugin")
    parser.add_argument("name", help="插件显示名（插件管理页与首页插件抽屉用）")
    parser.add_argument("--out", default=".", help="输出父目录，默认当前目录")
    parser.add_argument("--with-so", action="store_true", help="同时生成原生 .so 插件骨架")
    parser.add_argument("--icon", default="", help="图标文件（PNG）；缺省省略 icon 字段，宿主用内置图标")
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--author", default="")
    parser.add_argument("--description", default="")
    args = parser.parse_args()

    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9._-]*", args.plugin_id):
        fail("plugin_id 只能包含字母、数字、点、下划线、连字符，且以字母开头")
    if not TEMPLATE.is_dir():
        fail(f"模板目录缺失: {TEMPLATE}")

    dest = Path(args.out) / args.plugin_id
    if dest.exists() and any(dest.iterdir()):
        fail(f"目标目录已存在且非空: {dest}")
    dest.mkdir(parents=True, exist_ok=True)

    so_name = sanitize_so_name(args.plugin_id)
    subs = {
        "PLUGIN_ID": args.plugin_id,
        "PLUGIN_NAME": args.name,
        "PLUGIN_VERSION": args.version,
        "PLUGIN_AUTHOR": args.author,
        "PLUGIN_DESC": args.description,
        "SO_NAME": so_name,
    }

    # metadata.json —— 必须是严格 JSON（无注释、无尾逗号），由 QJsonDocument 解析
    meta = {
        "id": args.plugin_id,
        "name": args.name,
        "version": args.version,
        "author": args.author,
        "description": args.description,
        "main_qml": "Main.qml",
    }
    if args.with_so:
        meta["main_so"] = so_name

    if args.icon:
        icon_src = Path(args.icon)
        if not icon_src.is_file():
            fail(f"图标文件不存在: {icon_src}")
        shutil.copy2(icon_src, dest / "icon.png")
        # 宿主把 icon 原样交给 YImage.imageName：只有 qrc:/ 与 file:/ 前缀才被当作路径，
        # 相对路径会被拼成 image://icons/<值>.png 而解析失败（源码推断，真机需复核）。
        meta["icon"] = f"file://{DEVICE_PLUGIN_ROOT}/{args.plugin_id}/icon.png"

    (dest / "metadata.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=4) + "\n", encoding="utf-8"
    )

    (dest / "Main.qml").write_text(
        render((TEMPLATE / "qml" / "Main.qml").read_text(encoding="utf-8"), subs),
        encoding="utf-8",
    )

    if args.with_so:
        (dest / "sdk").mkdir(exist_ok=True)
        shutil.copy2(TEMPLATE / "sdk" / "PluginSDK.h", dest / "sdk" / "PluginSDK.h")

        (dest / "src").mkdir(exist_ok=True)
        (dest / "src" / "plugin.cpp").write_text(
            render((TEMPLATE / "src" / "plugin.cpp").read_text(encoding="utf-8"), subs),
            encoding="utf-8",
        )

        build_path = dest / "build.sh"
        build_path.write_text(
            render((TEMPLATE / "build.sh").read_text(encoding="utf-8"), subs), encoding="utf-8"
        )
        build_path.chmod(0o755)

    print(f"created {dest}")
    print()
    print("下一步：")
    print(f"  1. 编辑 {dest / 'Main.qml'}（Qt 逻辑分辨率 320x170，可点区域 >= 40x40）")
    if args.with_so:
        print(f"  2. 编辑 {dest / 'src' / 'plugin.cpp'}，cd {dest} && ./build.sh")
        print(f"  3. python <skill>/scripts/verify_so.py {dest}/build/{so_name}")
        step = 4
    else:
        print("  2. 纯 QML 插件，无需编译")
        step = 3
    print(f"  {step}. sh <skill>/scripts/deploy_plugin.sh {dest}")
    step += 1
    print(f"  {step}. adb shell 'grep -E \"Found plugin|init_plugin|Failed to load|Auto-disabling\" "
          f"$(ls -t /userdata/applog/DictPen_*.log | head -1)'")


if __name__ == "__main__":
    main()
