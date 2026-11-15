/**
 * 音乐模块的核心逻辑（本地文件 / 音源搜索 / 播放列表解析）。
 *
 * 只做「把音频搬到词典笔上」这件事，不做在线音乐的版权决策：
 * 搜索与播放链接来自用户在设置里自己填的「音源」，
 * 安装器只负责请求、下载、推送到设备。
 *
 * 纯函数部分不碰网络，方便冒烟测试。
 */
import type { DeviceConnection } from './device';

// ── 常量 ──

/** 设备上的音乐目录（和系统音乐 App 认的目录一致） */
export const DEFAULT_DEVICE_MUSIC_DIR = '/userdisk/Music';

/** 设置里存的 key */
export const LS_MUSIC_SOURCE = 'music_source';
export const LS_MUSIC_DIR = 'music_device_dir';

/** 本地选择时认的音频扩展名 */
export const AUDIO_EXTS = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.ape', '.wma'];

/** 单个文件上限，和 /api/proxy 的限制对齐 */
export const MAX_AUDIO_BYTES = 120 * 1024 * 1024;

// ── 音源配置 ──

export interface MusicSource {
  /** 音源根地址，如 https://music.example.com/api 或 http://192.168.1.10:3000 */
  base: string;
  /** 推送到设备上的目录 */
  deviceDir: string;
}

export function loadMusicSource(): MusicSource {
  const base = (typeof localStorage !== 'undefined' && localStorage.getItem(LS_MUSIC_SOURCE)) || '';
  const dir = (typeof localStorage !== 'undefined' && localStorage.getItem(LS_MUSIC_DIR)) || '';
  return { base: normalizeBase(base), deviceDir: dir.trim() || DEFAULT_DEVICE_MUSIC_DIR };
}

export function saveMusicSource(src: MusicSource): void {
  localStorage.setItem(LS_MUSIC_SOURCE, normalizeBase(src.base));
  localStorage.setItem(LS_MUSIC_DIR, src.deviceDir.trim() || DEFAULT_DEVICE_MUSIC_DIR);
}

/** 去掉尾部斜杠，避免拼出 `//search` */
export function normalizeBase(base: string): string {
  return (base || '').trim().replace(/\/+$/, '');
}

/** 音源搜索地址。约定：`GET {base}/search?keyword=&limit=` 返回歌曲列表 */
export function buildSearchUrl(base: string, keyword: string, limit = 30): string {
  const b = normalizeBase(base);
  return `${b}/search?keyword=${encodeURIComponent(keyword.trim())}&limit=${limit}`;
}

/** 音源取播放地址。约定：`GET {base}/url?id=` 返回 `{ url }` */
export function buildSongUrl(base: string, id: string): string {
  const b = normalizeBase(base);
  return `${b}/url?id=${encodeURIComponent(id)}`;
}

/** 渲染进程不能直连外站（CORS），统一走本地代理 */
export function proxied(url: string): string {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

// ── 结果解析 ──

export interface Song {
  id: string;
  name: string;
  singer: string;
  album: string;
  /** 秒 */
  duration: number;
  /** 音源直接给链接时能省一次请求 */
  url?: string;
}

type Raw = Record<string, unknown>;

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseInt(str(v), 10);
  return Number.isFinite(n) ? n : 0;
}

const LIST_KEYS = ['songs', 'data', 'list', 'result', 'items'];

/** 从音源返回的 JSON 里取歌曲数组，兼容几种常见字段名 */
export function parseSearchResponse(json: unknown): Song[] {
  let list: unknown = json;
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const obj = json as Raw;
    for (const key of LIST_KEYS) {
      if (Array.isArray(obj[key])) {
        list = obj[key];
        break;
      }
    }
    // 有些音源把列表藏在 data.list 里
    if (list === json && obj.data && typeof obj.data === 'object') {
      const inner = obj.data as Raw;
      for (const key of LIST_KEYS) {
        if (Array.isArray(inner[key])) {
          list = inner[key];
          break;
        }
      }
    }
  }
  if (!Array.isArray(list)) return [];
  const out: Song[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Raw;
    const name = str(r.name) || str(r.songname) || str(r.title);
    if (!name) continue;
    out.push({
      id: str(r.id) || str(r.songmid) || str(r.songId) || name,
      name,
      singer: str(r.singer) || str(r.artist) || str(r.author),
      album: str(r.album) || str(r.albumName),
      duration: num(r.duration) || num(r.interval),
      url: str(r.url) || undefined,
    });
  }
  return out;
}

