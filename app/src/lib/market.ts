/**
 * 插件市场：自动发现用户仓库里的 metadata.json（PenMods 插件清单）
 *
 * GitHub 没有插件话题（topics）时，只能靠内容识别，因此这里做了两级探测：
 *   1. 仓库根目录 metadata.json
 *   2. 一级子目录（plugin/ plugins/ src/ app/）里的 metadata.json
 */
import {
  listRepos, listContents, readRepoText, rawUrl, repoZipUrl,
  type GhRepo, type GhContent,
} from './github';
import type { PluginMeta } from './plugin-install';

export interface MarketPlugin {
  key: string;
  owner: string;
  repo: string;
  branch: string;
  name: string;
  installName: string;
  version: string;
  author: string;
  description: string;
  stars: number;
  updatedAt: string;
  zipUrl: string;
  iconUrl?: string;
  metaDir: string;
  meta: PluginMeta;
}

const pluginCache = new Map<string, { at: number; data: MarketPlugin[] }>();
const CACHE_TTL = 5 * 60 * 1000;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i]); } catch { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

function metaDirOf(metaPath: string): string {
  const i = metaPath.lastIndexOf('/');
  return i >= 0 ? metaPath.slice(0, i) : '';
}

function installNameOf(meta: PluginMeta, fallback: string): string {
  const icon = typeof meta.icon === 'string' ? meta.icon : '';
  const m = /plugins\/([^/]+)\//i.exec(icon);
  if (m) return m[1];
  if (typeof meta.id === 'string' && /^[a-z0-9._-]+$/i.test(meta.id)) {
    const tail = meta.id.split('.').pop() || '';
    if (tail) return tail;
  }
  return fallback;
}

/** 探测单个仓库是否是插件仓库 */
async function inspectPlugin(owner: string, repo: GhRepo): Promise<MarketPlugin | null> {
  let root: GhContent[];
  try {
    root = await listContents(owner, repo.name);
  } catch (e) {
    console.warn('[market] listContents 失败', repo.name, e instanceof Error ? e.message : String(e));
    return null;
  }
  const hasRootMeta = root.some(c => c.type === 'file' && c.name === 'metadata.json');
  let metaPath = '';
  let metaText = '';

  if (hasRootMeta) {
    metaPath = 'metadata.json';
  } else {
    const candidates = root
      .filter(c => c.type === 'dir')
      .filter(c => /^(plugin|plugins|src|app|source)$/i.test(c.name) || /plugin/i.test(c.name));
    for (const dir of candidates.slice(0, 2)) {
      let sub: GhContent[] = [];
      try { sub = await listContents(owner, repo.name, dir.name); } catch { continue; }
      const hit = sub.find(c => c.type === 'file' && c.name === 'metadata.json');
      if (hit) { metaPath = dir.name + '/metadata.json'; break; }
    }
    if (!metaPath) return null;
  }

  try {
    metaText = await readRepoText(owner, repo.name, repo.default_branch, metaPath);
  } catch (e) {
    console.warn('[market] 读取 metadata 失败', repo.name, metaPath, e instanceof Error ? e.message : String(e));
    return null;
  }
  let meta: PluginMeta;
  try {
    meta = JSON.parse(metaText) as PluginMeta;
  } catch (e) {
    console.warn('[market] metadata 解析失败', repo.name, metaText.slice(0, 80));
    return null;
  }

  const dir = metaDirOf(metaPath);
  const iconFile = /plugins\/[^/]+\/(.+)$/i.exec(String(meta.icon || ''))?.[1] || 'icon.png';
  const iconUrl = rawUrl(owner, repo.name, repo.default_branch, dir ? `${dir}/${iconFile}` : iconFile);

  return {
    key: `${owner}/${repo.name}`,
    owner,
    repo: repo.name,
    branch: repo.default_branch,
    name: String(meta.name || repo.name),
    installName: installNameOf(meta, repo.name),
    version: String(meta.version || ''),
    author: String(meta.author || owner),
    description: String(meta.description || repo.description || ''),
    stars: repo.stargazers_count,
    updatedAt: repo.pushed_at || repo.updated_at,
    zipUrl: repoZipUrl(owner, repo.name, repo.default_branch),
    iconUrl,
    metaDir: dir,
    meta,
  };
}

export async function discoverPlugins(
  owner: string,
  force = false,
  onProgress?: (msg: string) => void,
): Promise<MarketPlugin[]> {
  const cached = pluginCache.get(owner);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  onProgress?.(`正在列出 @${owner} 的仓库…`);
  const repos = await listRepos(owner);
  onProgress?.(`共 ${repos.length} 个仓库，正在识别插件…`);
  const found = await mapLimit(repos, 4, r => inspectPlugin(owner, r));
  const data = found
    .filter((x): x is MarketPlugin => !!x)
    .sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));
  pluginCache.set(owner, { at: Date.now(), data });
  return data;
}
