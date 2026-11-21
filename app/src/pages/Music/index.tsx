import { useMemo, useRef, useState } from 'react';
import type { DeviceConnection } from '../../lib/device';
import {
  DEFAULT_DEVICE_MUSIC_DIR,
  MAX_AUDIO_BYTES,
  PLATFORMS,
  QUALITY_OPTIONS,
  SEARCH_LIMIT,
  audioFileName,
  configuredPlatforms,
  downloadAudio,
  ensureRemoteDir,
  formatBytes,
  formatDuration,
  guessExt,
  hasAnySource,
  importPlaylist,
  isAudioFile,
  isFavorite,
  loadFavorites,
  loadMusicSettings,
  parseShareLink,
  platformLabel,
  platformShortLabel,
  proxied,
  pushAudio,
  resolveSongUrl,
  saveFavorites,
  searchAllPlatforms,
  searchPlatform,
  toggleFavorite,
  type Platform,
  type Quality,
  type ShareInfo,
  type Song,
} from '../../lib/music';
import {
  IconCheck, IconHeart, IconMusic, IconRefresh, IconSettings, IconTrash, IconUpload, IconX,
} from '../../components/icons';

export interface MusicProps {
  conn: DeviceConnection | null;
  connected: boolean;
  onLog?: (msg: string) => void;
  /** 没配音源时给个跳去设置页的入口 */
  onOpenSettings?: () => void;
}

type Tab = 'local' | 'online' | 'playlist' | 'favorites';

/** 在线搜索的目标：某个平台，或者「全部」 */
type SearchTarget = Platform | 'all';

interface LocalItem {
  file: File;
  name: string;
  size: number;
}

type ItemState = { status: 'idle' | 'running' | 'done' | 'error'; msg?: string };

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'local', label: '本地音乐', hint: '从电脑里挑歌推到笔上' },
  { id: 'online', label: '在线搜歌', hint: '选平台搜索，下载到笔' },
  { id: 'playlist', label: '歌单导入', hint: '粘贴各平台「分享歌单」的链接，批量下载' },
  { id: 'favorites', label: '我的喜欢', hint: '收藏的歌，随时推到笔上' },
];

const SHARE_EXAMPLES = [
  'https://music.163.com/playlist?id=3778678',
  'https://y.qq.com/n/ryqq/playlist/8676288',
  'https://www.kugou.com/yy/special/single/1061309.html',
];