/** 从音源取链接的响应里拿 URL，兼容 `{url}` / `{data:{url}}` / 纯字符串 */
export function pickSongUrl(json: unknown): string {
  if (typeof json === 'string') return json.trim();
  if (!json || typeof json !== 'object') return '';
  const obj = json as Raw;
  const direct = str(obj.url) || str(obj.src) || str(obj.play_url);
  if (/^https?:\/\//i.test(direct)) return direct;
  if (obj.data && typeof obj.data === 'object') {
    const inner = obj.data as Raw;
    const nested = str(inner.url) || str(inner.src) || str(inner.play_url);
    if (/^https?:\/\//i.test(nested)) return nested;
  }
  return '';
}

// ── 文件名 ──

/** 只保留最后一个扩展名，其它 `.` 保留 */
export function guessExt(urlOrName: string): string {
  const clean = (urlOrName || '').split('?')[0].split('#')[0];
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(clean);
  if (!m) return '';
  const ext = '.' + m[1].toLowerCase();
  return AUDIO_EXTS.includes(ext) ? ext : '';
}

/** 把「歌名 - 歌手」变成合法的设备文件名（不含目录） */
export function audioFileName(song: { name: string; singer?: string }, ext = '.mp3'): string {
  const base = [song.name, song.singer].filter(Boolean).join(' - ');
  const safe = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const trimmed = safe.slice(0, 120) || 'audio';
  return trimmed.toLowerCase().endsWith(ext) ? trimmed : trimmed + ext;
}

/** 拼设备路径，顺手把重复斜杠压掉 */
export function joinRemote(dir: string, name: string): string {
  const d = (dir || DEFAULT_DEVICE_MUSIC_DIR).replace(/\/+$/, '');
  return `${d}/${name.replace(/^\/+/, '')}`;
}

/** 本地挑选的文件是否是音频 */
export function isAudioFile(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_EXTS.some((ext) => lower.endsWith(ext));
}

// ── 歌单文本 ──

export interface PlaylistEntry {
  name: string;
  singer: string;
}

/**
 * 解析粘贴进来的歌单文本，每行一首。
 * 支持「歌名 - 歌手」「歌名 – 歌手」「歌名_歌手」「歌名 歌手」和「歌手 - 歌名」（自动识别常见分隔符）。
 */
export function parsePlaylistText(text: string): PlaylistEntry[] {
  const out: PlaylistEntry[] = [];
  for (const line of (text || '').split(/\r?\n/)) {
    const raw = line.replace(/^\s*(\d+[.、)]|\-|\*)\s*/, '').trim();
    if (!raw) continue;
    const parts = raw.split(/\s+[-–—_|]\s+/);
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const singer = parts.slice(1).join(' ').trim();
      if (name) out.push({ name, singer });
    } else {
      out.push({ name: raw, singer: '' });
    }
  }
  return out;
}

// ── 格式化 ──

export function formatDuration(sec: number): string {
  if (!sec || sec < 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// ── 网络（走本地代理）──

async function getJson(url: string): Promise<unknown> {
  const resp = await fetch(proxied(url), { headers: { accept: 'application/json' } });
  const text = await resp.text();
  if (!resp.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: string; detail?: string };
      detail = j.detail || j.error || detail;
    } catch { /* 非 JSON */ }
    throw new Error(`音源请求失败（HTTP ${resp.status}）：${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('音源返回的不是 JSON，检查设置里的音源地址是否正确');
  }
}

/** 搜索歌曲 */
export async function searchSongs(base: string, keyword: string): Promise<Song[]> {
  if (!normalizeBase(base)) throw new Error('还没有配置音源地址，先去「设置 → 音乐」里填');
  const json = await getJson(buildSearchUrl(base, keyword));
  return parseSearchResponse(json);
}

/** 取一首歌的播放/下载地址 */
export async function resolveSongUrl(base: string, song: Song): Promise<string> {
  if (song.url) return song.url;
  const json = await getJson(buildSongUrl(base, song.id));
  const url = pickSongUrl(json);
  if (!url) throw new Error('音源没有返回可用的播放地址');
  return url;
}

/** 下载音频为字节，交给设备推送 */
export async function downloadAudio(url: string): Promise<Uint8Array> {
  const resp = await fetch(proxied(url));
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let detail = text.slice(0, 200);
    try {
      detail = (JSON.parse(text) as { error?: string }).error || detail;
    } catch { /* 非 JSON */ }
    throw new Error(`下载失败（HTTP ${resp.status}）：${detail}`);
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.length > MAX_AUDIO_BYTES) throw new Error(`文件太大（${formatBytes(buf.length)}）`);
  return buf;
}

/** 确保设备目录存在：ADB 用 shell，SSH 用 mkdirp */
export async function ensureRemoteDir(conn: DeviceConnection, dir: string): Promise<void> {
  const target = (dir || DEFAULT_DEVICE_MUSIC_DIR).replace(/\/+$/, '');
  if (conn.mkdirp) {
    await conn.mkdirp(target);
    return;
  }
  // shellCommand 在 SSH 下也能用，但 noShell 连接必须走 mkdirp（上面已处理）
  await conn.shellCommand(`mkdir -p "${target}"`);
}

export interface PushResult {
  ok: boolean;
  remotePath: string;
  error?: string;
}

/** 推一个音频文件到设备 */
export async function pushAudio(
  conn: DeviceConnection,
  dir: string,
  fileName: string,
  data: Uint8Array,
): Promise<PushResult> {
  const remotePath = joinRemote(dir, fileName);
  try {
    await conn.pushFile(data, remotePath);
    return { ok: true, remotePath };
  } catch (e) {
    return { ok: false, remotePath, error: e instanceof Error ? e.message : String(e) };
  }
}
