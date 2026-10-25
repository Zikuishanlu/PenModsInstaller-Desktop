/**
 * GitHub 访问层（走本地 /api 代理，避开 CORS 与浏览器限流）
 *
 * - API：/api/gh?path=...
 * - 下载：/api/dl?url=...（支持断点续传重试，网络不稳时尤其重要）
 */
import { PLUGINS_DIR } from './plugin-install';

export const DEFAULT_OWNER = 'skdkzzx';
export const OTA_REPO = { owner: 'Lyrecoul', repo: 'penmods-ota' };

const TOKEN_KEY = 'gh_token';
const OWNER_KEY = 'market_owner';

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setToken(t: string) {
  try { t ? localStorage.setItem(TOKEN_KEY, t.trim()) : localStorage.removeItem(TOKEN_KEY); } catch { /* 隐私模式 */ }
}
export function getOwner(): string {
  try { return (localStorage.getItem(OWNER_KEY) || DEFAULT_OWNER).trim() || DEFAULT_OWNER; } catch { return DEFAULT_OWNER; }
}
export function setOwner(o: string) {
  try { localStorage.setItem(OWNER_KEY, o.trim() || DEFAULT_OWNER); } catch { /* noop */ }
}

export class GhError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'GhError';
  }
}

// ── API ──

export async function ghGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['x-gh-token'] = token;
  let resp: Response;
  try {
    resp = await fetch('/api/gh?path=' + encodeURIComponent(path), { headers });
  } catch (e) {
    throw new GhError(0, '无法连接 GitHub：' + (e instanceof Error ? e.message : String(e)));
  }
  if (!resp.ok) {
    let detail = '';
    try {
      const body = await resp.json() as { message?: string };
      detail = body.message || '';
    } catch { /* 非 JSON */ }
    if (resp.status === 403 && /rate limit/i.test(detail)) {
      throw new GhError(403, 'GitHub API 触发限流，请到「设置」里填入 GitHub Token 后重试');
    }
    if (resp.status === 404) throw new GhError(404, '未找到（仓库/文件不存在，或私有仓库缺少 Token）');
    throw new GhError(resp.status, detail || `GitHub API ${resp.status}`);
  }
  return await resp.json() as T;
}

export interface GhRepo {
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  stargazers_count: number;
  pushed_at: string;
  updated_at: string;
  archived: boolean;
  fork: boolean;
  size: number;
  topics?: string[];
}

export interface GhContent {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  download_url: string | null;
  html_url: string;
  content?: string;
  encoding?: string;
}

export interface GhReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

export interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  assets: GhReleaseAsset[];
}

/** 列出用户仓库（最多 200 个，按最近推送排序） */
export async function listRepos(owner: string): Promise<GhRepo[]> {
  const out: GhRepo[] = [];
  for (const page of [1, 2]) {
    const batch = await ghGet<GhRepo[]>(
      `/users/${owner}/repos?per_page=100&page=${page}&sort=pushed&type=owner`,
    );
    out.push(...batch.filter(r => !r.fork));
    if (batch.length < 100) break;
  }
  return out.filter(r => !r.archived);
}

/** 列出仓库某个目录 */
export async function listContents(owner: string, repo: string, path = ''): Promise<GhContent[]> {
  const p = `/repos/${owner}/${repo}/contents/${path.replace(/^\/+/, '')}`;
  const data = await ghGet<GhContent[] | GhContent>(p);
  return Array.isArray(data) ? data : [data];
}

/** 读取仓库中的文本文件（直接走 raw，省一次 API 配额） */
export async function readRepoText(owner: string, repo: string, branch: string, path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  const bytes = await downloadBytes(url);
  return new TextDecoder('utf-8').decode(bytes);
}

export async function listReleases(owner: string, repo: string, perPage = 8): Promise<GhRelease[]> {
  return ghGet<GhRelease[]>(`/repos/${owner}/${repo}/releases?per_page=${perPage}`);
}

export function repoZipUrl(owner: string, repo: string, branch: string): string {
  return `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
}

export function rawUrl(owner: string, repo: string, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

// ── 下载（带断点续传与重试） ──

export interface DownloadProgress {
  received: number;
  total: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * 通过本机 /api/dl 代理下载，失败时用 Range 续传。
 * 实测移动网络下 raw.githubusercontent.com 经常在中途 ECONNRESET，
 * 所以必须能续传，否则 3MB 的 OTA 包永远下不完。
 */
export async function downloadBytes(
  url: string,
  onProgress?: (p: DownloadProgress) => void,
  attempts = 6,
): Promise<Uint8Array> {
  let chunks: Uint8Array[] = [];
  let received = 0;
  let total = 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const headers: Record<string, string> = {};
    if (received > 0) headers.Range = `bytes=${received}-`;
    let resp: Response;
    try {
      resp = await fetch('/api/dl?url=' + encodeURIComponent(url), { headers, cache: 'no-store' });
    } catch (e) {
      if (attempt === attempts - 1) throw new Error('下载失败：' + (e instanceof Error ? e.message : String(e)));
      await sleep(700 * (attempt + 1));
      continue;
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`下载失败 HTTP ${resp.status}：${detail.slice(0, 200)}`);
    }
    // 服务器不支持 Range（返回 200 且已有数据）→ 从头来
    if (received > 0 && resp.status === 200) {
      chunks = [];
      received = 0;
      total = 0;
    }
    const len = Number(resp.headers.get('content-length') || 0);
    if (resp.status === 206) total = received + len;
    else total = len;

    const reader = resp.body?.getReader();
    if (!reader) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      chunks.push(buf);
      received += buf.length;
      onProgress?.({ received, total: received });
      break;
    }
    let broke = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.length;
          onProgress?.({ received, total });
        }
      }
    } catch {
      broke = true;
    }
    const complete = total > 0 ? received >= total : !broke;
    if (complete) return concat(chunks, received);
    if (attempt === attempts - 1) break;
    await sleep(800 * (attempt + 1));
  }

  // 最后一次不完整 → 报错并带上真实字节数，便于用户判断
  throw new Error(`下载中断：已获取 ${(received / 1024).toFixed(0)}KB / ${total ? (total / 1024).toFixed(0) + 'KB' : '未知'}，请重试`);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ── 设备上的插件目录（供市场显示「已安装」） ──

export async function listInstalledPluginDirs(conn: { readDir(p: string): Promise<{ name: string; isDir: boolean }[]> }): Promise<string[]> {
  try {
    const entries = await conn.readDir(PLUGINS_DIR);
    return entries.filter(e => e.isDir).map(e => e.name);
  } catch {
    return [];
  }
}
