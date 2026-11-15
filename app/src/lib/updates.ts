/**
 * 桌面端本体的更新检查。
 *
 * 只和 GitHub Release 的 tag 比大小，不自动下载、不自动安装 ——
 * 安装器自己换版本的风险比设备侧大，交给用户点链接去下载更稳妥。
 *
 * 纯逻辑（版本比较、结果判定）不碰网络，方便冒烟测试。
 */
import { ghGet } from './github';

/** 本体的仓库 —— 检查更新只看这个，和设备侧 OTA（Lyrecoul/penmods-ota）无关 */
export const RELEASE_REPO = 'Zikuishanlu/PenModsInstaller-Desktop';

/** GitHub `releases/latest` 里用到的字段 */
export interface ReleaseInfo {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
}

export interface UpdateCheck {
  /** 当前版本（原样，如 1.0.0） */
  current: string;
  /** 最新版本（去掉 v 前缀，如 1.0.1） */
  latest: string;
  hasUpdate: boolean;
  /** 发布页地址（让用户自己去下，不直连 exe） */
  url: string;
  /** 发布说明，裁到几百字 */
  notes: string;
  publishedAt: string;
}

/** 版本号里的数字段：`v1.2.3-beta.1` → [1, 2, 3, 1] */
export function parseVersion(v: string): number[] {
  const m = /(\d+(?:\.\d+)*)/.exec(v || '');
  if (!m) return [];
  return m[1]
    .split('.')
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * 比较两个版本号：a 比 b 新返回正数，相同返回 0，旧返回负数。
 * 段数不同时缺的段按 0 算（1.2 === 1.2.0）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa.length || !pb.length) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const MAX_NOTES = 800;

/** 把 release 和当前版本拼成一份可展示的结论 */
export function evaluateRelease(current: string, release: ReleaseInfo): UpdateCheck {
  const tag = (release.tag_name || release.name || '').trim();
  const latest = tag.replace(/^v/i, '');
  const notes = (release.body || '').trim().slice(0, MAX_NOTES);
  return {
    current,
    latest: latest || current,
    hasUpdate: !!latest && compareVersions(latest, current) > 0,
    url: release.html_url || `https://github.com/${RELEASE_REPO}/releases`,
    notes,
    publishedAt: release.published_at || '',
  };
}

/** 拉最新 release 并判定 —— 网络错误由调用方处理（GhError 里有中文提示） */
export async function checkInstallerUpdate(current: string): Promise<UpdateCheck> {
  const release = await ghGet<ReleaseInfo>(`/repos/${RELEASE_REPO}/releases/latest`);
  return evaluateRelease(current, release);
}
