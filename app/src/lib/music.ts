/**
 * 音乐模块的核心逻辑（本地文件 / 多平台音源搜索 / 歌单解析 / 我喜欢的歌）。
 *
 * 设计参考 LX Music（lyswhut/lx-music-desktop）的「多音源 + 自定义源」思路：
 * 界面上可以切换网易云 / QQ / 酷狗 / 酷我 / 咪咕等平台，也可以「全部平台」聚合搜索；
 * 每个平台的解析接口由用户自己在设置里填，安装器只负责请求、下载、推送到设备。
 *
 * 音源约定（每个平台一行地址，可以是同一个服务，也可以是各自独立的服务）：
 *   GET {base}/search?keyword=&limit=&platform=
 *   GET {base}/url?id=&platform=&quality=
 *   GET {base}/playlist?platform=&id=&url=
 *
 * 纯函数部分不碰网络，方便冒烟测试。
 */
import type { DeviceConnection } from './device';

// ── 常量 ──

/** 设备上的音乐目录（和系统音乐 App 认的目录一致） */
export const DEFAULT_DEVICE_MUSIC_DIR = '/userdisk/Music';

/** 设置里存的 key */
export const LS_MUSIC_SOURCES = 'music_sources';
/** 老版本的单一音源地址，仍然兼容：所有没单独配置的平台都用它兜底 */
export const LS_MUSIC_SOURCE = 'music_source';
export const LS_MUSIC_DIR = 'music_device_dir';
export const LS_MUSIC_QUALITY = 'music_quality';

/** 本地选择时认的音频扩展名 */
export const AUDIO_EXTS = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.ape', '.wma'];

/** 单个文件上限，和 /api/proxy 的限制对齐 */
export const MAX_AUDIO_BYTES = 120 * 1024 * 1024;

/** 一次搜索/歌单最多取多少首 */
export const SEARCH_LIMIT = 30;

// ── 平台 ──

export type Platform = 'netease' | 'qq' | 'kugou' | 'kuwo' | 'migu' | 'other';

/** 设置页里可单独配置音源的平台（顺序就是界面上 chips 的顺序） */
export const PLATFORMS: Platform[] = ['netease', 'qq', 'kugou', 'kuwo', 'migu'];

const PLATFORM_LABEL: Record<Platform, string> = {
  netease: '网易云音乐',
  qq: 'QQ 音乐',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  migu: '咪咕音乐',
  other: '其它平台',
};

/** 平台名，界面上显示用 */
export function platformLabel(p: Platform): string {
  return PLATFORM_LABEL[p] || '其它平台';
}

/** 搜索结果里每首歌标平台用的短名，避免表格被撑开 */
export function platformShortLabel(p: Platform): string {
  switch (p) {
    case 'netease':
      return '网易云';
    case 'qq':
      return 'QQ';
    case 'kugou':
      return '酷狗';
    case 'kuwo':
      return '酷我';
    case 'migu':
      return '咪咕';
    default:
      return '其它';
  }
}

/** 解析出来的平台是否是配置里能单独设音源的那几个 */
export function isKnownPlatform(p: string): p is Platform {
  return (PLATFORMS as string[]).includes(p) || p === 'other';
}

// ── 音质 ──

export type Quality = '128k' | '320k' | 'flac' | 'flac24bit';

export const DEFAULT_QUALITY: Quality = '320k';

export const QUALITY_OPTIONS: { value: Quality; label: string }[] = [
  { value: '128k', label: '标准 128k' },
  { value: '320k', label: '高品 320k' },
  { value: 'flac', label: '无损 FLAC' },
  { value: 'flac24bit', label: 'Hi-Res 24bit' },
];

export function isQuality(v: unknown): v is Quality {
  return QUALITY_OPTIONS.some((q) => q.value === v);
}

// ── 音源配置 ──

/** 平台 → 音源根地址 */
export type SourceMap = Partial<Record<Platform, string>>;

export interface MusicSettings {
  /** 各平台各自的音源地址 */
  sources: SourceMap;
  /** 兜底音源：没有单独配置的平台都用它 */
  fallback: string;
  /** 推送到设备上的目录 */
  deviceDir: string;
  /** 下载/播放用的音质 */
  quality: Quality;
}

/** 去掉尾部斜杠，避免拼出 `//search` */
export function normalizeBase(base: string): string {
  return (base || '').trim().replace(/\/+$/, '');
}

function readLs(key: string): string {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem(key)) || '';
  } catch {
    return '';
  }
}

function writeLs(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // 隐私模式 / 配额满：配置存不下也不该让页面崩
  }
}

