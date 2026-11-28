#!/usr/bin/env sh
# 交叉编译 PenMods 插件为 ARM64 共享库
#
#   ./build.sh              → build/__SO_NAME__
#   ./build.sh out          → out/__SO_NAME__
#   QT_SDK=/path/to/qt ./build.sh
#
# 设备 ABI：aarch64-linux-gnu，glibc 2.27 —— target 后缀 .2.27 不能省，
# 漏掉会引入设备没有的 glibc 符号，dlopen 直接失败。
set -eu

QT_SDK="${QT_SDK:-$HOME/PenMods/aarch64-linux-qt-5.15.2}"
OUT_DIR="${1:-build}"
SO_NAME="__SO_NAME__"
STRICT="${STRICT:-1}"

mkdir -p "$OUT_DIR"

# 只有插件源码真的用到 Qt 类型（QString / QQmlEngine …）时才需要头文件路径。
# 注意：开了 -Wl,--no-undefined 时，引用 Qt 符号却又不链接 Qt 库会链接失败；
# 这种情况设 STRICT=0，或在下面追加 -L"$QT_SDK/lib" -lQt5Core -lQt5Qml。
QT_FLAGS=""
if [ -d "$QT_SDK/include" ]; then
    QT_FLAGS="-I$QT_SDK/include -I$QT_SDK/include/QtCore -I$QT_SDK/include/QtQml -I$QT_SDK/include/QtGui"
fi

UNDEF_FLAGS=""
if [ "$STRICT" = "1" ]; then
    UNDEF_FLAGS="-Wl,--no-undefined -Wl,-z,defs"
fi

# shellcheck disable=SC2086
zig c++ \
    -target aarch64-linux-gnu.2.27 \
    -shared -fPIC \
    -std=c++17 -O2 \
    -Isdk $QT_FLAGS \
    $UNDEF_FLAGS \
    src/plugin.cpp \
    -o "$OUT_DIR/$SO_NAME"

echo "built: $OUT_DIR/$SO_NAME"
echo "自检: python <skill>/scripts/verify_so.py $OUT_DIR/$SO_NAME"
