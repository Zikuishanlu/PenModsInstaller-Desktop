#!/usr/bin/env python3
"""校验 PenMods 插件 .so 是否满足设备 ABI。纯标准库实现，不依赖 readelf / nm。

用法：
    python verify_so.py build/libmyplugin.so
    python verify_so.py build/libmyplugin.so --max-glibc 2.27 --require attach_engine

设备约束（PenMods README.md / AGENTS.md / doc/PLUGIN_DEV_GUIDE.md）：
    目标 aarch64-linux-gnu，glibc 2.27，Qt 5.15.2；
    .so 必须导出 extern "C" 的 init_plugin（可选 attach_engine /
    init_plugin_with_hook_api / init_plugin_with_media_api / destroy_plugin）。

检查项：
    1. 文件是 ELF64 小端共享对象（ET_DYN），e_machine == AArch64
    2. DT_NEEDED 依赖清单
    3. 未定义符号所需的 GLIBC_x.y 版本（高于设备版本即 dlopen 失败）
    4. 导出符号是否包含 init_plugin 等入口
    5. 未定义符号里的 C++ 运行库 / Qt 引用提示

退出码：0 全部通过；1 存在 FAIL；2 用法或文件错误。
"""

from __future__ import annotations

import argparse
import re
import struct
import sys
from dataclasses import dataclass, field

SHT_DYNAMIC = 6
SHT_DYNSYM = 11
SHT_GNU_VERNEED = 0x6FFFFFFE
SHT_GNU_VERSYM = 0x6FFFFFFF

PT_LOAD = 1

DT_NEEDED = 1
DT_STRTAB = 5
DT_SONAME = 14
DT_RPATH = 15
DT_RUNPATH = 29

STB_GLOBAL = 1
STB_WEAK = 2
EM_AARCH64 = 183
ET_DYN = 3

ENTRY_POINTS = (
    "init_plugin",
    "attach_engine",
    "init_plugin_with_hook_api",
    "init_plugin_with_media_api",
    "destroy_plugin",
)

# 按 mangled 名粗分类（只用于提示，不做精确判定）
LIBCXX_MARK = "St3__1"  # std::__1，libc++ 的内联命名空间
LIBSTDCXX_LIBS = ("libstdc++.so", "libsupc++", "libgcc_s.so")
LIBC_CXA = ("__cxa_finalize", "__cxa_atexit", "__cxa_thread_atexit")  # 这几个来自 glibc
_MANGLED_ROOT = re.compile(r"_Z[KVTIG]*(?:NK?)?")


@dataclass
class Report:
    oks: list[str] = field(default_factory=list)
    warns: list[str] = field(default_factory=list)
    fails: list[str] = field(default_factory=list)

    def ok(self, msg: str) -> None:
        self.oks.append(msg)

    def warn(self, msg: str) -> None:
        self.warns.append(msg)

    def fail(self, msg: str) -> None:
        self.fails.append(msg)


def version_tuple(text: str) -> tuple[int, ...]:
    """'GLIBC_2.28' -> (2, 28)；无法解析时返回 ()。"""
    parts = re.findall(r"\d+", text)
    return tuple(int(p) for p in parts[:2]) if parts else ()