export function loadMusicSettings(): MusicSettings {
  const sources: SourceMap = {};
  const raw = readLs(LS_MUSIC_SOURCES);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const p of PLATFORMS) {
        const v = parsed[p];
        if (typeof v === 'string' && v.trim()) sources[p] = normalizeBase(v);
      }
    } catch {
      // 坏数据当作没配
    }
  }
  const qualityRaw = readLs(LS_MUSIC_QUALITY);
  return {
    sources,
    fallback: normalizeBase(readLs(LS_MUSIC_SOURCE)),
    deviceDir: readLs(LS_MUSIC_DIR).trim() || DEFAULT_DEVICE_MUSIC_DIR,
    quality: isQuality(qualityRaw) ? qualityRaw : DEFAULT_QUALITY,
  };
}

export function saveMusicSettings(settings: MusicSettings): void {
  const clean: SourceMap = {};
  for (const p of PLATFORMS) {
    const v = normalizeBase(settings.sources[p] || '');
    if (v) clean[p] = v;
  }
  writeLs(LS_MUSIC_SOURCES, JSON.stringify(clean));
  writeLs(LS_MUSIC_SOURCE, normalizeBase(settings.fallback));
  writeLs(LS_MUSIC_DIR, settings.deviceDir.trim() || DEFAULT_DEVICE_MUSIC_DIR);
  writeLs(LS_MUSIC_QUALITY, isQuality(settings.quality) ? settings.quality : DEFAULT_QUALITY);
}

/** 某个平台用哪个音源：优先自己的，其次兜底 */
export function sourceBaseFor(settings: MusicSettings, platform: Platform): string {
  return normalizeBase(settings.sources[platform] || '') || normalizeBase(settings.fallback);
}

/** 有没有至少配了一个音源 */
export function hasAnySource(settings: MusicSettings): boolean {
  if (normalizeBase(settings.fallback)) return true;
  return PLATFORMS.some((p) => normalizeBase(settings.sources[p] || ''));
}

/** 已经配好音源的平台（聚合搜索只查这些） */
export function configuredPlatforms(settings: MusicSettings): Platform[] {
  return PLATFORMS.filter((p) => !!sourceBaseFor(settings, p));
}

// ── 接口地址 ──

/** 音源搜索地址。约定：`GET {base}/search?keyword=&limit=&platform=` 返回歌曲列表 */
export function buildSearchUrl(base: string, keyword: string, limit = SEARCH_LIMIT, platform?: Platform): string {
  const b = normalizeBase(base);
  const query = [`keyword=${encodeURIComponent(keyword.trim())}`, `limit=${limit}`];
  if (platform) query.push('platform=' + platform);
  return `${b}/search?${query.join('&')}`;
}

/** 音源取播放地址。约定：`GET {base}/url?id=&platform=&quality=` 返回 `{ url }` */
export function buildSongUrl(base: string, id: string, platform?: Platform, quality?: Quality): string {
  const b = normalizeBase(base);
  const query = ['id=' + encodeURIComponent(id)];
  if (platform) query.push('platform=' + platform);
  if (quality) query.push('quality=' + quality);
  return `${b}/url?${query.join('&')}`;
}

