import type JSZip from 'jszip';
import type { DeviceConnection } from './device';

// ===================================================================
// PenMods 插件（应用）安装
//
// 插件 = 一个含 metadata.json 的文件夹，安装即把该文件夹推送到
// /userdisk/PenMods/plugins/<插件名>/。支持两种来源：
//   - ZIP 包（群文件常见形态）
//   - 本地文件夹（webkitdirectory 选择）
// 两者统一解析为 PluginPackage 后走同一条推送流程。
// ===================================================================

export const PLUGINS_DIR = '/userdisk/PenMods/plugins';

export interface PluginMeta {
  id?: string;
  name?: string;
  version?: string;
  author?: string;
  description?: string;
  icon?: string;
  main_qml?: string;
  main_so?: string;
  [k: string]: unknown;
}

/** 插件根目录下的一个文件，path 相对插件根（如 "metadata.json"、"qml/main.qml"） */
export interface PluginEntry {
  path: string;
  getData: () => Promise<Uint8Array>;
}

export interface PluginPackage {
  /** 安装目标文件夹名（plugins/<name>/） */
  name: string;
  meta: PluginMeta;
  files: PluginEntry[];
  /** icon.png 数据，用于预览（可选） */
  iconData?: Uint8Array;
}

// ── 内部工具 ──

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

export function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || '';
}

/** UTF-8 严格失败则按 GBK 解码（兼容 Windows 中文压缩包条目名） */
export function decodeZipName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try { return new TextDecoder('gbk').decode(bytes); }
    catch { return new TextDecoder('utf-8').decode(bytes); }
  }
}

/**
 * 从一组路径里挑出代表插件的 metadata.json：
 * 排除「源码 / source / src」目录，再取层级最浅的一个。
 */
export function pickMetadata(paths: string[]): string | null {
  const cands = paths.filter(p => {
    const lp = p.toLowerCase();
    return lp.endsWith('/metadata.json') || lp === 'metadata.json';
  });
  if (cands.length === 0) return null;
  const score = (p: string) => (/(源码|source|\/src\/|\bsrc\/)/i.test(p) ? 1000 : 0) + p.split('/').length;
  cands.sort((a, b) => score(a) - score(b));
  return cands[0];
}

/**
 * 安装目录名只保留字母/数字/汉字/点/横线/下划线。
 * metadata.json 来自插件作者（也可能来自市场下载的 ZIP），裸拼进 shell 命令
 * 就能注入 `a";reboot;#`；名字是 `..` 还会把 targetDir 抬到母目录。
 */