class Elf:
    """只解析校验所需的 ELF64 小端结构。"""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.sections: list[dict] = []
        self.segments: list[dict] = []
        self.shstrndx = 0
        self.has_sections = True
        self.needed: list[str] = []
        self.soname = ""
        self.runpath = ""
        self.defined: set[str] = set()
        self.undefined: dict[str, int] = {}  # name -> version index
        self.verneed: dict[int, tuple[str, str]] = {}  # version index -> (lib, version)

    # ---------- 基础 ----------
    def _read_cstr(self, offset: int) -> str:
        end = self.data.index(b"\x00", offset)
        return self.data[offset:end].decode("utf-8", "replace")

    def _vaddr_to_offset(self, vaddr: int) -> int | None:
        for seg in self.segments:
            if seg["type"] == PT_LOAD and seg["vaddr"] <= vaddr < seg["vaddr"] + seg["filesz"]:
                return vaddr - seg["vaddr"] + seg["offset"]
        return None

    def _section_by_type(self, sh_type: int) -> dict | None:
        for sec in self.sections:
            if sec["type"] == sh_type:
                return sec
        return None

    def _section_data(self, sh_type: int) -> bytes | None:
        sec = self._section_by_type(sh_type)
        if not sec:
            return None
        return self.data[sec["offset"]:sec["offset"] + sec["size"]]

    # ---------- 解析 ----------
    def parse(self, report: Report) -> None:
        data = self.data
        if len(data) < 64 or data[:4] != b"\x7fELF":
            raise ValueError("不是 ELF 文件（可能编成了 PE/EXE，或文件为空/损坏）")
        if data[4] != 2:
            raise ValueError("不是 64 位 ELF（EI_CLASS != ELFCLASS64）")
        if data[5] != 1:
            raise ValueError("不是小端 ELF（EI_DATA != ELFDATA2LSB）")

        (e_type, e_machine, _ver, _entry, e_phoff, e_shoff, _flags, _ehsize,
         e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx) = struct.unpack_from("<HHIQQQIHHHHHH", data, 16)

        if e_machine != EM_AARCH64:
            report.fail(f"目标架构不是 AArch64：e_machine={e_machine}（应为 {EM_AARCH64}，检查 -target）")
        else:
            report.ok("ELF64 小端，目标架构 AArch64")
        if e_type != ET_DYN:
            report.fail(f"e_type={e_type}（共享库应为 {ET_DYN} ET_DYN，检查 -shared -fPIC）")

        for i in range(e_phnum):
            off = e_phoff + i * e_phentsize
            p_type, _p_flags, p_offset, p_vaddr, _pa, p_filesz, _mem, _al = struct.unpack_from(
                "<IIQQQQQQ", data, off
            )
            self.segments.append({"type": p_type, "offset": p_offset, "vaddr": p_vaddr, "filesz": p_filesz})

        if e_shoff == 0 or e_shnum == 0:
            self.has_sections = False
            return

        for i in range(e_shnum):
            off = e_shoff + i * e_shentsize
            name_off, typ, _flags, addr, offset, size, link, _info, _align, entsize = struct.unpack_from(
                "<IIQQQQIIQQ", data, off
            )
            self.sections.append({"name_off": name_off, "type": typ, "addr": addr, "offset": offset,
                                  "size": size, "link": link, "entsize": entsize})

        self.shstrndx = e_shstrndx
        if e_shstrndx < len(self.sections):
            base = self.sections[e_shstrndx]["offset"]
            for sec in self.sections:
                sec["name"] = self._read_cstr(base + sec["name_off"])
        else:
            for sec in self.sections:
                sec["name"] = ""

        self._parse_dynamic()
        self._parse_dynsym(report)
        self._parse_verneed()

    def _parse_dynamic(self) -> None:
        dyn = self._section_by_type(SHT_DYNAMIC)
        if not dyn:
            return
        entries: list[tuple[int, int]] = []
        off, end = dyn["offset"], dyn["offset"] + dyn["size"]
        while off + 16 <= end:
            tag, val = struct.unpack_from("<qQ", self.data, off)
            off += 16
            if tag == 0:
                break
            entries.append((tag, val))

        strtab_base = None
        for tag, val in entries:
            if tag == DT_STRTAB:
                strtab_base = self._vaddr_to_offset(val)
                break
        if strtab_base is None:
            return
        for tag, val in entries:
            if tag == DT_NEEDED:
                self.needed.append(self._read_cstr(strtab_base + val))
            elif tag == DT_SONAME:
                self.soname = self._read_cstr(strtab_base + val)
            elif tag in (DT_RPATH, DT_RUNPATH):
                self.runpath = self._read_cstr(strtab_base + val)

    def _parse_dynsym(self, report: Report) -> None:
        symtab = self._section_by_type(SHT_DYNSYM)
        if not symtab:
            report.warn("没有 .dynsym 节，跳过符号检查")
            return
        if symtab["link"] >= len(self.sections):
            report.warn(".dynsym 的 sh_link 无效，跳过符号检查")
            return
        str_off = self.sections[symtab["link"]]["offset"]
        versym = self._section_data(SHT_GNU_VERSYM)
        entsize = symtab["entsize"] or 24
        count = symtab["size"] // entsize
        for i in range(1, count):
            name_off, info, _other, shndx, _value, _size = struct.unpack_from(
                "<IBBHQQ", self.data, symtab["offset"] + i * entsize
            )
            if name_off == 0:
                continue
            name = self._read_cstr(str_off + name_off)
            if shndx == 0:  # SHN_UNDEF：引用的外部符号
                idx = 0
                if versym is not None and i * 2 + 2 <= len(versym):
                    idx = struct.unpack_from("<H", versym, i * 2)[0] & 0x7FFF
                self.undefined[name] = idx
            elif (info >> 4) in (STB_GLOBAL, STB_WEAK):
                self.defined.add(name)

    def _parse_verneed(self) -> None:
        sec = self._section_by_type(SHT_GNU_VERNEED)
        if not sec or sec["link"] >= len(self.sections):
            return
        str_off = self.sections[sec["link"]]["offset"]
        off, end = sec["offset"], sec["offset"] + sec["size"]
        while off + 16 <= end:
            _vn_version, vn_cnt, vn_file, vn_aux, vn_next = struct.unpack_from("<HHIII", self.data, off)
            aux_off = off + vn_aux
            for _ in range(vn_cnt):
                if aux_off + 16 > end:
                    break
                _hash, _flags, vna_other, vna_name, vna_next = struct.unpack_from("<IHHII", self.data, aux_off)
                self.verneed[vna_other & 0x7FFF] = (
                    self._read_cstr(str_off + vn_file),
                    self._read_cstr(str_off + vna_name),
                )
                if vna_next == 0:
                    break
                aux_off += vna_next
            if vn_next == 0:
                break
            off += vn_next