/** 音源解析歌单。约定：`GET {base}/playlist?platform=&id=&url=` 返回和搜索一样的歌曲列表 */
export function buildPlaylistUrl(base: string, info: Pick<ShareInfo, 'platform' | 'id' | 'url'>): string {
  const b = normalizeBase(base);
  const query = ['platform=' + info.platform];
  if (info.id) query.push('id=' + encodeURIComponent(info.id));
  if (info.url) query.push('url=' + encodeURIComponent(info.url));
  return `${b}/playlist?${query.join('&')}`;
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
  /** 来自哪个平台（聚合搜索结果里用） */
  platform?: Platform;
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

const LIST_KEYS = ['songs', 'playlist', 'data', 'list', 'result', 'items'];

function pickList(json: unknown): unknown {
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
  return list;
}

/** 从音源返回的 JSON 里取歌曲数组，兼容几种常见字段名 */
export function parseSearchResponse(json: unknown, platform?: Platform): Song[] {
  const list = pickList(json);
  if (!Array.isArray(list)) return [];
  const out: Song[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Raw;
    const name = str(r.name) || str(r.songname) || str(r.title);
    if (!name) continue;
    const song: Song = {
      id: str(r.id) || str(r.songmid) || str(r.songId) || name,
      name,
      singer: str(r.singer) || str(r.artist) || str(r.author),
      album: str(r.album) || str(r.albumName),
      duration: num(r.duration) || num(r.interval),
      url: str(r.url) || undefined,
    };
    const p = str(r.platform);
    if (platform) song.platform = platform;
    else if (p && isKnownPlatform(p)) song.platform = p;
    out.push(song);
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

/** 同一首歌的判定：名字 + 歌手（id 各平台不通用，换音源后还能认出来） */
export function songKey(song: Pick<Song, 'name' | 'singer'>): string {
  return `${song.name}`.trim().toLowerCase() + '__' + `${song.singer || ''}`.trim().toLowerCase();
}

/** 合并多平台结果：同一首歌只留第一条（先来的平台优先） */
export function dedupeSongs(list: Song[]): Song[] {
  const seen = new Set<string>();
  const out: Song[] = [];
  for (const song of list) {
    const key = songKey(song);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(song);
  }
  return out;
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

// ── 歌单分享链接 ──

export interface ShareInfo {
  platform: Platform;
  /** 平台侧歌单 id；短链或识别不出来时为空 */
  id: string;
  /** 原始链接 */
  url: string;
  /** 分享文本里的标题，能取到就带上，方便在界面上确认 */
  title: string;
}

function platformOfHost(host: string): Platform {
  const h = host.toLowerCase();
  if (h.endsWith('music.163.com') || h.endsWith('163cn.tv')) return 'netease';
  // y.qq.com / c6.y.qq.com / i.y.qq.com 都归 QQ 音乐
  if (h.endsWith('qq.com')) return 'qq';
  if (h.endsWith('kugou.com')) return 'kugou';
  if (h.endsWith('kuwo.cn')) return 'kuwo';
  if (h.endsWith('migu.cn')) return 'migu';
  return 'other';
}

const ID_PATTERNS: Record<Platform, RegExp[]> = {
  netease: [/\/(?:playlist|discover\/toplist)\/(\d+)/, /[?&]id=(\d+)/],
  qq: [/[?&]disstid=(\d+)/, /\/playlist\/(\d+)/, /\/playsquare\/(\d+)/, /\/taoge\/(\d+)/],
  kugou: [/\/single\/(\d+)\.html/, /\/plist\/list\/(\d+)/, /\/special\/single\/(\d+)/],
  kuwo: [/\/playlist_detail\/(\d+)/, /\/playlist\/(\d+)/, /[?&]id=(\d+)/],
  migu: [/\/playlist\/(\d+)/, /[?&]id=(\d+)/],
  other: [/[?&](?:id|playlistid|disstid)=(\d+)/, /\/(\d{5,})(?:[/?.]|$)/],
};

/**
 * 从「分享歌单」的整段文字里认出平台和歌单 id。
 *
 * 各平台分享出来的都是夹在文案里的链接（如 `分享歌单: xxx https://music.163.com/playlist?id=123`），
 * 所以先抓第一个链接，再按域名判断平台、按路径/参数取 id。
 * 短链（163cn.tv / c6.y.qq.com）拿不到 id，就把整条链接交给音源去解析。
 */
export function parseShareLink(text: string): ShareInfo | null {
  const src = (text || '').trim();
  if (!src) return null;
  const m = /https?:\/\/[^\s"'<>）)】]+/.exec(src);
  if (!m) return null;
  const rawUrl = m[0].replace(/[.,，。；;、]+$/, '');
  // 网易云经常是 https://music.163.com/#/playlist?id=xxx 这种 hash 形式
  const normalized = rawUrl.replace('/#/', '/');
  let u: URL;
  try {
    u = new URL(normalized);
  } catch {
    return null;
  }
  const platform = platformOfHost(u.hostname);
  const haystack = u.pathname + '?' + u.search;
  let id = '';
  for (const re of ID_PATTERNS[platform]) {
    const hit = re.exec(haystack);
    if (hit && hit[1]) {
      id = hit[1];
      break;
    }
  }
  const title = src
    .replace(m[0], ' ')
    .replace(/分享歌单|分享歌曲|来自|歌单|@[\w-]+|[:：]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return { platform, id, url: rawUrl, title };
}

// ── 我喜欢的歌 ──

export const LS_MUSIC_FAVORITES = 'music_favorites';

/** 喜欢列表上限，防止 localStorage 无限长胖 */
export const MAX_FAVORITES = 500;

function isSongLike(v: unknown): v is Song {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s.name === 'string' && s.name.trim().length > 0;
}

export function loadFavorites(): Song[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(LS_MUSIC_FAVORITES);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(isSongLike).slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

export function saveFavorites(list: Song[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(LS_MUSIC_FAVORITES, JSON.stringify(list.slice(0, MAX_FAVORITES)));
  } catch {
    // 隐私模式 / 配额满，忽略即可：喜欢列表丢一次比让页面崩掉好
  }
}

/** 保留旧名字，外部代码和测试还在用 */
export const favoriteKey = songKey;

export function isFavorite(list: Song[], song: Song): boolean {
  const key = songKey(song);
  return list.some((s) => songKey(s) === key);
}

/** 在列表里切换喜欢状态，返回新数组（已经存在就删掉） */
export function toggleFavorite(list: Song[], song: Song): Song[] {
  const key = songKey(song);
  if (list.some((s) => songKey(s) === key)) {
    return list.filter((s) => songKey(s) !== key);
  }
  const next: Song = {
    id: song.id,
    name: song.name,
    singer: song.singer || '',
    album: song.album || '',
    duration: song.duration || 0,
    ...(song.url ? { url: song.url } : {}),
    ...(song.platform ? { platform: song.platform } : {}),
  };
  return [next, ...list].slice(0, MAX_FAVORITES);
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
    } catch {
      /* 非 JSON */
    }
    throw new Error(`音源请求失败（HTTP ${resp.status}）：${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('音源返回的不是 JSON，检查设置里的音源地址是否正确');
  }
}

const NO_SOURCE_HINT = '还没有配置音源地址，先去「设置 → 音乐」里填';

function requireBase(base: string, hint = NO_SOURCE_HINT): string {
  const b = normalizeBase(base);
  if (!b) throw new Error(hint);
  return b;
}

/** 在单个平台搜索 */
export async function searchPlatform(
  settings: MusicSettings,
  keyword: string,
  platform: Platform,
): Promise<Song[]> {
  const base = requireBase(
    sourceBaseFor(settings, platform),
    `还没有配置 ${platformLabel(platform)} 的音源，先去「设置 → 音乐」里填`,
  );
  if (!keyword.trim()) throw new Error('先输入要搜的歌名');
  const json = await getJson(buildSearchUrl(base, keyword, SEARCH_LIMIT, platform));
  return parseSearchResponse(json, platform);
}

export interface AggregateResult {
  songs: Song[];
  /** 每个平台的失败原因，成功的不出现 */
  errors: { platform: Platform; message: string }[];
}

/**
 * 聚合搜索：把配好音源的平台都问一遍，按顺序合并去重。
 *
 * 参考 LX Music 的「全部音源」体验：某个平台挂了不影响其它平台出结果，
 * 失败原因收集到 errors 里给界面展示。
 */
export async function searchAllPlatforms(settings: MusicSettings, keyword: string): Promise<AggregateResult> {
  const platforms = configuredPlatforms(settings);
  if (!platforms.length) throw new Error(NO_SOURCE_HINT);
  if (!keyword.trim()) throw new Error('先输入要搜的歌名');

  const settled = await Promise.all(
    platforms.map(async (platform) => {
      try {
        const songs = await searchPlatform(settings, keyword, platform);
        return { platform, songs, error: '' };
      } catch (e) {
        return { platform, songs: [] as Song[], error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  const songs = dedupeSongs(settled.flatMap((r) => r.songs));
  const errors = settled.filter((r) => r.error).map((r) => ({ platform: r.platform, message: r.error }));
  return { songs, errors };
}

export interface PlaylistImport {
  info: ShareInfo;
  songs: Song[];
}

/** 解析「分享歌单」文本 → 对应平台的音源 → 歌曲列表 */
export async function importPlaylist(settings: MusicSettings, text: string): Promise<PlaylistImport> {
  const info = parseShareLink(text);
  if (!info) throw new Error('没认出歌单链接，把平台里「分享歌单」的整段文字粘进来试试');
  const base = requireBase(
    sourceBaseFor(settings, info.platform),
    `还没有配置 ${platformLabel(info.platform)} 的音源，先去「设置 → 音乐」里填这一行`,
  );
  const json = await getJson(buildPlaylistUrl(base, info));
  const songs = parseSearchResponse(json, info.platform);
  if (!songs.length) {
    throw new Error(`音源没有解析出 ${platformLabel(info.platform)} 的歌单，可能它还只支持搜索`);
  }
  return { info, songs };
}

/** 取一首歌的播放/下载地址（按歌曲所属平台选音源） */
export async function resolveSongUrl(settings: MusicSettings, song: Song, quality?: Quality): Promise<string> {
  if (song.url) return song.url;
  const platform = song.platform || 'other';
  const base = requireBase(
    sourceBaseFor(settings, platform),
    `还没有配置 ${platformLabel(platform)} 的音源，先去「设置 → 音乐」里填`,
  );
  const json = await getJson(buildSongUrl(base, song.id, song.platform, quality || settings.quality));
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
    } catch {
      /* 非 JSON */
    }
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