export function sanitizePluginName(raw: string): string {
  const name = String(raw || '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._]+/, '')
    .replace(/\.{2,}/g, '.');
  if (!name || name === '.' || name === '..') return '';
  return name;
}

/**
 * 解析安装文件夹名，优先级：
 * 1. metadata.icon 里的 plugins/<NAME>/ —— 插件自身代码引用的名字，最权威
 * 2. metadata.json 所在目录的 basename —— 分发者意图
 * 3. metadata.id / name 兜底
 */
export function resolveName(meta: PluginMeta, rootDir: string): string {
  const iconMatch = String(meta.icon || '').match(/plugins\/([^/]+)\//);
  const iconName = iconMatch ? sanitizePluginName(iconMatch[1]) : '';
  if (iconName) return iconName;
  const base = sanitizePluginName(basename(rootDir));
  if (base) return base;
  return sanitizePluginName(String(meta.id || meta.name || '')) || 'plugin';
}

function findIcon(files: PluginEntry[], meta: PluginMeta): PluginEntry | undefined {
  const iconRel = basename(String(meta.icon || '')).toLowerCase();
  return (
    files.find(f => basename(f.path).toLowerCase() === iconRel && iconRel) ||
    files.find(f => /^icon\.(png|jpg|jpeg|webp|gif)$/i.test(basename(f.path)))
  );
}

async function buildPackage(
  metaPath: string,
  allPaths: string[],
  readText: (path: string) => Promise<string>,
  makeEntry: (path: string, rel: string) => PluginEntry,
): Promise<PluginPackage> {
  const root = dirname(metaPath);
  const prefix = root ? root + '/' : '';
  let meta: PluginMeta;
  try {
    meta = JSON.parse(await readText(metaPath));
  } catch (e) {
    throw new Error('metadata.json 解析失败：' + (e instanceof Error ? e.message : String(e)));
  }
  const name = resolveName(meta, root);

  const files: PluginEntry[] = [];
  for (const p of allPaths) {
    if (prefix && !p.startsWith(prefix)) continue;
    const rel = prefix ? p.slice(prefix.length) : p;
    if (!rel) continue;
    files.push(makeEntry(p, rel));
  }

  const iconEntry = findIcon(files, meta);
  let iconData: Uint8Array | undefined;
  if (iconEntry) {
    try { iconData = await iconEntry.getData(); } catch { /* 预览可选 */ }
  }

  return { name, meta, files, iconData };
}

// ── 来源 1：ZIP ──

export async function parsePluginFromZip(zip: JSZip): Promise<PluginPackage> {
  const fileEntries = Object.values(zip.files).filter(f => !f.dir);
  const paths = fileEntries.map(f => f.name);
  const metaPath = pickMetadata(paths);
  if (!metaPath) throw new Error('压缩包内未找到 metadata.json，这可能不是有效的 PenMods 插件包');

  const byName = new Map(fileEntries.map(f => [f.name, f]));
  return buildPackage(
    metaPath,
    paths,
    (p) => byName.get(p)!.async('string'),
    (p, rel) => ({ path: rel, getData: () => byName.get(p)!.async('uint8array') }),
  );
}

/** 读取 zip File，自动按 UTF-8/GBK 处理条目名 */
export async function loadZipForPlugin(file: File): Promise<JSZip> {
  const JSZipMod = (await import('jszip')).default;
  return JSZipMod.loadAsync(file, { decodeFileName: (b) => decodeZipName(b as Uint8Array) });
}

// ── 来源 2：本地文件夹（<input webkitdirectory>） ──

export async function parsePluginFromFiles(fileList: File[]): Promise<PluginPackage> {
  const paths = fileList.map(f => f.webkitRelativePath || f.name);
  const metaPath = pickMetadata(paths);
  if (!metaPath) throw new Error('所选文件夹内未找到 metadata.json，请选择插件文件夹');

  const byPath = new Map(fileList.map((f, i) => [paths[i], f]));
  return buildPackage(
    metaPath,
    paths,
    async (p) => byPath.get(p)!.text(),
    (p, rel) => ({ path: rel, getData: async () => new Uint8Array(await byPath.get(p)!.arrayBuffer()) }),
  );
}

// ── 查询设备上已安装版本 ──

export async function getInstalledPlugin(conn: DeviceConnection, name: string): Promise<PluginMeta | null> {
  // name 来自设备目录列表，但仍要挡掉 `..`/绝对路径；拼 shell 命令时再单引号转义，
  // 这样目录名里带引号或 `$(...)` 也不会变成命令注入。
  const metaPath = safeJoin(PLUGINS_DIR, name) + '/metadata.json';
  try {
    let text: string;
    // noShell 连接（SSH）的 exec 通道不可靠，cat 读不到内容 —— 改走 SFTP readFile
    if (conn.noShell && conn.readFile) {
      text = new TextDecoder('utf-8').decode(await conn.readFile(metaPath));
    } else {
      text = await conn.shellCommand('cat ' + shQuote(metaPath) + ' 2>/dev/null');
    }
    const t = text.trim();
    if (!t || t[0] !== '{') return null;
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** POSIX 单引号转义：把任意字符串安全地作为单个参数拼进 shell 命令 */
function shQuote(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// ── 安装（推送到设备） ──

/**
 * 把插件包内的相对路径拼到安装目录下，并拒绝绝对路径与 `..`（zip slip）。
 * 插件包来自市场下载或用户自选，条目路径完全不可信：`../../system/x` 这类
 * 路径若原样拼上去，就会以 root 写到插件目录之外。
 */
export function safeJoin(base: string, entryPath: string): string {
  const raw = String(entryPath || '').replace(/\\/g, '/');
  const parts = raw.split('/').filter((p) => p && p !== '.');
  if (raw.startsWith('/') || parts.some((p) => p === '..')) {
    throw new Error('插件包内含非法路径（疑似路径穿越）：' + entryPath);
  }
  return parts.length ? base + '/' + parts.join('/') : base;
}

export interface InstallProgress {
  done: number;
  total: number;
  file: string;
}

export async function installPlugin(
  conn: DeviceConnection,
  pkg: PluginPackage,
  onProgress: (p: InstallProgress) => void,
): Promise<string> {
  const targetDir = PLUGINS_DIR + '/' + (sanitizePluginName(pkg.name) || 'plugin');

  // noShell 连接（SSH）：device-side shell 不可靠，unzip 静默失败。
  // 改为完全走 SFTP —— 逐文件推送，目录用 SFTP mkdir 预建，不触碰 shell。
  if (conn.noShell && conn.mkdirp) {
    return installViaSftp(conn, pkg, onProgress);
  }

  const zipPath = targetDir + '/__install.zip';

  onProgress({ done: 0, total: pkg.files.length, file: '打包中…' });

  // 浏览器端打包成单一 ZIP，只需一次 ADB 推送，设备端解压，比逐个推送快 N 倍
  const JSZipMod = (await import('jszip')).default;
  const zip = new JSZipMod();
  for (const f of pkg.files) {
    safeJoin(targetDir, f.path); // 只做校验，非法路径直接抛
    const data = await f.getData();
    zip.file(f.path, data);
  }
  const zipData = await zip.generateAsync({ type: 'uint8array' });
  onProgress({ done: 0, total: 1, file: '推送中 (' + (zipData.length / 1024).toFixed(0) + 'KB)…' });

  // shell:exec 不支持 && 链，用 shellScript（sh -c）执行多语句脚本
  // 先建目录 → 推 ZIP → 解压 → 设权限 → 删 ZIP
  await conn.shellScript('mkdir -p "' + targetDir + '"');
  await conn.pushFile(zipData, zipPath);
  onProgress({ done: 0, total: 1, file: '解压中…' });
  const out = await conn.shellScript(
    'cd "' + targetDir + '" && unzip -o "' + zipPath + '"; rc=$?; echo "__PM_UNZIP=$rc"; chmod -R 755 .; rm -f "' + zipPath + '"'
  );
  // 判退出码，而不是判文本：`unzip -o` 正常也会打印 inflating:，
  // 原来的文本判断会把「cannot create directory」和 inflating 一起吞掉。
  const rc = /__PM_UNZIP=(\d+)/.exec(out);
  const code = rc ? Number(rc[1]) : -1;
  if (code !== 0) {
    const bad = out.split('\n').find(l => /error|invalid|cannot|No such/i.test(l));
    if (code >= 2 || code < 0 || bad) {
      throw new Error('解压失败' + (code >= 0 ? `（unzip 退出码 ${code}）` : '') + ': ' + (bad || out.split('\n')[0] || '未知错误'));
    }
  }

  onProgress({ done: pkg.files.length, total: pkg.files.length, file: '完成' });
  return targetDir;
}

/**
 * SFTP-only 安装（SSH 模式）：不依赖任何 device-side shell 命令。
 * 先用 SFTP 递归建好所有子目录，再逐个 SFTP 写入文件。
 * 任一写入失败都会抛出真实错误，不会再出现「报成功但没装」。
 */
async function installViaSftp(
  conn: DeviceConnection,
  pkg: PluginPackage,
  onProgress: (p: InstallProgress) => void,
): Promise<string> {
  const targetDir = PLUGINS_DIR + '/' + (sanitizePluginName(pkg.name) || 'plugin');
  const total = pkg.files.length;

  // 收集所有需要的目录（含根），去重后逐个 mkdir（递归，幂等）
  onProgress({ done: 0, total, file: '创建目录…' });
  const dirs = new Set<string>([targetDir]);
  for (const f of pkg.files) {
    const d = dirname(f.path);
    if (d) dirs.add(safeJoin(targetDir, d));
  }
  // 排序保证父目录先于子目录（父路径是子路径前缀，字典序在前）
  for (const d of [...dirs].sort()) {
    await conn.mkdirp!(d);
  }

  let done = 0;
  for (const f of pkg.files) {
    onProgress({ done, total, file: f.path });
    const data = await f.getData();
    await conn.pushFile(data, safeJoin(targetDir, f.path));
    done++;
  }

  onProgress({ done: total, total, file: '完成' });
  return targetDir;
}