def classify_undefined(elf: Elf) -> dict[str, list[str]]:
    """把未定义符号按用途粗分：qt / libcxx / libstdcxx / other。

    mangled 名去掉 `_Z` 与 K/V/T/I/G/N 前缀后看剩余部分：
      `7QString`、`10QObject` → Qt；`St9exception`、`9__gnu_cxx...` → 标准库；
      含 `St3__1` → libc++（zig 默认，静态链接）。
    """
    groups: dict[str, list[str]] = {"qt": [], "libcxx": [], "libstdcxx": [], "other": []}
    for name in sorted(elf.undefined):
        root = name[_MANGLED_ROOT.match(name).end():] if name.startswith("_Z") else ""
        if LIBCXX_MARK in name:
            groups["libcxx"].append(name)
        elif re.match(r"\d+Q", root):
            groups["qt"].append(name)
        elif root.startswith("St") or re.match(r"9__gnu_cxx", root):
            groups["libstdcxx"].append(name)
        elif name.startswith("__cxa_") and name not in LIBC_CXA:
            groups["libstdcxx"].append(name)
        else:
            groups["other"].append(name)
    return groups


def check(path: str, max_glibc: str, require: list[str]) -> Report:
    report = Report()
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        raise ValueError(f"无法读取文件: {exc}") from exc
    try:
        elf = Elf(data)
        elf.parse(report)
    except (ValueError, struct.error) as exc:
        report.fail(f"解析失败: {exc}")
        return report

    if not elf.has_sections:
        report.warn("没有节头表，无法检查依赖 / 符号 / 版本")
        return report

    # 1. 依赖
    if elf.needed:
        report.ok(f"DT_NEEDED: {', '.join(elf.needed)}")
        for lib in elf.needed:
            if any(lib.startswith(x) for x in LIBSTDCXX_LIBS):
                report.warn(f"依赖 {lib}：确认设备固件带有该库；用 zig c++ 编译则 libc++ 静态链接、无此依赖")
    else:
        report.ok("无 DT_NEEDED 依赖")
    if elf.runpath:
        report.warn(f"带 RUNPATH/RPATH: {elf.runpath}（开发机路径在设备上无效）")

    # 2. 版本需求
    required: dict[str, set[str]] = {}
    for name, idx in elf.undefined.items():
        if idx <= 1:
            continue
        lib, ver = elf.verneed.get(idx, ("", ""))
        if lib:
            required.setdefault(lib, set()).add(ver)
    for lib in sorted(required):
        vers = sorted(required[lib], key=version_tuple)
        report.ok(f"需要 {lib}: {', '.join(vers)}")
        if "libc.so" in lib or "libc-" in lib:
            for ver in vers:
                if ver.startswith("GLIBC_") and version_tuple(ver) > version_tuple(max_glibc):
                    report.fail(
                        f"需要 {ver}，高于设备的 glibc {max_glibc} —— dlopen 会失败；"
                        f"检查是否漏了 -target aarch64-linux-gnu.{max_glibc}"
                    )
    if not required:
        report.ok("未定义符号无版本约束")

    # 3. 入口符号
    if not elf.undefined and not elf.defined:
        report.fail("没有任何动态符号：.so 可能被完全 strip，或没有导出入口")
    exported = [s for s in ENTRY_POINTS if s in elf.defined]
    if exported:
        report.ok(f"导出入口符号: {', '.join(exported)}")
    else:
        report.fail('未导出 init_plugin：.so 会被卸载并自动禁用（检查是否在 extern "C" 内）')
    for sym in require:
        if sym not in elf.defined:
            report.fail(f"缺少要求的导出符号: {sym}")

    # 4. 引用提示
    groups = classify_undefined(elf)
    if groups["libcxx"]:
        report.warn(f"引用 {len(groups['libcxx'])} 个 libc++ 符号：zig 默认静态链接 libc++，正常；"
                    f"若用 g++ 编译则需避免与 libstdc++ 混用")
    if groups["libstdcxx"]:
        sample = ", ".join(groups["libstdcxx"][:3])
        report.warn(f"引用 {len(groups['libstdcxx'])} 个 libstdc++/libsupc++ 符号（如 {sample}）："
                    f"设备需带有匹配版本")
    if groups["qt"]:
        sample = ", ".join(groups["qt"][:3])
        report.warn(f"引用 {len(groups['qt'])} 个 Qt 符号（如 {sample}）：由主进程已加载的 Qt 5.15.2 提供；"
                    f"若开了 -Wl,--no-undefined 会链接失败，需链接 sysroot 里的同版本 Qt 或去掉该选项")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 PenMods 插件 .so 的设备 ABI")
    parser.add_argument("so", help="待检查的 .so 文件")
    parser.add_argument("--max-glibc", default="2.27", help="设备 glibc 版本上限，默认 2.27")
    parser.add_argument("--require", action="append", default=[], help="额外必须导出的符号，可重复")
    args = parser.parse_args()

    print(f"file      : {args.so}")
    print(f"max glibc : {args.max_glibc}")
    try:
        report = check(args.so, args.max_glibc, args.require)
    except ValueError as exc:
        print(f"[fail] {exc}")
        return 2

    for line in report.fails:
        print(f"[fail] {line}")
    for line in report.warns:
        print(f"[warn] {line}")
    for line in report.oks:
        print(f"[ok]   {line}")

    if report.fails:
        print(f"结果      : 不通过（{len(report.fails)} 项失败）")
        return 1
    print("结果      : 通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
