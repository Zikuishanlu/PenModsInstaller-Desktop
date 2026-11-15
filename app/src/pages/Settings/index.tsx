import { useEffect, useState, type ReactNode } from 'react';
import { ghGet, getOwner, getToken, setOwner, setToken } from '../../lib/github';
import { BRAND } from '../../lib/branding';
import {
  IconCheck, IconEye, IconEyeOff, IconRefresh, IconSettings, IconShield, IconTrash,
} from '../../components/icons';

/**
 * 设置页：把原先散落在各页的设置集中到这里
 *   1. GitHub 访问（Token / 默认市场源）
 *   2. 设备连接（默认连接方式、SSH 主机与端口）
 *   3. 本地数据（清除本应用写入的 localStorage）
 *   4. 关于（版本与链接）
 */

/** 本应用写入 localStorage 的全部 key —— 清除缓存按这个白名单来，不碰别人的数据 */
const LOCAL_KEYS = [
  'gh_token',
  'market_owner',
  'connMode',
  'sshHost',
  'sshPort',
  'pluginsHubTab',
  'appsHubTab',
];

function Card({
  title, desc, icon, children,
}: {
  title: string;
  desc?: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bg-white border border-[#e2e8f0] rounded-xl p-5 space-y-4">
      <div className="flex items-start gap-2">
        <span className="text-[#2563eb] mt-0.5 flex-shrink-0">{icon}</span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[#0f172a]">{title}</h2>
          {desc && <p className="text-[11px] text-[#94a3b8] mt-0.5 leading-relaxed">{desc}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Hint({ kind, children }: { kind: 'ok' | 'error' | 'info'; children: ReactNode }) {
  const style =
    kind === 'ok'
      ? 'text-[#15803d] bg-[#f0fdf4] border-[#bbf7d0]'
      : kind === 'error'
        ? 'text-[#dc2626] bg-[#fef2f2] border-[#fecaca]'
        : 'text-[#64748b] bg-[#f8fafc] border-[#e2e8f0]';
  return (
    <p className={`text-[11px] border rounded-lg px-2.5 py-1.5 ${style}`}>{children}</p>
  );
}

export interface SettingsProps {
  connMode: 'usb' | 'ssh';
  onConnModeChange: (mode: 'usb' | 'ssh') => void;
  sshHost: string;
  onSshHostChange: (host: string) => void;
  sshPort: string;
  onSshPortChange: (port: string) => void;
}

export function Settings(props: SettingsProps) {
  // GitHub
  const [token, setTokenState] = useState(getToken);
  const [showToken, setShowToken] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [owner, setOwnerState] = useState(getOwner);
  const [ownerMsg, setOwnerMsg] = useState<string | null>(null);
  const [rate, setRate] = useState<{ remaining: number; limit: number } | null>(null);
  const [checking, setChecking] = useState(false);
  // 关于
  const [version, setVersion] = useState('');
  // 本地数据
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch('/api/info');
        const info = (await resp.json()) as { version?: string };
        if (!cancelled) setVersion(info.version || '');
      } catch {
        /* 拿不到版本号不影响使用 */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const saveToken = () => {
    setToken(token);
    setRate(null);
    setTokenMsg({
      kind: 'ok',
      text: token.trim() ? '已保存到本机（重启后仍然有效）' : '已清除保存的 Token',
    });
  };

  /** 把底层的 TLS / DNS 错误翻成人话，否则界面上只有一串英文 */
  const friendlyGhError = (text: string): string => {
    if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|self.signed|CERT_/i.test(text)) {
      return '证书校验失败：本机可能有代理/加速器在做 TLS 中间人解密，请先关掉它或换一个网络再试';
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return '域名解析失败，检查网络或 hosts 文件';
    if (/ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(text)) return '连不上 GitHub，检查网络（代理/加速器）';
    return text;
  };

  const checkRate = async () => {
    setChecking(true);
    setTokenMsg(null);
    try {
      // 先把输入框里的值落盘，测的就是当前配置
      setToken(token);
      const data = await ghGet<{ rate?: { remaining: number; limit: number } }>('/rate_limit');
      if (data.rate) {
        setRate(data.rate);
        setTokenMsg({ kind: 'ok', text: `连通正常：剩余 ${data.rate.remaining} / ${data.rate.limit} 次` });
      } else {
        setTokenMsg({ kind: 'error', text: '连通但返回格式异常' });
      }
    } catch (e) {
      setRate(null);
      setTokenMsg({ kind: 'error', text: friendlyGhError(e instanceof Error ? e.message : String(e)) });
    } finally {
      setChecking(false);
    }
  };

  const saveOwner = () => {
    setOwner(owner);
    setOwnerMsg('已保存，市场页刷新后生效');
  };

  const clearLocal = () => {
    const ok = window.confirm(
      '清除本应用保存在本机的设置？\n\n会清掉：GitHub Token、默认市场源、默认连接方式、SSH 主机与端口、两个市场的页签记忆。\n（不会动设备上的任何文件，也不会清安装日志）',
    );
    if (!ok) return;
    for (const key of LOCAL_KEYS) {
      try { localStorage.removeItem(key); } catch { /* 隐私模式 */ }
    }
    setTokenState('');
    setOwnerState('');
    setRate(null);
    setCleared(true);
  };

  const tokenHint = token.trim()
    ? '已配置 Token（限额 5000 次/小时）'
    : '未配置（匿名限额 60 次/小时，市场扫描多时会触发限流）';

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-[#0f172a] flex items-center gap-1.5">
          <IconSettings className="w-4 h-4" /> 设置
        </h2>
        <p className="text-[11px] text-[#94a3b8] mt-0.5">
          这里的配置都只保存在本机（浏览器 localStorage），不会上传到任何地方
        </p>
      </div>

      {/* ── GitHub 访问 ── */}
      <Card
        title="GitHub 访问"
        desc="市场页要读 GitHub API。未配置 Token 时匿名限额 60 次/小时，扫描多个仓库时容易触发限流。"
        icon={<IconShield className="w-4 h-4" />}
      >
        <div className="space-y-2">
          <label className="text-[10px] text-[#94a3b8] block">GitHub Token（可选）</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                value={token}
                onChange={(e) => setTokenState(e.target.value)}
                type={showToken ? 'text' : 'password'}
                placeholder="ghp_… / github_pat_…"
                spellCheck={false}
                className="w-full px-3 py-2 pr-9 text-xs border border-[#e2e8f0] rounded-lg outline-none focus:border-[#2563eb] font-mono"
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                title={showToken ? '隐藏' : '显示'}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#94a3b8] hover:text-[#0f172a] p-0.5"
              >
                {showToken ? <IconEyeOff className="w-4 h-4" /> : <IconEye className="w-4 h-4" />}
              </button>
            </div>
            <button
              onClick={saveToken}
              className="text-[11px] px-3 py-2 bg-[#0f172a] text-white rounded-lg hover:bg-[#1e293b] flex-shrink-0"
            >
              保存
            </button>
            <button
              onClick={() => void checkRate()}
              disabled={checking}
              className="text-[11px] px-3 py-2 border border-[#e2e8f0] rounded-lg text-[#64748b] hover:bg-[#f8fafc] flex items-center gap-1 flex-shrink-0 disabled:opacity-50"
            >
              {checking ? <IconRefresh className="w-3.5 h-3.5 animate-spin" /> : <IconRefresh className="w-3.5 h-3.5" />}
              测试连接
            </button>
          </div>
          <p className="text-[10px] text-[#94a3b8]">{tokenHint}</p>
          {tokenMsg && <Hint kind={tokenMsg.kind}>{tokenMsg.text}</Hint>}
          {rate && (
            <p className="text-[10px] text-[#94a3b8]">
              Core 限额 {rate.remaining} / {rate.limit}（GitHub 每小时重置一次）
            </p>
          )}
          <p className="text-[10px] text-[#94a3b8]">
            在 GitHub <em>Settings → Developer settings → Personal access tokens</em> 生成，只需
            <code className="bg-[#f1f5f9] px-1 rounded mx-0.5">public_repo</code>（或只读 <code className="bg-[#f1f5f9] px-1 rounded">read:user</code>）即可。
          </p>
        </div>

        <div className="space-y-2 pt-1">
          <label className="text-[10px] text-[#94a3b8] block">默认市场源（GitHub 用户名）</label>
          <div className="flex gap-2">
            <div className="flex items-center flex-1 bg-[#f8fafc] border border-[#e2e8f0] rounded-lg px-2.5">
              <span className="text-xs text-[#94a3b8] flex-shrink-0">github.com/</span>
              <input
                value={owner}
                onChange={(e) => { setOwnerState(e.target.value); setOwnerMsg(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') saveOwner(); }}
                placeholder="skdkzzx"
                spellCheck={false}
                className="flex-1 bg-transparent px-1 py-2 text-xs outline-none font-mono text-[#0f172a]"
              />
            </div>
            <button
              onClick={saveOwner}
              className="text-[11px] px-3 py-2 border border-[#e2e8f0] rounded-lg text-[#0f172a] hover:bg-[#f8fafc] flex-shrink-0"
            >
              保存
            </button>
          </div>
          {ownerMsg && <p className="text-[10px] text-[#15803d]">{ownerMsg}</p>}
        </div>
      </Card>

      {/* ── 设备连接 ── */}
      <Card
        title="设备连接"
        desc="选择连接方式，并填好 SSH 的默认地址。切换后立即生效。"
        icon={<IconShield className="w-4 h-4" />}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg bg-[#f1f5f9] p-0.5">
            {([['usb', 'USB 数据线'], ['ssh', 'SSH 无线']] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => props.onConnModeChange(id)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  props.connMode === id
                    ? 'bg-white text-[#0f172a] shadow-sm font-medium'
                    : 'text-[#64748b] hover:text-[#0f172a]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-[#94a3b8] flex-1 min-w-[12rem]">
            USB 需要打开设备的 ADB 调试；SSH 需要设备已开启 SSH 服务（可在「开启 SSH」页打开）。
          </p>
        </div>

        {props.connMode === 'ssh' && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-[#94a3b8] block mb-1">默认主机（IP）</label>
                <input
                  value={props.sshHost}
                  onChange={(e) => props.onSshHostChange(e.target.value)}
                  placeholder="192.168.1.100"
                  spellCheck={false}
                  className="w-full px-3 py-2 text-xs border border-[#e2e8f0] rounded-lg outline-none focus:border-[#2563eb] font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-[#94a3b8] block mb-1">默认端口</label>
                <input
                  value={props.sshPort}
                  onChange={(e) => props.onSshPortChange(e.target.value)}
                  placeholder="22"
                  spellCheck={false}
                  className="w-full px-3 py-2 text-xs border border-[#e2e8f0] rounded-lg outline-none focus:border-[#2563eb] font-mono"
                />
              </div>
            </div>
            <p className="text-[10px] text-[#94a3b8]">
              密码不保存在本机 —— 每次连接时在顶部状态栏输入，默认用户名 <code className="bg-[#f1f5f9] px-1 rounded">root</code>。
            </p>
          </div>
        )}
      </Card>

      {/* ── 本地数据 ── */}
      <Card
        title="本地数据"
        desc="清除本应用写在本机的设置。设备上的文件、安装日志都不受影响。"
        icon={<IconTrash className="w-4 h-4" />}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={clearLocal}
            className="text-[11px] px-3 py-1.5 border border-[#fecaca] text-[#dc2626] rounded-lg hover:bg-[#fef2f2] flex items-center gap-1"
          >
            <IconTrash className="w-3.5 h-3.5" /> 清除本地设置
          </button>
          <span className="text-[10px] text-[#94a3b8]">
            GitHub Token / 市场源 / 连接方式 / SSH 地址 / 页签记忆
          </span>
        </div>
        {cleared && (
          <Hint kind="ok">
            已清除。刷新页面后会回到默认状态
            <button onClick={() => location.reload()} className="ml-2 underline hover:text-[#15803d]">立即刷新</button>
          </Hint>
        )}
      </Card>

      {/* ── 关于 ── */}
      <Card
        title="关于"
        desc={`${BRAND.appName}${version ? ' · v' + version : ''}`}
        icon={<IconCheck className="w-4 h-4" />}
      >
        <div className="text-[11px] text-[#64748b] space-y-1.5">
          <p>
            本项目基于 <a href={BRAND.upstream} target="_blank" rel="noopener" className="text-[#2563eb] hover:underline">PenUniverse/PenMods</a>
            {' '}修改，遵循 {BRAND.license} 协议，仅供学习研究使用。
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <a href={BRAND.repo} target="_blank" rel="noopener" className="text-[#2563eb] hover:underline">项目仓库</a>
            <a href={BRAND.webRepo} target="_blank" rel="noopener" className="text-[#2563eb] hover:underline">网页版源码</a>
            <a href={BRAND.site} target="_blank" rel="noopener" className="text-[#2563eb] hover:underline">在线版</a>
            <a href={BRAND.licenseUrl} target="_blank" rel="noopener" className="text-[#2563eb] hover:underline">{BRAND.license} 许可证</a>
          </div>
          <p className="text-[10px] text-[#94a3b8]">©{BRAND.year} {BRAND.author}</p>
        </div>
      </Card>
    </div>
  );
}

export default Settings;
