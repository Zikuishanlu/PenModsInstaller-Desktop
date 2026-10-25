import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeviceConnection } from '../../lib/device';
import {
  discoverPlugins, type MarketPlugin,
} from '../../lib/market';
import { downloadBytes, getOwner, setOwner, getToken, setToken, listInstalledPluginDirs } from '../../lib/github';
import { installPluginBytes, type InstallStage } from '../../lib/market-install';
import { IconRefresh, IconPackage, IconCheck } from '../../components/icons';

export interface PluginMarketProps {
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

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function PluginMarket({ conn, connected, onLog }: PluginMarketProps) {
  const [owner, setOwnerState] = useState(getOwner);
  const [ownerInput, setOwnerInput] = useState(getOwner);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MarketPlugin[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [stage, setStage] = useState<InstallStage | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [token, setTokenState] = useState(getToken);
  const [manualUrl, setManualUrl] = useState('');

  const refreshInstalled = useCallback(async () => {
    if (!connected || !conn) { setInstalled([]); return; }
    setInstalled(await listInstalledPluginDirs(conn));
  }, [connected, conn]);

  const load = useCallback(async (force: boolean, forOwner: string) => {
    setLoading(true); setError(null);
    try {
      const list = await discoverPlugins(forOwner, force, msg => onLog(msg));
      setItems(list);
      onLog(`插件市场：@${forOwner} 共发现 ${list.length} 个插件`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [onLog]);

  useEffect(() => { void load(false, owner); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void refreshInstalled(); }, [refreshInstalled]);

  const applyOwner = () => {
    const v = ownerInput.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '');
    if (!v) return;
    setOwner(v); setOwnerState(v);
    void load(true, v);
  };

  const doInstall = async (p: MarketPlugin) => {
    if (!conn || !connected) { setError('请先连接设备（USB 或 SSH）'); return; }
    setBusyKey(p.key); setStage({ phase: '下载插件…' }); setError(null);
    onLog(`开始安装插件：${p.name} (${p.key})`);
    try {
      const bytes = await downloadBytes(p.zipUrl, (prog) => {
        setStage({ phase: '下载插件…', received: prog.received, total: prog.total });
      });
      await installPluginBytes(conn, bytes, onLog, setStage);
      await refreshInstalled();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg); onLog(`✗ 安装失败：${msg}`);
    } finally {
      setBusyKey(null); setStage(null);
    }
  };

  const installFromUrl = async () => {
    const url = manualUrl.trim();
    if (!url) return;
    if (!conn || !connected) { setError('请先连接设备'); return; }
    setBusyKey('__url__'); setStage({ phase: '下载…' }); setError(null);
    try {
      const bytes = await downloadBytes(url, (prog) => {
        setStage({ phase: '下载…', received: prog.received, total: prog.total });
      });
      await installPluginBytes(conn, bytes, onLog, setStage);
      await refreshInstalled();
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
    return items.filter(p =>
      [p.name, p.repo, p.description, p.author].join(' ').toLowerCase().includes(q));
  }, [items, query]);

  return (
    <section className="space-y-4">
      {/* 工具栏 */}
      <div className="card p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#0f172a] flex items-center gap-1.5">
              <IconPackage className="w-4 h-4" /> 插件市场
            </h2>
            <p className="text-[11px] text-[#94a3b8] mt-0.5">
              自动扫描 GitHub 仓库根目录的 <code className="bg-[#f1f5f9] px-1 rounded">metadata.json</code>，直接装到设备的 PenMods 插件目录
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button onClick={() => setShowSettings(s => !s)}
              className="text-[11px] px-2 py-1.5 border border-[#e2e8f0] rounded-lg text-[#64748b] hover:bg-[#f8fafc]">
              设置
            </button>
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
              className="bg-transparent px-1 py-2 text-xs outline-none w-28 font-mono text-[#0f172a]"
              placeholder="用户名" />
          </div>
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="搜索插件名称 / 描述…"
            className="flex-1 px-3 py-2 text-xs border border-[#e2e8f0] rounded-lg outline-none focus:border-[#2563eb]" />
        </div>

        {showSettings && (
          <div className="border border-[#e2e8f0] rounded-lg p-3 space-y-2 bg-[#f8fafc]">
            <label className="text-[10px] text-[#94a3b8] block">GitHub Token（可选，仅用于提高 API 限额；本地保存）</label>
            <div className="flex gap-2">
              <input value={token} onChange={e => setTokenState(e.target.value)} type="password"
                placeholder="ghp_… / github_pat_…"
                className="flex-1 px-3 py-1.5 text-xs border border-[#e2e8f0] rounded-lg outline-none focus:border-[#2563eb] font-mono bg-white" />
              <button onClick={() => { setToken(token); onLog(token ? '已保存 GitHub Token' : '已清除 GitHub Token'); }}
                className="text-[11px] px-3 py-1.5 bg-[#0f172a] text-white rounded-lg">保存</button>
            </div>
            <p className="text-[10px] text-[#94a3b8]">
              没有 Token 时 GitHub 匿名限额为 60 次/小时，扫描仓库较多时可能触发限流。
            </p>
            <label className="text-[10px] text-[#94a3b8] block pt-1">从 ZIP 地址安装（任意 GitHub / 直链插件包）</label>
            <div className="flex gap-2">
              <input value={manualUrl} onChange={e => setManualUrl(e.target.value)} placeholder="https://…/plugin.zip"
                className="flex-1 px-3 py-1.5 text-xs border border-[#e2e8f0] rounded-lg outline-none focus:border-[#2563eb] bg-white" />
              <button onClick={() => void installFromUrl()} disabled={!connected || !manualUrl || busyKey === '__url__'}
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

      {/* 列表 */}
      {loading && !items && (
        <div className="card p-8 text-center text-xs text-[#94a3b8] flex items-center justify-center gap-2">
          <Spinner /> 正在扫描 @{owner} 的仓库…
        </div>
      )}

      {filtered && filtered.length === 0 && !loading && (
        <div className="card p-6 space-y-3">
          <p className="text-sm font-medium text-[#0f172a]">@{owner} 下没有发现 PenMods 插件</p>
          <p className="text-[11px] text-[#64748b] leading-relaxed">
            插件市场通过仓库里的 <code className="bg-[#f1f5f9] px-1 rounded">metadata.json</code> 识别插件。
            把你的插件推送到 GitHub，并在仓库根目录（或 plugin/、src/ 子目录）放一个 metadata.json 即可：
          </p>
          <pre className="text-[10px] bg-[#0f172a] text-[#e2e8f0] rounded-lg p-3 overflow-x-auto leading-relaxed">{`{
  "id": "com.example.myplugin",
  "name": "我的插件",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "插件说明",
  "icon": "file://userdisk/PenMods/plugins/myplugin/icon.png",
  "main_qml": "main.qml"
}`}</pre>
          <p className="text-[11px] text-[#94a3b8]">
            提示：换成自己的用户名试试，或点「设置」用 ZIP 直链安装。当前源：@{owner}
          </p>
        </div>
      )}

      {filtered && filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map(p => {
            const isInstalled = installed.includes(p.installName);
            const busy = busyKey === p.key;
            return (
              <div key={p.key} className="card p-3 flex flex-col gap-2">
                <div className="flex gap-2.5 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-[#2563eb] to-[#7c3aed] flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {p.iconUrl ? (
                      <img src={p.iconUrl} alt="" className="w-full h-full object-cover"
                        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                    ) : (
                      <span className="text-white text-sm font-semibold">{p.name.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm font-medium text-[#0f172a] truncate">{p.name}</span>
                      {p.version && <span className="text-[10px] text-[#2563eb] bg-[#eff6ff] px-1 rounded flex-shrink-0">v{p.version}</span>}
                      {isInstalled && (
                        <span className="text-[10px] text-[#16a34a] bg-[#f0fdf4] px-1 rounded flex items-center gap-0.5 flex-shrink-0">
                          <IconCheck className="w-2.5 h-2.5" />已装
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-[#94a3b8] truncate">
                      {p.owner}/{p.repo} · ★{p.stars} · {fmtDate(p.updatedAt)}
                    </div>
                  </div>
                </div>
                <p className="text-[11px] text-[#64748b] leading-snug line-clamp-2 min-h-[2.2em]">{p.description || '（无描述）'}</p>
                <div className="flex items-center gap-2 mt-auto">
                  <button onClick={() => void window.penmodsDesktop?.openExternal(`https://github.com/${p.key}`)}
                    className="text-[10px] text-[#94a3b8] hover:text-[#2563eb]">查看仓库</button>
                  <button onClick={() => void doInstall(p)} disabled={!connected || busy}
                    className="ml-auto text-[11px] px-3 py-1.5 rounded-lg bg-[#2563eb] text-white hover:bg-[#1d4ed8] disabled:opacity-40 flex items-center gap-1">
                    {busy ? <><Spinner className="w-3 h-3" />安装中</> : isInstalled ? '重新安装' : '安装'}
                  </button>
                </div>
                {busy && stage && (
                  <div className="space-y-1">
                    <div className="progress-track h-1"><div className="progress-bar" style={{ width: pct(stage) }} /></div>
                    <div className="text-[10px] text-[#94a3b8]">{stageText(stage)}</div>
                  </div>
                )}
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

function stageText(s: InstallStage): string {
  if (s.total && s.received != null) {
    const mb = (n: number) => (n / 1048576).toFixed(1) + 'MB';
    return `${s.phase} ${mb(s.received)} / ${mb(s.total)}`;
  }
  return s.phase;
}
