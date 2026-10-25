import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeviceConnection } from '../../lib/device';
import { ghGet, rawUrl, OTA_REPO, type GhContent, type GhRelease } from '../../lib/github';
import { installOtaZip, type InstallStage } from '../../lib/market-install';
import { IconRefresh, IconZap, IconCheck } from '../../components/icons';

export interface OtaPageProps {
  conn: DeviceConnection | null;
  connected: boolean;
  onLog: (msg: string) => void;
}

interface OtaBuild {
  key: string;
  fileName: string;
  version: string;
  sizeBytes: number;
  url: string;
  prerelease: boolean;
  notes?: string;
}

function Spinner({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" opacity="0.3" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  );
}

function fmtSize(n: number): string {
  if (!n) return '';
  return n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
}

function parseVersion(s: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function cmpVersion(a: OtaBuild, b: OtaBuild): number {
  const va = parseVersion(a.version);
  const vb = parseVersion(b.version);
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
  if (a.prerelease !== b.prerelease) return a.prerelease ? 1 : -1;
  return b.fileName.localeCompare(a.fileName);
}

export function OtaPage({ conn, connected, onLog }: OtaPageProps) {
  const [repoInput, setRepoInput] = useState(`${OTA_REPO.owner}/${OTA_REPO.repo}`);
  const [repo, setRepo] = useState(`${OTA_REPO.owner}/${OTA_REPO.repo}`);
  const [items, setItems] = useState<OtaBuild[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [stage, setStage] = useState<InstallStage | null>(null);
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [showManual, setShowManual] = useState(false);

  const load = useCallback(async (target: string) => {
    setLoading(true); setError(null); setDoneKey(null);
    const [owner, name] = target.split('/');
    try {
      if (!owner || !name) throw new Error('仓库格式应为 owner/repo');
      let builds: OtaBuild[] = [];
      try {
        const files = await ghGet<GhContent[] | GhContent>(`/repos/${owner}/${name}/contents`);
        const list = Array.isArray(files) ? files : [files];
        const zips = list.filter(c => c.type === 'file' && /^update_.*\.zip$/i.test(c.name));
        builds = zips.map(z => {
          const version = z.name.replace(/^update_/i, '').replace(/\.zip$/i, '').replace(/^v/i, '');
          return {
            key: z.name,
            fileName: z.name,
            version,
            sizeBytes: z.size,
            url: z.download_url || rawUrl(owner, name, 'main', z.name),
            prerelease: /-r\d+$|beta|alpha|rc/i.test(version),
          };
        });
      } catch { /* 没有 contents 权限时再试 Release */ }

      if (builds.length === 0) {
        const releases = await ghGet<GhRelease[]>(`/repos/${owner}/${name}/releases?per_page=10`);
        builds = releases.flatMap(r => (r.assets || [])
          .filter(a => /\.zip$/i.test(a.name))
          .map<OtaBuild>(a => ({
            key: r.tag_name + '/' + a.name,
            fileName: a.name,
            version: r.tag_name.replace(/^v/i, ''),
            sizeBytes: a.size,
            url: a.browser_download_url,
            prerelease: r.prerelease,
            notes: (r.body || '').split('\n')[0],
          })));
      }

      builds.sort(cmpVersion);
      setItems(builds);
      onLog(`OTA：${target} 共有 ${builds.length} 个更新包`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [onLog]);

  useEffect(() => { void load(repo); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = useMemo(() => (items && items.length > 0 ? items[0] : null), [items]);

  const run = async (b: OtaBuild) => {
    if (!conn || !connected) { setError('请先连接设备（USB 或 SSH）'); return; }
    setBusyKey(b.key); setStage({ phase: '下载 OTA 包…' }); setError(null); setDoneKey(null);
    onLog(`开始 OTA 更新：${b.fileName} → /userdata/PenMods`);
    try {
      await installOtaZip(conn, b.url, onLog, setStage);
      setDoneKey(b.key);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg); onLog(`✗ OTA 更新失败：${msg}`);
    } finally {
      setBusyKey(null); setStage(null);
    }
  };

  const runManual = async () => {
    const url = manualUrl.trim();
    if (!url || !conn || !connected) return;
    const b: OtaBuild = {
      key: '__manual__', fileName: url.split('/').pop() || 'update.zip',
      version: '自定义', sizeBytes: 0, url, prerelease: false,
    };
    setBusyKey(b.key); setManualUrl('');
    await run(b);
  };

  const reboot = async () => {
    if (!conn || !connected) return;
    try {
      onLog('正在重启设备…');
      await conn.shellCommand('reboot');
    } catch (e) {
      onLog('重启命令已发送：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <section className="space-y-4">
      <div className="card p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#0f172a] flex items-center gap-1.5">
              <IconZap className="w-4 h-4" /> PenMods 更新（OTA）
            </h2>
            <p className="text-[11px] text-[#94a3b8] mt-0.5">
              从 GitHub 拉取更新包，推送到设备并执行官方 <code className="bg-[#f1f5f9] px-1 rounded">_do_update.sh</code>，覆盖 /userdata/PenMods 下的运行时
            </p>
          </div>
          <button onClick={() => void load(repo)} disabled={loading}
            className="text-[11px] px-2 py-1.5 border border-[#e2e8f0] rounded-lg text-[#64748b] hover:bg-[#f8fafc] flex items-center gap-1 flex-shrink-0 disabled:opacity-50">
            {loading ? <Spinner /> : <IconRefresh className="w-3.5 h-3.5" />} 刷新
          </button>
        </div>

        <div className="flex gap-2">
          <div className="flex items-center bg-[#f8fafc] border border-[#e2e8f0] rounded-lg px-2.5 flex-1">
            <span className="text-xs text-[#94a3b8]">github.com/</span>
            <input value={repoInput} onChange={e => setRepoInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const v = repoInput.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, '');
                  setRepo(v); setRepoInput(v); void load(v);
                }
              }}
              className="bg-transparent px-1 py-2 text-xs outline-none flex-1 font-mono text-[#0f172a]" placeholder="owner/repo" />
          </div>
          <button onClick={() => {
            const v = repoInput.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, '');
            setRepo(v); setRepoInput(v); void load(v);
          }} className="text-[11px] px-3 py-1.5 bg-[#0f172a] text-white rounded-lg flex-shrink-0">加载</button>
        </div>

        {latest && (
          <div className="rounded-lg border border-[#bfdbfe] bg-[#eff6ff] px-3 py-2 flex items-center gap-2">
            <span className="text-[11px] text-[#1d4ed8]">最新版本 <b>{latest.version}</b> · {fmtSize(latest.sizeBytes)}</span>
            <button onClick={() => void run(latest)} disabled={!connected || busyKey !== null}
              className="ml-auto text-[11px] px-3 py-1 bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 flex items-center gap-1">
              {busyKey === latest.key ? <><Spinner className="w-3 h-3" />更新中</> : '一键更新到最新'}
            </button>
          </div>
        )}

        {!connected && (
          <p className="text-[11px] text-[#d97706] bg-[#fffbeb] border border-[#fde68a] rounded-lg px-3 py-1.5">
            未连接设备：可以浏览更新包，连上设备后才能推送。
          </p>
        )}
        {error && (
          <div className="flex items-start gap-2 text-[11px] text-[#dc2626] bg-[#fef2f2] border border-[#fecaca] rounded-lg px-3 py-2">
            <span className="flex-1 break-all">{error}</span>
            <button onClick={() => setError(null)} className="text-[#94a3b8]">✕</button>
          </div>
        )}
        {busyKey && stage && (
          <div className="space-y-1">
            <div className="progress-track h-1">
              <div className="progress-bar" style={{
                width: stage.total && stage.received != null
                  ? Math.min(100, Math.round((stage.received / stage.total) * 100)) + '%' : '100%',
              }} />
            </div>
            <div className="text-[10px] text-[#94a3b8]">
              {stage.phase}
              {stage.total && stage.received != null
                ? ` ${(stage.received / 1048576).toFixed(1)}MB / ${(stage.total / 1048576).toFixed(1)}MB` : ''}
            </div>
          </div>
        )}
      </div>

      {doneKey && (
        <div className="card p-3 border-[#bbf7d0] bg-[#f0fdf4] flex items-center gap-2">
          <IconCheck className="w-4 h-4 text-[#16a34a]" />
          <span className="text-[11px] text-[#166534] flex-1">更新已完成，建议重启设备让新的 libPenMods.so 生效。</span>
          <button onClick={() => void reboot()} disabled={!connected}
            className="text-[11px] px-3 py-1.5 bg-[#16a34a] text-white rounded-lg disabled:opacity-40">重启设备</button>
        </div>
      )}

      <div className="card p-3 flex items-center gap-2">
        <span className="text-[11px] text-[#64748b]">自定义更新包地址</span>
        <input value={manualUrl} onChange={e => setManualUrl(e.target.value)} placeholder="https://…/update_vX.zip"
          className="flex-1 px-3 py-1.5 text-xs border border-[#e2e8f0] rounded-lg outline-none focus:border-[#2563eb]" />
        <button onClick={() => setShowManual(s => !s)} className="text-[11px] text-[#94a3b8] hover:text-[#2563eb]">
          {showManual ? '收起' : '说明'}
        </button>
        <button onClick={() => void runManual()} disabled={!connected || !manualUrl || busyKey !== null}
          className="text-[11px] px-3 py-1.5 border border-[#e2e8f0] rounded-lg text-[#0f172a] disabled:opacity-40">推送</button>
      </div>
      {showManual && (
        <div className="card p-3 text-[11px] text-[#64748b] leading-relaxed space-y-1">
          <p>· 更新包是 .zip，内部应包含 <code className="bg-[#f1f5f9] px-1 rounded">_do_update.sh</code> 与 <code className="bg-[#f1f5f9] px-1 rounded">libPenMods.so</code>（2.4.0+ 还会带 libPenModsResources.so）。</p>
          <p>· 执行流程：解压到 /userdisk/__penmods_ota → 找到 _do_update.sh 所在目录 → 以该目录为工作目录执行 → 校验 INSTALL_SUCCESSFULLY → 清理临时文件。</p>
          <p>· 若无 _do_update.sh，会退化为直接把 libPenMods.so / libPenModsResources.so 复制到 /userdata/PenMods。</p>
        </div>
      )}

      {loading && !items && (
        <div className="card p-8 text-center text-xs text-[#94a3b8] flex items-center justify-center gap-2">
          <Spinner /> 正在读取 {repo} 的更新包…
        </div>
      )}

      {items && items.length === 0 && !loading && (
        <div className="card p-6 text-center text-xs text-[#94a3b8]">
          没有找到 update_*.zip 或 Release 附件。请检查仓库名是否正确。
        </div>
      )}

      {items && items.length > 0 && (
        <div className="card divide-y divide-[#e2e8f0]">
          {items.map(b => {
            const busy = busyKey === b.key;
            const finished = doneKey === b.key;
            return (
              <div key={b.key} className="p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-medium text-[#0f172a]">{b.version}</span>
                    {b.prerelease && <span className="text-[10px] text-[#d97706] bg-[#fffbeb] px-1 rounded">预发布</span>}
                    {b === latest && <span className="text-[10px] text-[#16a34a] bg-[#f0fdf4] px-1 rounded">最新</span>}
                    {finished && <span className="text-[10px] text-[#16a34a] bg-[#f0fdf4] px-1 rounded">已更新</span>}
                  </div>
                  <div className="text-[10px] text-[#94a3b8] font-mono truncate">
                    {b.fileName}{b.sizeBytes ? ' · ' + fmtSize(b.sizeBytes) : ''}{b.notes ? ' · ' + b.notes : ''}
                  </div>
                </div>
                <button onClick={() => void run(b)} disabled={!connected || busyKey !== null}
                  className="text-[11px] px-3 py-1.5 rounded-lg border border-[#e2e8f0] text-[#0f172a] hover:bg-[#f8fafc] disabled:opacity-40 flex-shrink-0 flex items-center gap-1">
                  {busy ? <><Spinner className="w-3 h-3" />安装中</> : '安装'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-[#94a3b8] text-center">
        更新源：{repo} · 仅覆盖 PenMods 运行时文件，不动插件与个人数据
      </p>
    </section>
  );
}
