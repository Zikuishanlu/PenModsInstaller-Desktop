#!/usr/bin/env sh
# 把一个插件目录部署到词典笔并重启主进程。
#
#   ./deploy_plugin.sh ./plugins/com.example.myplugin
#   ./deploy_plugin.sh ./plugins/com.example.myplugin --no-restart
#   ADB="adb -s <serial>" ./deploy_plugin.sh ./plugins/com.example.myplugin
#
# 只推运行期文件（metadata.json、QML、图标、.so），不推 src/ sdk/ build.sh。
# 已加载过的 .so 先推临时名再 mv：直接覆盖正在映射的文件会让主进程段错误，
# 连续几次崩溃会被固件升级成 boot-recovery。
# 插件目录是 /userdisk/PenMods/plugins/<id>（不是 /userdata）。
set -eu

SRC="${1:-}"
[ -n "$SRC" ] || { echo "usage: $0 <plugin-dir> [--no-restart]" >&2; exit 2; }
[ -f "$SRC/metadata.json" ] || { echo "error: $SRC/metadata.json 不存在" >&2; exit 1; }

RESTART=1
[ "${2:-}" = "--no-restart" ] && RESTART=0

ADB="${ADB:-adb}"

json_get() {
    python -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8")).get(sys.argv[2],""))' "$1" "$2"
}

ID="$(json_get "$SRC/metadata.json" id)"
[ -n "$ID" ] || { echo "error: metadata.json 缺少 id（宿主会静默忽略该插件）" >&2; exit 1; }
SO="$(json_get "$SRC/metadata.json" main_so)"
MAIN_QML="$(json_get "$SRC/metadata.json" main_qml)"

DEST="/userdisk/PenMods/plugins/$ID"
echo "plugin id : $ID"
echo "target    : $DEST"

$ADB shell "mkdir -p $DEST"

# 普通文件直接覆盖（不在进程内存里映射）：metadata、顶层 QML/JS、图标
for f in "$SRC"/metadata.json "$SRC"/*.qml "$SRC"/*.js "$SRC"/icon.png; do
    [ -f "$f" ] || continue
    $ADB push "$f" "$DEST/" >/dev/null
    echo "pushed    : $(basename "$f")"
done

# main_qml 在子目录时，把整个子目录一并推上去
case "$MAIN_QML" in
    */*)
        sub="$(dirname "$MAIN_QML")"
        $ADB push "$SRC/$sub/." "$DEST/$sub/" >/dev/null
        echo "pushed    : $sub/"
        ;;
esac

# 共享库：推临时名再 rename
if [ -n "$SO" ]; then
    if [ -f "$SRC/build/$SO" ]; then
        TMP="$DEST/.$SO.tmp"
        $ADB push "$SRC/build/$SO" "$TMP" >/dev/null
        $ADB shell "mv -f $TMP $DEST/$SO"
        echo "pushed    : $SO (tmp+rename)"
    else
        echo "warn      : 未找到 $SRC/build/$SO，跳过 .so" >&2
    fi
fi

$ADB shell 'sync'

if [ "$RESTART" -eq 1 ]; then
    $ADB shell 'killall YoudaoDictPen' || true
    echo "restarted : 等 pidof YoudaoDictPen 稳定（约 10 秒）后再做下一次重启"
    echo
    echo "查日志（设备没有 logcat）："
    echo "  $ADB shell 'grep -E \"Found plugin|init_plugin|attach_engine|Failed to load|No init_plugin|Auto-disabling\" \$(ls -t /userdata/applog/DictPen_*.log | head -1)'"
    echo "  $ADB shell 'grep -E \"ReferenceError|TypeError|Unable to assign|Cannot read|is not a function\" \$(ls -t /userdata/applog/DictPen_*.log | head -1)'"
    echo "查残留标记（存在 .loading 会被当成崩溃而自动禁用）："
    echo "  $ADB shell 'ls -a $DEST'"
fi