export function Music({ conn, connected, onLog, onOpenSettings }: MusicProps) {
  const [tab, setTab] = useState<Tab>('local');
  const settings = useMemo(() => loadMusicSettings(), []);
  const [devDir] = useState(settings.deviceDir || DEFAULT_DEVICE_MUSIC_DIR);
  const [quality, setQuality] = useState<Quality>(settings.quality);

  const ready = useMemo(() => hasAnySource(settings), [settings]);
  const availablePlatforms = useMemo(() => configuredPlatforms(settings), [settings]);

  // ── 本地 ──
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [localItems, setLocalItems] = useState<LocalItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [localState, setLocalState] = useState<Record<string, ItemState>>({});
  const [pushing, setPushing] = useState(false);

  // ── 在线 ──
  const [target, setTarget] = useState<SearchTarget>('all');
  const [keyword, setKeyword] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState('');
  const [platformErrs, setPlatformErrs] = useState<{ platform: Platform; message: string }[]>([]);
  const [songs, setSongs] = useState<Song[]>([]);
  const [songState, setSongState] = useState<Record<string, ItemState>>({});
  const [previewId, setPreviewId] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');

  // ── 歌单 ──
  const [shareText, setShareText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState('');
  const [importInfo, setImportInfo] = useState<ShareInfo | null>(null);
  const [imported, setImported] = useState<Song[]>([]);
  const [importedState, setImportedState] = useState<Record<string, ItemState>>({});
  const [plRunning, setPlRunning] = useState(false);

  // ── 我的喜欢 ──
  const [favorites, setFavorites] = useState<Song[]>(() => loadFavorites());
  const [favState, setFavState] = useState<Record<string, ItemState>>({});
  const [favRunning, setFavRunning] = useState(false);

  const log = (msg: string) => onLog && onLog(msg);

  const checkReady = (): boolean => {
    if (!conn || !connected) {
      log('音乐：未连接设备');
      return false;
    }
    return true;
  };

  // ── 通用：解析 → 下载 → 推送 ──
  const pushSong = async (
    song: Song,
    setState: (updater: (prev: Record<string, ItemState>) => Record<string, ItemState>) => void,
    key = song.id,
  ): Promise<void> => {
    const conn2 = conn as DeviceConnection;
    setState((s) => ({ ...s, [key]: { status: 'running', msg: '解析链接…' } }));
    try {
      const url = await resolveSongUrl(settings, song, quality);
      setState((s) => ({ ...s, [key]: { status: 'running', msg: '下载中…' } }));
      const data = await downloadAudio(url);
      setState((s) => ({ ...s, [key]: { status: 'running', msg: '推送中…' } }));
      await ensureRemoteDir(conn2, devDir);
      const name = audioFileName(song, guessExt(url) || '.mp3');
      const r = await pushAudio(conn2, devDir, name, data);
      if (!r.ok) throw new Error(r.error || '推送失败');
      setState((s) => ({ ...s, [key]: { status: 'done', msg: formatBytes(data.length) } }));
      log(`音乐：${song.name} → ${r.remotePath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState((s) => ({ ...s, [key]: { status: 'error', msg } }));
      log(`音乐：${song.name} 失败 —— ${msg}`);
    }
  };

  /** 一批歌按顺序推，最多 limit 首 */
  const pushSongs = async (
    list: Song[],
    setState: (updater: (prev: Record<string, ItemState>) => Record<string, ItemState>) => void,
    limit = 30,
  ): Promise<void> => {
    for (const song of list.slice(0, limit)) {
      await pushSong(song, setState);
    }
  };

  // ── 本地文件 ──
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || [])
      .filter((f) => isAudioFile(f.name))
      .map((f) => ({ file: f, name: f.name, size: f.size }));
    setLocalItems(picked);
    setSelected(new Set(picked.map((p) => p.name)));
    setLocalState({});
    e.target.value = '';
  };

  const toggleSelect = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const pushSelected = async () => {
    if (!checkReady()) return;
    const conn2 = conn as DeviceConnection;
    const targets = localItems.filter((it) => selected.has(it.name));
    if (!targets.length) return;
    setPushing(true);
    try {
      await ensureRemoteDir(conn2, devDir);
      for (const it of targets) {
        setLocalState((s) => ({ ...s, [it.name]: { status: 'running', msg: '读取中…' } }));
        try {
          const data = new Uint8Array(await it.file.arrayBuffer());
          if (data.length > MAX_AUDIO_BYTES) throw new Error('文件太大');
          setLocalState((s) => ({ ...s, [it.name]: { status: 'running', msg: '推送中…' } }));
          const r = await pushAudio(conn2, devDir, it.name, data);
          if (!r.ok) throw new Error(r.error || '推送失败');
          setLocalState((s) => ({ ...s, [it.name]: { status: 'done', msg: formatBytes(data.length) } }));
          log(`音乐：已推送 ${it.name} → ${r.remotePath}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setLocalState((s) => ({ ...s, [it.name]: { status: 'error', msg } }));
          log(`音乐：${it.name} 失败 —— ${msg}`);
        }
      }
    } catch (e) {
      log('音乐：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setPushing(false);
    }
  };

  // ── 在线搜歌 ──
  const doSearch = async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setSearching(true);
    setSearchErr('');
    setPlatformErrs([]);
    setSongs([]);
    setSongState({});
    try {
      if (target === 'all') {
        const r = await searchAllPlatforms(settings, kw);
        setSongs(r.songs);
        setPlatformErrs(r.errors);
        log(`音乐：全平台搜索「${kw}」得到 ${r.songs.length} 条`);
      } else {
        const list = await searchPlatform(settings, kw, target);
        setSongs(list);
        log(`音乐：${platformLabel(target)} 搜索「${kw}」得到 ${list.length} 条`);
      }
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  const playSong = async (song: Song) => {
    setPreviewId(song.id);
    setPreviewUrl('');
    try {
      const url = await resolveSongUrl(settings, song, quality);
      setPreviewUrl(proxied(url));
    } catch (e) {
      setPreviewId('');
      setSongState((s) => ({ ...s, [song.id]: { status: 'error', msg: e instanceof Error ? e.message : String(e) } }));
    }
  };

  const onToggleFavorite = (song: Song) => {
    const next = toggleFavorite(favorites, song);
    setFavorites(next);
    saveFavorites(next);
    const added = next.length > favorites.length;
    log(`音乐：${added ? '已加入' : '已移出'}喜欢 —— ${song.name}`);
  };

  // ── 歌单 ──
  const sharePreview = useMemo(() => parseShareLink(shareText), [shareText]);

  const doImport = async () => {
    setImporting(true);
    setImportErr('');
    setImported([]);
    setImportedState({});
    try {
      const r = await importPlaylist(settings, shareText);
      setImportInfo(r.info);
      setImported(r.songs);
      log(`音乐：${platformLabel(r.info.platform)} 歌单导入 ${r.songs.length} 首`);
    } catch (e) {
      setImportInfo(parseShareLink(shareText));
      setImportErr(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const runImported = async () => {
    if (!checkReady()) return;
    if (!imported.length) return;
    setPlRunning(true);
    try {
      await pushSongs(imported, setImportedState);
    } finally {
      setPlRunning(false);
    }
  };

  // ── 我的喜欢 ──
  const runFavorites = async () => {
    if (!checkReady()) return;
    if (!favorites.length) return;
    setFavRunning(true);
    try {
      await pushSongs(favorites, setFavState);
    } finally {
      setFavRunning(false);
    }
  };

  const removeFavorite = (song: Song) => {
    const next = toggleFavorite(favorites, song);
    setFavorites(next);
    saveFavorites(next);
  };

  const clearFavorites = () => {
    setFavorites([]);
    saveFavorites([]);
    setFavState({});
    log('音乐：已清空喜欢列表');
  };

  /** 搜索结果 / 歌单 / 喜欢 共用的歌曲行渲染 */
  const renderSongList = (
    list: Song[],
    state: Record<string, ItemState>,
    setState: (updater: (prev: Record<string, ItemState>) => Record<string, ItemState>) => void,
    opts: { showRemove?: boolean; showPlatform?: boolean } = {},
  ) => (
    <ul className="divide-y divide-[#f1f5f9] border border-[#e2e8f0] rounded-lg overflow-hidden max-h-80 overflow-auto">
      {list.map((song, i) => {
        const st = state[song.id];
        const favored = isFavorite(favorites, song);
        return (
          <li key={`${song.id}:${i}`} className="flex items-center gap-2 px-3 py-2 text-[11px] bg-white hover:bg-[#f8fafc]">
            <button
              onClick={() => onToggleFavorite(song)}
              title={favored ? '从「我的喜欢」里移除' : '加入「我的喜欢」'}
              className={`shrink-0 ${favored ? 'text-[#dc2626]' : 'text-[#cbd5e1] hover:text-[#dc2626]'}`}
            >
              <IconHeart className="w-3.5 h-3.5" filled={favored} />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[#0f172a]">{song.name}</p>
              <p className="truncate text-[10px] text-[#94a3b8]">
                {[song.singer, song.album].filter(Boolean).join(' · ') || '未知歌手'}
              </p>
            </div>
            {opts.showPlatform && song.platform && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-[#f1f5f9] text-[#64748b]">
                {platformShortLabel(song.platform)}
              </span>
            )}
            <span className="text-[#94a3b8] w-12 text-right">{formatDuration(song.duration)}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => void playSong(song)}
                className="text-[11px] px-2 py-0.5 border border-[#e2e8f0] rounded text-[#334155] hover:bg-[#f8fafc]"
              >
                {previewId === song.id && previewUrl ? '重听' : '试听'}
              </button>
              <button
                onClick={() => void pushSong(song, setState)}
                disabled={!connected || st?.status === 'running'}
                className="text-[11px] px-2 py-0.5 bg-[#2563eb] text-white rounded hover:bg-[#1d4ed8] disabled:opacity-50"
              >
                下载到笔
              </button>
              {opts.showRemove && (
                <button
                  onClick={() => removeFavorite(song)}
                  title="从喜欢里移除"
                  className="text-[11px] px-1.5 py-0.5 border border-[#e2e8f0] rounded text-[#64748b] hover:bg-[#f8fafc]"
                >
                  <IconTrash className="w-3 h-3" />
                </button>
              )}
            </div>
            <span className="w-24 text-right shrink-0">
              {st?.status === 'done' && <span className="text-[10px] text-[#15803d] flex items-center justify-end gap-1"><IconCheck className="w-3 h-3" />{st.msg}</span>}
              {st?.status === 'error' && <span className="text-[10px] text-[#dc2626]" title={st.msg}>失败</span>}
              {st?.status === 'running' && <span className="text-[10px] text-[#2563eb]">{st.msg}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );

  const noSourceHint = (
    <div className="text-[11px] text-[#b45309] bg-[#fffbeb] border border-[#fde68a] rounded-lg px-2.5 py-1.5 flex items-center gap-2">
      <span>还没有配置音源。到「设置 → 音乐」里给想用的平台填上音源地址（可以共用一个）。</span>
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          className="ml-auto shrink-0 px-2 py-0.5 border border-[#fde68a] rounded text-[#b45309] hover:bg-[#fef3c7] flex items-center gap-1"
        >
          <IconSettings className="w-3 h-3" /> 去设置
        </button>
      )}
    </div>
  );

  const showOnlinePlatform = target === 'all';

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[#0f172a] flex items-center gap-1.5">
            <IconMusic className="w-4 h-4 text-[#2563eb]" /> 音乐
          </h1>
          <p className="text-[11px] text-[#94a3b8] mt-0.5">
            把歌搬到词典笔上 · 目标目录 <code className="bg-[#f1f5f9] px-1 rounded">{devDir}</code>
            {ready && (
              <span className="ml-1">
                · 音源 {availablePlatforms.length} 个
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <select
            value={quality}
            onChange={(e) => setQuality(e.target.value as Quality)}
            title="下载与试听的音质（由音源决定实际给到哪一个）"
            className="text-[11px] px-2 py-1 border border-[#e2e8f0] rounded-lg text-[#334155] bg-white"
          >
            {QUALITY_OPTIONS.map((q) => (
              <option key={q.value} value={q.value}>{q.label}</option>
            ))}
          </select>
          <span className={`text-[11px] px-2 py-1 rounded-lg ${connected ? 'text-[#15803d] bg-[#f0fdf4]' : 'text-[#b45309] bg-[#fffbeb]'}`}>
            {connected ? '设备已连接' : '未连接设备'}
          </span>
        </div>
      </div>

      <div className="flex gap-1 bg-[#f1f5f9] p-1 rounded-lg w-fit">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            title={t.hint}
            className={`text-[11px] px-3 py-1.5 rounded-md transition-colors ${
              tab === t.id ? 'bg-white text-[#0f172a] font-medium shadow-sm' : 'text-[#64748b] hover:text-[#0f172a]'
            }`}
          >
            {t.label}
            {t.id === 'favorites' && favorites.length > 0 && (
              <span className="ml-1 text-[10px] text-[#94a3b8]">{favorites.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── 本地音乐 ── */}
      {tab === 'local' && (
        <section className="bg-white border border-[#e2e8f0] rounded-xl p-5 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => fileInput.current?.click()}
              className="text-[11px] px-3 py-1.5 border border-[#e2e8f0] rounded-lg text-[#334155] hover:bg-[#f8fafc] flex items-center gap-1"
            >
              <IconUpload className="w-3.5 h-3.5" /> 选择文件夹
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              // webkitdirectory 不在 React 的 input 类型里，用扩展属性的方式塞进去
              {...({ webkitdirectory: '' } as Record<string, string>)}
              onChange={onPickFiles}
            />
            <button
              onClick={() => fileInput.current?.click()}
              className="text-[11px] px-3 py-1.5 border border-[#e2e8f0] rounded-lg text-[#334155] hover:bg-[#f8fafc]"
            >
              选文件…
            </button>
            {localItems.length > 0 && (
              <>
                <span className="text-[11px] text-[#94a3b8]">
                  共 {localItems.length} 首 · 已选 {selected.size}
                </span>
                <button
                  onClick={() => setSelected(selected.size === localItems.length ? new Set() : new Set(localItems.map((i) => i.name)))}
                  className="text-[11px] text-[#2563eb] hover:underline"
                >
                  {selected.size === localItems.length ? '全不选' : '全选'}
                </button>
              </>
            )}
            <button
              onClick={() => void pushSelected()}
              disabled={!selected.size || pushing || !connected}
              className="ml-auto text-[11px] px-3 py-1.5 bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-50"
            >
              {pushing ? '推送中…' : `推送到设备${selected.size ? `（${selected.size}）` : ''}`}
            </button>
          </div>

          {!localItems.length && (
            <p className="text-[11px] text-[#94a3b8]">
              支持 {['mp3', 'flac', 'm4a', 'aac', 'ogg', 'wav', 'ape', 'wma'].join(' / ')}；选完会列出音频文件，勾选后推送到上面那个目录。
            </p>
          )}

          {localItems.length > 0 && (
            <ul className="divide-y divide-[#f1f5f9] border border-[#e2e8f0] rounded-lg overflow-hidden">
              {localItems.map((it) => {
                const st = localState[it.name];
                return (
                  <li key={it.name} className="flex items-center gap-2 px-3 py-2 text-[11px] bg-white hover:bg-[#f8fafc]">
                    <input
                      type="checkbox"
                      checked={selected.has(it.name)}
                      onChange={() => toggleSelect(it.name)}
                      className="accent-[#2563eb]"
                    />
                    <span className="truncate flex-1 text-[#0f172a]" title={it.name}>{it.name}</span>
                    <span className="text-[#94a3b8] w-20 text-right">{formatBytes(it.size)}</span>
                    <span className="w-28 text-right">
                      {st?.status === 'done' && <span className="text-[#15803d] flex items-center justify-end gap-1"><IconCheck className="w-3 h-3" />{st.msg}</span>}
                      {st?.status === 'error' && <span className="text-[#dc2626]" title={st.msg}>失败</span>}
                      {st?.status === 'running' && <span className="text-[#2563eb]">{st.msg}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* ── 在线搜歌 ── */}
      {tab === 'online' && (
        <section className="bg-white border border-[#e2e8f0] rounded-xl p-5 space-y-3">
          {!ready && noSourceHint}

          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => setTarget('all')}
              className={`text-[11px] px-2.5 py-1 rounded-lg border ${
                target === 'all'
                  ? 'bg-[#eff6ff] border-[#bfdbfe] text-[#1d4ed8] font-medium'
                  : 'border-[#e2e8f0] text-[#64748b] hover:bg-[#f8fafc]'
              }`}
            >
              全部平台
            </button>
            {PLATFORMS.map((p) => {
              const configured = !!configuredPlatforms(settings).includes(p);
              return (
                <button
                  key={p}
                  onClick={() => setTarget(p)}
                  title={configured ? `搜索${platformLabel(p)}` : `${platformLabel(p)} 还没配音源`}
                  className={`text-[11px] px-2.5 py-1 rounded-lg border ${
                    target === p
                      ? 'bg-[#eff6ff] border-[#bfdbfe] text-[#1d4ed8] font-medium'
                      : configured
                        ? 'border-[#e2e8f0] text-[#64748b] hover:bg-[#f8fafc]'
                        : 'border-[#f1f5f9] text-[#cbd5e1]'
                  }`}
                >
                  {platformShortLabel(p)}
                  {!configured && <span className="ml-1 text-[9px]">未配</span>}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void doSearch(); }}
              placeholder="歌名 / 歌手，回车搜索"
              className="flex-1 min-w-[200px] text-[12px] px-3 py-1.5 border border-[#e2e8f0] rounded-lg focus:outline-none focus:border-[#2563eb]"
            />
            <button
              onClick={() => void doSearch()}
              disabled={searching || !keyword.trim() || !ready}
              className="text-[11px] px-3 py-1.5 bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-50 flex items-center gap-1"
            >
              <IconRefresh className={`w-3.5 h-3.5 ${searching ? 'animate-spin' : ''}`} />
              {searching ? '搜索中…' : '搜索'}
            </button>
          </div>

          {searchErr && <p className="text-[11px] text-[#dc2626]">{searchErr}</p>}

          {platformErrs.length > 0 && (
            <ul className="text-[11px] text-[#b45309] bg-[#fffbeb] border border-[#fde68a] rounded-lg px-2.5 py-1.5 space-y-0.5">
              {platformErrs.map((e) => (
                <li key={e.platform}>{platformLabel(e.platform)}：{e.message}</li>
              ))}
            </ul>
          )}

          {previewUrl && (
            <div className="border border-[#e2e8f0] rounded-lg p-2 bg-[#f8fafc]">
              <audio controls autoPlay src={previewUrl} className="w-full h-8" />
            </div>
          )}

          {songs.length > 0 && (
            <p className="text-[11px] text-[#94a3b8]">
              共 {songs.length} 首{target === 'all' ? '（多平台合并去重）' : ''}
              {songs.length >= SEARCH_LIMIT * Math.max(1, availablePlatforms.length) ? '，只显示各平台返回的前若干条' : ''}
            </p>
          )}

          {songs.length > 0 && renderSongList(songs, songState, setSongState, { showPlatform: showOnlinePlatform })}

          {songs.length > 0 && (
            <p className="text-[11px] text-[#94a3b8]">点歌名左边的心形可以把歌收进「我的喜欢」。</p>
          )}
        </section>
      )}

      {/* ── 歌单导入 ── */}
      {tab === 'playlist' && (
        <section className="bg-white border border-[#e2e8f0] rounded-xl p-5 space-y-3">
          <p className="text-[11px] text-[#94a3b8]">
            在音乐 App 里点「分享歌单 → 复制链接」，把整段分享文字粘到下面就行。
            支持网易云、QQ 音乐、酷狗、酷我、咪咕；其它平台会把链接原样交给音源解析。
          </p>
          <textarea
            value={shareText}
            onChange={(e) => setShareText(e.target.value)}
            rows={3}
            placeholder={`分享歌单: 我喜欢的音乐 ${SHARE_EXAMPLES[0]}`}
            className="w-full text-[12px] px-3 py-2 border border-[#e2e8f0] rounded-lg focus:outline-none focus:border-[#2563eb] font-mono"
          />
          <div className="flex flex-wrap items-center gap-2">
            {sharePreview ? (
              <span className="text-[11px] text-[#15803d]">
                识别到 {platformLabel(sharePreview.platform)}
                {sharePreview.id ? ` · 歌单 ${sharePreview.id}` : ' · 短链（交给音源解析）'}
                {sharePreview.title ? ` · ${sharePreview.title}` : ''}
              </span>
            ) : (
              <span className="text-[11px] text-[#94a3b8]">还没识别到链接</span>
            )}
            <button
              onClick={() => { setShareText(''); setImported([]); setImportedState({}); setImportInfo(null); setImportErr(''); }}
              className="text-[11px] px-2.5 py-1 border border-[#e2e8f0] rounded-lg text-[#64748b] hover:bg-[#f8fafc] flex items-center gap-1"
            >
              <IconTrash className="w-3.5 h-3.5" /> 清空
            </button>
            <button
              onClick={() => void doImport()}
              disabled={importing || !sharePreview || !ready}
              className="text-[11px] px-3 py-1.5 bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-50 flex items-center gap-1"
            >
              {importing ? <IconRefresh className="w-3.5 h-3.5 animate-spin" /> : <IconMusic className="w-3.5 h-3.5" />}
              {importing ? '解析中…' : '导入歌单'}
            </button>
            {imported.length > 0 && (
              <button
                onClick={() => void runImported()}
                disabled={plRunning || !connected}
                className="ml-auto text-[11px] px-3 py-1.5 bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-50 flex items-center gap-1"
              >
                {plRunning ? <IconRefresh className="w-3.5 h-3.5 animate-spin" /> : null}
                {plRunning ? '下载中…' : `全部下载到笔（${Math.min(imported.length, 30)}）`}
              </button>
            )}
          </div>

          {importErr && <p className="text-[11px] text-[#dc2626]">{importErr}</p>}

          {!ready && noSourceHint}

          {imported.length > 0 && (
            <>
              <p className="text-[11px] text-[#94a3b8]">
                {importInfo ? `${platformLabel(importInfo.platform)} · ` : ''}共 {imported.length} 首
                {imported.length > 30 ? '（只推送前 30 首）' : ''}
              </p>
              {renderSongList(imported, importedState, setImportedState, { showPlatform: false })}
            </>
          )}
        </section>
      )}

      {/* ── 我的喜欢 ── */}
      {tab === 'favorites' && (
        <section className="bg-white border border-[#e2e8f0] rounded-xl p-5 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-[#94a3b8]">共 {favorites.length} 首（保存在本机，最多 500 首）</span>
            <button
              onClick={clearFavorites}
              disabled={!favorites.length}
              className="text-[11px] px-2.5 py-1 border border-[#e2e8f0] rounded-lg text-[#64748b] hover:bg-[#f8fafc] disabled:opacity-50 flex items-center gap-1"
            >
              <IconTrash className="w-3.5 h-3.5" /> 清空
            </button>
            <button
              onClick={() => void runFavorites()}
              disabled={!favorites.length || favRunning || !connected}
              className="ml-auto text-[11px] px-3 py-1.5 bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-50 flex items-center gap-1"
            >
              {favRunning ? <IconRefresh className="w-3.5 h-3.5 animate-spin" /> : <IconUpload className="w-3.5 h-3.5" />}
              {favRunning ? '推送中…' : `全部推到笔上（${Math.min(favorites.length, 30)}）`}
            </button>
          </div>

          {!favorites.length && (
            <p className="text-[11px] text-[#94a3b8]">
              还没有喜欢的歌。去「在线搜歌」或「歌单导入」里点歌名左边的心形，就会出现在这里。
            </p>
          )}

          {favorites.length > 0 && renderSongList(favorites, favState, setFavState, { showRemove: true, showPlatform: true })}
        </section>
      )}

      {!connected && (
        <p className="text-[11px] text-[#94a3b8] flex items-center gap-1">
          <IconX className="w-3 h-3" /> 现在只能搜索/试听；连上设备后才能推送。
        </p>
      )}
    </div>
  );
}

export default Music;
