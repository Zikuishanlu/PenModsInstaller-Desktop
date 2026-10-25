import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeviceConnection } from '../../lib/device';
import { discoverApps, type MarketApp } from '../../lib/market';
import { getOwner, getToken, setToken } from '../../lib/github';
import { installMarketApp, type InstallStage } from '../../lib/market-install';
import { IconPackage, IconRefresh } from '../../components/icons';

export interface AppsMarketProps {
  conn: DeviceConnection | null;
  connected: boolean;
  onLog: (msg: string) => void;
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
  if (n > 1048576) return (n / 1048576).toFixed(1) + 'MB';
  return Math.max(1, Math.round(n / 1024)) + 'KB';
}

function stageText(s: InstallStage): string {
  if (s.total && s.received != null) {
    const f = (n: number) => (n / 1048576).toFixed(1) + 'MB';
    return `${s.phase} ${f(s.received)} / ${f(s.total)}`;
  }
  return s.phase;
}

export function AppsMarket({ conn, connected, onLog }: AppsMarketProps) {
  const [owner, setOwner] = useState(getOwner);
  const [ownerInput, setOwnerInput] = useState(getOwner);
  const [items, setItems] = useState<MarketApp[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [stage, setStage] = useState<InstallStage | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [token, setTokenState] = useState(getToken);
  const [manualUrl, setManualUrl] = useState('');
  const [manualKind, setManualKind] = useState<'zip' | 'tar.gz'>('zip');
  const [query, setQuery] = useState('');

  const load = useCallback(async (force: boolean, forOwner: string) => {
    setLoading(true); setError(null);
    try {
      const list = await discoverApps(forOwner, force, msg => onLog(msg));
      setItems(list);
      onLog(`安装包市场：@${forOwner} 共发现 ${list.length} 个安装包`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [onLog]);

  useEffect(() => { void load(false, owner); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyOwner = () => {
    const v = ownerInput.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '');
    if (!v) return;
    setOwner(v); setOwnerInput(v);
    void load(true, v);
  };

  const doInstall = async (app: MarketApp) => {
    if (!conn || !connected) { setError('请先连接设备（USB 或 SSH）'); return; }
    setBusyKey(app.key); setStage({ phase: '准备…' }); setError(null);
    onLog(`开始安装：${app.name}（${app.url}）`);
    try {
      await installMarketApp(conn, app, onLog, setStage);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg); onLog(`✗ 安装失败：${msg}`);
    } finally {
      setBusyKey(null); setStage(null);
    }
  };

  const installManual = async () => {
    const url = manualUrl.trim();
    if (!url || !conn || !connected) return;
    setBusyKey('__url__'); setStage({ phase: '下载…' }); setError(null);
    try {
      await installMarketApp(conn, {
        name: url.split('/').pop() || 'manual-package',
        url, kind: manualKind, sizeBytes: 0,
      }, onLog, setStage);
      setManualUrl('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null); setStage(null);
    }
  };

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(a => [a.name, a.repo, a.description].join(' ').toLowerCase().includes(q));
  }, [items, query]);

  return (
    <section className="space-y-4">
      <div className="card p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#0f172a] flex items-center gap-1.5">
              <IconPackage className="w-4 h-4" /> 安装包市场
            </h2>
            <p className="text-[11px] text-[#94a3b8] mt-0.5">
              自动收集 GitHub Release 里的 .zip / .tar.gz 安装包，以及仓库根目录 <code className="bg-[#f1f5f9] px-1 rounded">app.json</code> 声明的包
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button onClick={() => setShowSettings(s => !s)}
              className="text-[11px] px-2 py-1.5 border border-[#e2e8f0] rounded-lg text-[#64748b] hover:bg-[#f8fafc]">设置</button>
            <button onClick={() => void load(true, owner)} disabled={loading}
              className="text-[11px] px-2 py-1.5 border border-[#e2e8f0] rounded-lg text-[#64748b] hover:bg-[#f8fafc] flex items-center gap-1 disabled:opacity-50">
              {loading ? <Spinner /> : <IconRefresh className="w-3.5 h-3.5" />} 刷新
            </button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex items-center bg-[#f8fafc] border border-[#e2e8f0] rounded-lg px-2.5 flex-shrink-0">
            <span className="text-xs text-[#94a3b8]">github.com/</span>
            <input value={ownerInput} onChange={e => setOwnerInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') applyOwner(); }}
              className="bg-transparent px-1 py-2 text-xs outline-none w-28 font-mono text-[#0f172a]" placeholder="用户名" />
          </div>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索安装包…"
            className="flex-1 px-3 py-2 text-xs border border-[#e2e8f0] rounded-lg outline-none focus:border-[#2563eb]" />
        </div>

        {showSettings && (
          <div className="border border-[#e2e8f0] rounded-lg p-3 space-y-2 bg-[#f8fafc]">
            <label className="text-[10px] text-[#94a3b8] block">GitHub Token（可选）</label>
            <div className="flex gap-2">
              <input value={token} onChange={e => setTokenState(e.target.value)} type="password" placeholder="ghp_…"
                className="flex-1 px-3 py-1.5 text-xs border border-[#e2e8f0] rounded-lg outline-none focus:border-[#2563eb] font-mono bg-white" />
              <button onClick={() => { setToken(token); onLog(token ? '已保存 GitHub Token' : '已清除 GitHub Token'); }}
                className="text-[11px] px-3 py-1.5 bg-[#0f172a] text-white rounded-lg">保存</button>
            </div>
            <label className="text-[10px] text-[#94a3b8] block pt-1">从直链安装（.zip / .tar.gz）</label>
            <div className="flex gap-2">
              <input value={manualUrl} onChange={e => setManualUrl(e.target.value)} placeholder="https://…/app.tar.gz"
                className="flex-1 px-3 py-1.5 text-xs border border-[#e2e8f0] rounded-lg outline-none focus:border-[#2563eb] bg-white" />
              <select value={manualKind} onChange={e => setManualKind(e.target.value as 'zip' | 'tar.gz')}
                className="text-xs border border-[#e2e8f0] rounded-lg px-2 bg-white">
                <option value="zip">zip</option>
                <option value="tar.gz">tar.gz</option>
              </select>
              <button onClick={() => void installManual()} disabled={!connected || !manualUrl || busyKey === '__url__'}
                className="text-[11px] px-3 py-1.5 border border-[#e2e8f0] rounded-lg text-[#0f172a] disabled:opacity-40">安装</button>
            </div>
          </div>
        )}

        {!connected && (
          <p className="text-[11px] text-[#d97706] bg-[#fffbeb] border border-[#fde68a] rounded-lg px-3 py-1.5">
            未连接设备：可以浏览市场，连上设备后才能安装。
          </p>
        )}
        {error && (
          <div className="flex items-start gap-2 text-[11px] text-[#dc2626] bg-[#fef2f2] border border-[#fecaca] rounded-lg px-3 py-2">
            <span className="flex-1 break-all">{error}</span>
            <button onClick={() => setError(null)} className="text-[#94a3b8]">✕</button>
          </div>
        )}
      </div>

      {loading && !items && (
        <div className="card p-8 text-center text-xs text-[#94a3b8] flex items-center justify-center gap-2">
          <Spinner /> 正在扫描 @{owner} 的仓库…
        </div>
      )}

      {filtered && filtered.length === 0 && !loading && (
        <div className="card p-6 space-y-3">
          <p className="text-sm font-medium text-[#0f172a]">@{owner} 下没有可安装的安装包</p>
          <p className="text-[11px] text-[#64748b] leading-relaxed">
            两种发布方式，市场会自动发现：
          </p>
          <p className="text-[11px] text-[#64748b] leading-relaxed">
            <b>① Release 附件</b>：在仓库里发一个 Release，把 <code className="bg-[#f1f5f9] px-1 rounded">xxx.zip</code> /
            <code className="bg-[#f1f5f9] px-1 rounded">xxx.tar.gz</code> 作为附件上传（可附带 install.sh 说明）。
          </p>
          <p className="text-[11px] text-[#64748b] leading-relaxed">
            <b>② app.json 清单</b>：在仓库根目录放 app.json 和压缩包：
          </p>
          <pre className="text-[10px] bg-[#0f172a] text-[#e2e8f0] rounded-lg p-3 overflow-x-auto leading-relaxed">{`{
  "name": "mpv 播放器",
  "version": "1.0.0",
  "description": "词典笔视频播放器",
  "archive": "mpv.tar.gz",
  "installScript": "install.sh",
  "icon": "icon.png"
}`}</pre>
          <p className="text-[11px] text-[#94a3b8]">也可以用「设置 → 从直链安装」直接安装任意 GitHub 附件链接。</p>
        </div>
      )}

      {filtered && filtered.length > 0 && (
        <div className="card divide-y divide-[#e2e8f0]">
          {filtered.map(a => {
            const busy = busyKey === a.key;
            return (
              <div key={a.key} className="p-3 flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-[#f1f5f9] flex items-center justify-center flex-shrink-0 overflow-hidden">
                  {a.iconUrl ? (
                    <img src={a.iconUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <IconPackage className="w-4 h-4 text-[#64748b]" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-medium text-[#0f172a] truncate">{a.name}</span>
                    {a.version && <span className="text-[10px] text-[#2563eb] bg-[#eff6ff] px-1 rounded">v{a.version}</span>}
                    <span className="text-[10px] text-[#94a3b8] bg-[#f8fafc] border border-[#e2e8f0] px-1 rounded">{a.kind}</span>
                    {a.source === 'release' && <span className="text-[10px] text-[#16a34a] bg-[#f0fdf4] px-1 rounded">release</span>}
                  </div>
                  <div className="text-[10px] text-[#94a3b8] truncate mt-0.5">
                    {a.owner}/{a.repo}{a.sizeBytes ? ' · ' + fmtSize(a.sizeBytes) : ''}
                  </div>
                  <p className="text-[11px] text-[#64748b] leading-snug line-clamp-2 mt-1">{a.description || '（无描述）'}</p>
                  {busy && stage && (
                    <div className="mt-2 space-y-1">
                      <div className="progress-track h-1"><div className="progress-bar" style={{ width: pct(stage) }} /></div>
                      <div className="text-[10px] text-[#94a3b8]">{stageText(stage)}</div>
                    </div>
                  )}
                </div>
                <button onClick={() => void doInstall(a)} disabled={!connected || busy}
                  className="text-[11px] px-3 py-1.5 rounded-lg bg-[#2563eb] text-white hover:bg-[#1d4ed8] disabled:opacity-40 flex-shrink-0 flex items-center gap-1">
                  {busy ? <><Spinner className="w-3 h-3" />安装中</> : '安装'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function pct(s: InstallStage): string {
  if (s.total && s.received != null) return Math.min(100, Math.round((s.received / s.total) * 100)) + '%';
  return '100%';
}
