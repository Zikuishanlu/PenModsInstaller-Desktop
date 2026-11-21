/**
 * 冒烟测试：不需要词典笔、不需要联网也能跑。
 *
 *   node --experimental-transform-types tests/smoke.mjs
 *   npm run smoke
 *
 * 分四段：
 *   1. 业务逻辑（路径安全、ZIP 解析、GitHub 错误映射、脚本生成、PTY 会话）
 *   2. 插件安装链路（mock 设备：ADB shell 模式 / SFTP 模式）
 *   3. 一键安装主流程（mock 设备：推送、脚本步骤、失败中止）
 *   4. 本地服务 HTTP（需要先 `npm run build` 产出 dist；没有就跳过）
 *
 * 为什么不用 vitest：仓库里没有装 vitest，CI 也不跑测试；这套只用 Node 自带能力，
 * 装上依赖就能直接跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const tmpLib = path.join(appRoot, '.smoke-lib');
// 上面几段会用假 fetch 打桩，这里先留一份真的给服务端测试用
const realFetch = globalThis.fetch;

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail: String(detail || '') });
};
const section = (title) => results.push({ section: title });
async function attempt(name, fn) {
  try {
    const r = await fn();
    ok(name, r === true, r === true ? '' : r);
  } catch (e) {
    ok(name, false, 'throw: ' + (e && e.message));
  }
}

// ── 准备：把 src/lib 复制一份，给相对 import 补上 .ts 后缀（Node 的类型擦除要求显式扩展名）──
function prepareLibCopy() {
  const src = path.join(appRoot, 'src', 'lib');
  fs.rmSync(tmpLib, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpLib, 'lib'), { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (!name.endsWith('.ts')) continue;
    const text = fs
      .readFileSync(path.join(src, name), 'utf8')
      .replace(/from '(\.\/[A-Za-z0-9_-]+)'/g, "from '$1.ts'");
    fs.writeFileSync(path.join(tmpLib, 'lib', name), text);
  }
}
prepareLibCopy();

const libPath = (name) => pathToFileURL(path.join(tmpLib, 'lib', name + '.ts')).href;
const pi = await import(libPath('plugin-install'));
const filesLib = await import(libPath('files'));
const gh = await import(libPath('github'));
const store = await import(libPath('app-store'));
const stepsLib = await import(libPath('steps'));
const updatesLib = await import(libPath('updates'));
const musicLib = await import(libPath('music'));
const installerLib = await import(libPath('installer'));

// 渲染层用 localStorage 存 token/owner；Node 下给个替身
if (!globalThis.localStorage) {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
}

// ═══════════════ 1. 业务逻辑 ═══════════════
section('1. 业务逻辑');

await attempt('插件名净化：拦截命令注入', () => {
  const got = pi.sanitizePluginName('a";reboot;#');
  return /^[A-Za-z0-9._-]+$/.test(got) && !got.includes(';') ? true : got;
});
await attempt('插件名净化：拦截 ..（目录逃逸）', () => pi.sanitizePluginName('../..') === '');
await attempt('插件名净化：保留中文与数字', () => pi.sanitizePluginName('电子书阅读器 v1.4.0') === '电子书阅读器_v1.4.0');
await attempt('safeJoin 拒绝 ../ 穿越', () => {
  try { pi.safeJoin('/base', '../../etc/passwd'); return '没有抛错'; }
  catch (e) { return /非法路径/.test(e.message) ? true : e.message; }
});
await attempt('safeJoin 拒绝绝对路径', () => {
  try { pi.safeJoin('/base', '/etc/passwd'); return '没有抛错'; } catch { return true; }
});
await attempt('safeJoin 正常拼接', () => pi.safeJoin('/base', 'a/b.js') === '/base/a/b.js');
await attempt('pickMetadata 跳过源码目录、取层级最浅', () => pi.pickMetadata(['p/源码/metadata.json', 'p/metadata.json']) === 'p/metadata.json');
await attempt('resolveName 优先 metadata.icon 里的 plugins/<名>', () => pi.resolveName({ icon: 'x/plugins/MyPlug/icon.png' }, '/tmp/zz') === 'MyPlug');
await attempt('ZIP 条目名兼容 GBK', () => pi.decodeZipName(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])) === '中文');

await attempt('ZIP 解析：丢弃 ../ 与绝对路径并告警', async () => {
  const entry = () => ({ dir: false, async: async () => new Uint8Array([1]) });
  const fake = {
    files: {
      'CA.zip': entry(), 'libPenMods.so': entry(), 'patch.sh': entry(),
      'misc/init.sh': entry(), 'misc/patchelf': entry(),
      'misc/libm.so': entry(), 'misc/libcrypt.so': entry(), 'misc/libstdc++.so': entry(),
      'Rime/default.yaml': entry(), '../../evil.sh': entry(), '/etc/passwd': entry(),
    },
  };
  const r = await filesLib.getInstallFilesFromZip(fake);
  const paths = r.files.map((f) => f.remotePath);
  if (paths.some((p) => p.includes('evil') || p === '/etc/passwd')) return '没有拦住可疑路径: ' + paths.join(',');
  if (!r.warnings.some((w) => w.includes('可疑路径'))) return '没有告警';
  const rime = r.files.find((f) => f.name === 'default.yaml');
  if (!rime || rime.remotePath !== '/userdisk/Music/Rime/default.yaml') return 'Rime 映射错: ' + (rime && rime.remotePath);
  return r.files.find((f) => f.name === 'patch.sh').executable ? true : 'patch.sh 未标记可执行';
});

await attempt('GitHub：403 限流给填 Token 的提示', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 });
  try { await gh.ghGet('/x'); return '没有抛错'; }
  catch (e) { return /限流/.test(e.message) ? true : e.message; }
});
await attempt('GitHub：404 提示未找到', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  try { await gh.ghGet('/x'); return '没有抛错'; }
  catch (e) { return /未找到/.test(e.message) ? true : e.message; }
});
await attempt('GitHub：网络异常给中文错误', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try { await gh.ghGet('/x'); return '没有抛错'; }
  catch (e) { return /无法连接 GitHub/.test(e.message) ? true : e.message; }
});
await attempt('GitHub：token 头带上、JSON 正常解析', async () => {
  let seen = '';
  gh.setToken('tok-1');
  globalThis.fetch = async (_u, o) => {
    seen = String((o && o.headers && o.headers['x-gh-token']) || '');
    return new Response(JSON.stringify({ full_name: 'a/b' }), { status: 200 });
  };
  const data = await gh.ghGet('/repos/a/b');
  gh.setToken('');
  return data.full_name === 'a/b' && seen === 'tok-1' ? true : `data=${JSON.stringify(data)} token=${seen}`;
});

await attempt('自定义安装包脚本带 set -e 与完成标记', () => {
  const pkg = store.buildCustomAppPackage({ fileName: 'MyApp-1.2.3.zip', data: new Uint8Array([1]), isTarGz: false, sizeMB: 1 });
  if (!pkg.script.startsWith('set -e')) return '缺少 set -e';
  if (!/echo "安装完成"/.test(pkg.script)) return '缺少完成标记';
  return pkg.id === 'custom_MyApp-1.2.3' ? true : 'id=' + pkg.id;
});

await attempt('音乐：搜索响应兼容多种字段与包裹', () => {
  const a = musicLib.parseSearchResponse({ songs: [{ id: 1, name: '晴天', singer: '周杰伦', interval: 269 }] });
  const b = musicLib.parseSearchResponse({ data: { list: [{ songmid: 'x', songname: '海阔天空', artist: 'Beyond' }] } });
  const c = musicLib.parseSearchResponse([{ title: '起风了' }]);
  if (a.length !== 1 || a[0].name !== '晴天' || a[0].duration !== 269) return 'A=' + JSON.stringify(a);
  if (b.length !== 1 || b[0].id !== 'x' || b[0].singer !== 'Beyond') return 'B=' + JSON.stringify(b);
  if (c.length !== 1 || c[0].name !== '起风了') return 'C=' + JSON.stringify(c);
  if (musicLib.parseSearchResponse({ nope: 1 }).length !== 0) return '空响应应为空数组';
  return true;
});

await attempt('音乐：取播放地址兼容 {url}/data/纯字符串', () => {
  if (musicLib.pickSongUrl({ url: 'https://a/b.mp3' }) !== 'https://a/b.mp3') return '直接 url 失败';
  if (musicLib.pickSongUrl({ data: { url: 'https://a/c.flac' } }) !== 'https://a/c.flac') return '嵌套失败';
  if (musicLib.pickSongUrl('https://a/d.m4a') !== 'https://a/d.m4a') return '字符串失败';
  if (musicLib.pickSongUrl({ url: '/relative' }) !== '') return '相对地址应拒绝';
  return true;
});

await attempt('音乐：文件名净化（路径符/保留字/超长）', () => {
  const n = musicLib.audioFileName({ name: 'a/b:c*?"<>|d', singer: 'x' }, '.mp3');
  if (/[\\/:*?"<>|]/.test(n)) return '仍有非法字符: ' + n;
  if (!n.endsWith('.mp3')) return '扩展名丢失: ' + n;
  const long = musicLib.audioFileName({ name: 'x'.repeat(300) }, '.flac');
  if (long.length > 130) return '太长: ' + long.length;
  if (!musicLib.audioFileName({ name: 'song', singer: '' }).endsWith('.mp3')) return '默认扩展名失败';
  return true;
});

await attempt('音乐：扩展名只认音频后缀', () => {
  if (musicLib.guessExt('https://x/a.flac?token=1') !== '.flac') return 'flac 未识别';
  if (musicLib.guessExt('https://x/a.mp3#t') !== '.mp3') return 'mp3 未识别';
  if (musicLib.guessExt('https://x/a.exe') !== '') return '非音频不应识别';
  if (!musicLib.isAudioFile('A.MP3')) return '大写扩展名未识别';
  return true;
});

await attempt('音乐：歌单文本解析', () => {
  const list = musicLib.parsePlaylistText('1. 晴天 - 周杰伦\n\n海阔天空 – Beyond\n起风了\n  * 稻香 _ 周杰伦\n');
  if (list.length !== 4) return '条数=' + list.length + ' ' + JSON.stringify(list);
  if (list[0].name !== '晴天' || list[0].singer !== '周杰伦') return '首条=' + JSON.stringify(list[0]);
  if (list[1].singer !== 'Beyond') return '破折号未识别';
  if (list[2].name !== '起风了' || list[2].singer !== '') return '单曲名解析错';
  if (list[3].name !== '稻香') return '下划线未识别: ' + list[3].name;
  return true;
});

await attempt('音乐：分享链接认平台与歌单 id', () => {
  const cases = [
    ['分享歌单: 我喜欢的音乐 https://music.163.com/playlist?id=3778678', 'netease', '3778678'],
    ['https://music.163.com/#/playlist?id=491533', 'netease', '491533'],
    ['https://y.qq.com/n/ryqq/playlist/8676288', 'qq', '8676288'],
    ['https://i.y.qq.com/n2/m/share/details/taoge.html?disstid=7291553918', 'qq', '7291553918'],
    ['https://www.kugou.com/yy/special/single/1061309.html', 'kugou', '1061309'],
    ['https://www.kuwo.cn/playlist_detail/2809007605', 'kuwo', '2809007605'],
    ['https://music.migu.cn/v3/music/playlist/1603312681', 'migu', '1603312681'],
    ['看看这个 https://music.example.com/list/1234567 挺好', 'other', '1234567'],
  ];
  for (const [text, platform, id] of cases) {
    const r = musicLib.parseShareLink(text);
    if (!r) return '没认出：' + text;
    if (r.platform !== platform) return `平台 ${r.platform} != ${platform} ← ${text}`;
    if (r.id !== id) return `id ${r.id} != ${id} ← ${text}`;
  }
  if (musicLib.parseShareLink('没有链接的一段话') !== null) return '无链接应返回 null';
  if (musicLib.parseShareLink('') !== null) return '空文本应返回 null';
  const short = musicLib.parseShareLink('https://163cn.tv/abc123');
  if (!short || short.platform !== 'netease' || short.id !== '') return '短链应无 id 但平台为 netease';
  const titled = musicLib.parseShareLink('分享歌单: 深夜电台 https://music.163.com/playlist?id=1');
  if (!titled.title.includes('深夜电台')) return '标题=' + JSON.stringify(titled.title);
  return true;
});

await attempt('音乐：歌单接口地址拼接', () => {
  const u = musicLib.buildPlaylistUrl('https://a.com/api/', { platform: 'qq', id: '123', url: 'https://y.qq.com/x?a=1&b=2' });
  if (!u.startsWith('https://a.com/api/playlist?')) return '基础地址=' + u;
  if (!u.includes('platform=qq')) return '缺 platform';
  if (!u.includes('id=123')) return '缺 id';
  if (!u.includes('url=' + encodeURIComponent('https://y.qq.com/x?a=1&b=2'))) return 'url 未编码: ' + u;
  const noId = musicLib.buildPlaylistUrl('https://a.com', { platform: 'netease', id: '', url: 'https://163cn.tv/x' });
  if (noId.includes('id=')) return '空 id 不该出现: ' + noId;
  return true;
});

await attempt('音乐：喜欢列表切换与去重', () => {
  const a = { id: '1', name: '晴天', singer: '周杰伦', album: '', duration: 0 };
  const b = { id: '2', name: '起风了', singer: '', album: '', duration: 0 };
  let list = [];
  if (musicLib.isFavorite(list, a)) return '空列表不该含';
  list = musicLib.toggleFavorite(list, a);
  if (!musicLib.isFavorite(list, a)) return '加入失败';
  list = musicLib.toggleFavorite(list, b);
  if (list.length !== 2) return '长度=' + list.length;
  list = musicLib.toggleFavorite(list, { ...a, id: 'other-id' });
  if (list.length !== 1 || list[0].name !== '起风了') return '按名字+歌手去重失败: ' + JSON.stringify(list.map((s) => s.name));
  if (musicLib.favoriteKey({ name: ' A ', singer: 'B' }) !== musicLib.favoriteKey({ name: 'a', singer: 'b' })) return 'key 未忽略大小写/空格';
  if (musicLib.loadFavorites().length !== 0) return '无 localStorage 时应返回空';
  return true;
});

await attempt('音乐：设备路径与目录归一', () => {
  if (musicLib.normalizeBase(' https://a.com/api/ ') !== 'https://a.com/api') return '归一失败';
  if (musicLib.joinRemote('/userdisk/Music/', 'a.mp3') !== '/userdisk/Music/a.mp3') return 'joinRemote 失败';
  if (!musicLib.buildSearchUrl('https://a', '周 杰伦').includes('keyword=%E5%91%A8%20%E6%9D%B0%E4%BC%A6')) return '关键词未编码';
  if (!musicLib.buildSongUrl('https://a', 'id 1').includes('id=id%201')) return 'id 未编码';
  return true;
});

await attempt('版本比较：新旧/相同/补零', () => {
  if (updatesLib.compareVersions('1.0.1', '1.0.0') <= 0) return '1.0.1 应比 1.0.0 新';
  if (updatesLib.compareVersions('1.0.0', '1.0.1') >= 0) return '1.0.0 应比 1.0.1 旧';
  if (updatesLib.compareVersions('1.2', '1.2.0') !== 0) return '1.2 应等于 1.2.0';
  if (updatesLib.compareVersions('v2.0.0', '1.9.9') <= 0) return 'v 前缀应被忽略';
  return true;
});

await attempt('更新判定：有新版本时给下载页', () => {
  const r = updatesLib.evaluateRelease('1.0.0', {
    tag_name: 'v1.0.1',
    html_url: 'https://github.com/x/y/releases/tag/v1.0.1',
    body: '  - 修了个 bug\n',
    published_at: '2026-11-01T00:00:00Z',
  });
  if (!r.hasUpdate) return '没识别出新版本';
  if (r.latest !== '1.0.1') return 'latest=' + r.latest;
  if (!r.url.includes('/releases/tag/')) return 'url=' + r.url;
  if (r.notes !== '- 修了个 bug') return 'notes=' + JSON.stringify(r.notes);
  return true;
});

await attempt('更新判定：同一个版本不算更新', () => {
  const r = updatesLib.evaluateRelease('1.0.0', { tag_name: 'v1.0.0', html_url: 'u' });
  return !r.hasUpdate ? true : '误报有新版本';
});

await attempt('安装步骤表顺序完整', () => {
  const titles = stepsLib.STEP_ORDER.map((s) => s.title).join('|');
  const missing = ['连接设备', '安装', '完成'].filter((k) => !titles.includes(k));
  if (missing.length) return '缺少 ' + missing.join(',') + ' → ' + titles;
  const orders = stepsLib.STEP_ORDER.map((s) => s.order);
  return orders.every((v, i) => i === 0 || orders[i - 1] <= v) ? true : 'order 不单调';
});

/** 假 PTY：收到命令就回哨兵退出码，codes 依次出队 */
function makePty(codes = []) {
  let ctrl;
  const out = new ReadableStream({ start(c) { ctrl = c; } });
  const te = new TextEncoder();
  const td = new TextDecoder();
  const received = [];
  const input = {
    getWriter() {
      return {
        async write(bytes) {
          const text = td.decode(bytes);
          received.push(text);
          const m = /__PM_RC_[a-z0-9]+__/.exec(text);
          if (!m) return;
          const code = codes.length ? codes.shift() : 0;
          setTimeout(() => ctrl.enqueue(te.encode(m[0] + ':' + code + '\r\n')), 5);
        },
        releaseLock() {},
        close() {},
      };
    },
  };
  return { output: out, input, exited: Promise.resolve(), received };
}

await attempt('PTY 会话：取到退出码 0 并回调输出', async () => {
  const pty = makePty([0]);
  const s = new installerLib.PtySession(pty);
  const lines = [];
  const r = await s.run('echo hi', 3000, (l) => lines.push(l));
  return r.code === 0 ? true : 'code=' + r.code;
});
await attempt('PTY 会话：取到失败退出码 2', async () => {
  const r = await new installerLib.PtySession(makePty([2])).run('false', 3000);
  return r.code === 2 ? true : 'code=' + r.code;
});
await attempt('PTY 会话：超时抛错而不是永久挂住', async () => {
  const silent = makePty([]);
  // 不喂任何输出
  silent.input.getWriter = () => ({ write: async () => {}, releaseLock() {} });
  try { await new installerLib.PtySession(silent).run('sleep 999', 700); return '没有超时'; }
  catch (e) { return /命令执行超时/.test(e.message) ? true : e.message; }
});

// ═══════════════ 2. 插件安装链路（mock 设备）═══════════════
section('2. 插件安装（mock 设备）');

const enc = (s) => new TextEncoder().encode(s);
const makePkg = (name, fileList) => ({
  name,
  meta: { name },
  files: fileList.map((f) => ({ path: f.path, getData: async () => enc(f.body || 'x') })),
});
function makeDev(reply) {
  return {
    calls: [], pushes: [], mkdirs: [],
    async shellScript(cmd) { this.calls.push(cmd); return typeof reply === 'function' ? reply(cmd) : reply; },
    async shellCommand(cmd) { this.calls.push(cmd); return typeof reply === 'function' ? reply(cmd) : reply; },
    async pushFile(data, remotePath) { this.pushes.push({ size: data.length, remotePath }); },
    async readDir() { return []; },
    async mkdirp(p) { this.mkdirs.push(p); },
  };
}

await attempt('安装：目录名净化，恶意名字不进 shell', async () => {
  const dir = await pi.installPlugin(makeDev('__PM_UNZIP=0\n'), makePkg('a";reboot;#', [{ path: 'x' }]), () => {});
  return /^\/userdisk\/PenMods\/plugins\/[A-Za-z0-9._-]+$/.test(dir) ? true : dir;
});
await attempt('安装：只推一个 ZIP 而不是逐个文件', async () => {
  const dev = makeDev('__PM_UNZIP=0\n');
  await pi.installPlugin(dev, makePkg('P', [{ path: 'a' }, { path: 'b' }]), () => {});
  return dev.pushes.length === 1 && dev.pushes[0].remotePath.endsWith('__install.zip') ? true : JSON.stringify(dev.pushes);
});
await attempt('安装：unzip 失败（退出码 9）正确抛错', async () => {
  try {
    await pi.installPlugin(makeDev('cannot create directory: Permission denied\n__PM_UNZIP=9\n'), makePkg('X', [{ path: 'a' }]), () => {});
    return '没有抛错';
  } catch (e) { return /解压失败/.test(e.message) ? true : e.message; }
});
await attempt('安装：unzip 退出码 1（只有警告）不误报', async () => {
  try { await pi.installPlugin(makeDev('__PM_UNZIP=1\n'), makePkg('W', [{ path: 'a' }]), () => {}); return true; }
  catch (e) { return '误报: ' + e.message; }
});
await attempt('安装：包内 ../ 在推送前被拒绝', async () => {
  const dev = makeDev('__PM_UNZIP=0\n');
  try { await pi.installPlugin(dev, makePkg('S', [{ path: '../evil.sh' }]), () => {}); return '没有抛错'; }
  catch (e) { return /非法路径/.test(e.message) && dev.pushes.length === 0 ? true : e.message + ' pushes=' + dev.pushes.length; }
});
await attempt('SFTP 模式：不碰 device shell，按父→子建目录', async () => {
  const dev = makeDev('不应该被调用');
  dev.noShell = true;
  await pi.installPlugin(dev, makePkg('SshPlug', [{ path: 'metadata.json' }, { path: 'qml/main.qml' }, { path: 'qml/deep/a.qml' }]), () => {});
  if (dev.calls.length) return '调用了 shell: ' + JSON.stringify(dev.calls);
  const want = [
    '/userdisk/PenMods/plugins/SshPlug',
    '/userdisk/PenMods/plugins/SshPlug/qml',
    '/userdisk/PenMods/plugins/SshPlug/qml/deep',
  ];
  return JSON.stringify(dev.mkdirs) === JSON.stringify(want) ? true : JSON.stringify(dev.mkdirs);
});
await attempt('读已装版本：非法目录名不拼命令', async () => {
  const dev = makeDev('{}');
  const r = await pi.getInstalledPlugin(dev, '../../etc');
  return r === null && dev.calls.length === 0 ? true : `r=${r} calls=${dev.calls.length}`;
});
await attempt('读已装版本：目录名里的引号被转义', async () => {
  const dev = makeDev('{"version":"1.0.0"}');
  await pi.getInstalledPlugin(dev, "it's");
  return dev.calls.length === 1 && dev.calls[0].includes("'\\''") ? true : (dev.calls[0] || '没有调用');
});

// ═══════════════ 3. 一键安装主流程（mock 设备）═══════════════
section('3. 一键安装主流程（mock 设备）');

function makeAdb({ failPath = '', codes = [] } = {}) {
  const pty = makePty(codes);
  const adb = {
    pushes: [], mkdirs: [], ptyRef: pty,
    async mkdir(p) { this.mkdirs.push(p); },
    async pushFile(_d, remotePath) {
      if (failPath && remotePath.includes(failPath)) throw new Error('USB 连接中断');
      this.pushes.push(remotePath);
    },
    adbInstance: { subprocess: { noneProtocol: { pty: async () => pty } } },
  };
  return adb;
}
const INSTALL_FILES = [
  { name: 'CA.zip', remotePath: '/userdisk/CA.zip', data: new Uint8Array([1]) },
  { name: 'libPenMods.so', remotePath: '/userdata/PenMods/libPenMods.so', data: new Uint8Array([2]) },
  { name: 'patch.sh', remotePath: '/userdata/PenMods/patch.sh', data: new Uint8Array([3]) },
];

await attempt('正常安装：推送 → 脚本 → reboot → done', async () => {
  const adb = makeAdb();
  const states = [];
  await new installerLib.Installer(adb, (s) => states.push(s)).install({ base: true, certs: true, rime: false }, INSTALL_FILES);
  const last = states[states.length - 1];
  if (last.phase !== 'done') return '最后状态 ' + last.phase + ': ' + last.log.slice(-1)[0];
  if (adb.pushes.length !== 3) return '推送 ' + adb.pushes.length + ' 个';
  const cmds = adb.ptyRef.received.join('');
  if (!['auth', 'mount -o remount,rw /', 'unzip', 'chmod +x', 'init.sh', 'patch.sh'].every((k) => cmds.includes(k))) return '命令缺项: ' + cmds.slice(0, 120);
  return /reboot/.test(adb.ptyRef.received.at(-1)) ? true : '没有 reboot';
});
await attempt('推送失败：中止安装并报错，不跑脚本', async () => {
  const adb = makeAdb({ failPath: 'libPenMods.so' });
  const states = [];
  await new installerLib.Installer(adb, (s) => states.push(s)).install({ base: true, certs: true, rime: false }, INSTALL_FILES);
  const err = states.find((s) => s.phase === 'error');
  if (!err) return '没有 error 状态';
  if (states.some((s) => s.phase === 'done')) return '竟然报了 done';
  return adb.ptyRef.received.length === 0 ? true : '推送失败后仍执行了脚本';
});
await attempt('脚本步骤失败：报 error 并指名哪一步', async () => {
  const adb = makeAdb({ codes: [0, 0, 0, 0, 0, 1] });
  const states = [];
  await new installerLib.Installer(adb, (s) => states.push(s)).install({ base: true, certs: true, rime: false }, INSTALL_FILES);
  const err = states.find((s) => s.phase === 'error');
  if (!err || !/步骤失败/.test(err.log.at(-1))) return '没有步骤失败提示: ' + (err ? err.log.at(-1) : '无 error');
  return /reboot/.test(adb.ptyRef.received.at(-1)) ? true : '失败后没有重启';
});
await attempt('不装证书：不推 CA.zip、不跑证书步骤', async () => {
  const adb = makeAdb();
  const states = [];
  await new installerLib.Installer(adb, (s) => states.push(s)).install({ base: true, certs: false, rime: false }, INSTALL_FILES);
  if (adb.pushes.includes('/userdisk/CA.zip')) return '仍然推了 CA.zip';
  if (adb.ptyRef.received.join('').includes('unzip')) return '仍然跑了证书步骤';
  return states.at(-1).phase === 'done' ? true : '最后状态 ' + states.at(-1).phase;
});
await attempt('每步都有超时，patch.sh 给足 5 分钟', async () => {
  const src = fs.readFileSync(path.join(appRoot, 'src', 'lib', 'installer.ts'), 'utf8');
  const timeouts = [...src.matchAll(/timeoutMs:\s*([\d_]+)/g)].map((m) => Number(m[1].replace(/_/g, '')));
  return timeouts.length >= 6 && Math.max(...timeouts) >= 300_000 ? true : timeouts.join(', ');
});

// ═══════════════ 4. 本地服务 HTTP ═══════════════
section('4. 本地服务');

const distDir = process.env.SMOKE_WEB_ROOT || path.join(appRoot, 'dist');
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  ok('本地服务：跳过（没有 dist，先跑 npm run build）', true, 'skipped');
} else {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(appRoot, 'package.json'));
  const { startServer } = require(path.join(appRoot, 'electron', 'server.cjs'));
  const WebSocket = require('ws');
  const { server } = await startServer({ root: distDir, appVersion: 'smoke' });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const get = async (p, headers) => {
    const r = await realFetch(base + p, { headers });
    return { status: r.status, len: (await r.arrayBuffer()).byteLength };
  };

  await attempt('GET / 返回页面', async () => (await get('/')).status === 200);
  await attempt('SPA fallback', async () => (await get('/plugin-market')).status === 200);
  await attempt('/api/info 返回版本', async () => {
    const r = await realFetch(base + '/api/info');
    const j = await r.json();
    return j.app === 'penmods-installer-desktop' ? true : JSON.stringify(j);
  });
  await attempt('伪造 Host 头 → 403', async () => {
    const http = await import('node:http');
    return await new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port, path: '/api/info', headers: { Host: 'evil.example.com' } }, (res) => {
        res.resume();
        resolve(res.statusCode === 403 ? true : 'status=' + res.statusCode);
      });
      rq.on('error', (e) => resolve('error: ' + e.message));
      rq.end();
    });
  });
  await attempt('畸形 URL 编码 → 400', async () => (await get('/%E0%A4%A')).status === 400);
  await attempt('路径穿越 → 拒绝', async () => [403, 404].includes((await get('/..%2f..%2fpackage.json')).status));
  await attempt('/api/dl 非白名单 → 403', async () => (await get('/api/dl?url=' + encodeURIComponent('https://evil.example.com/x'))).status === 403);
  await attempt('/api/gh 缺参数 → 400', async () => (await get('/api/gh')).status === 400);
  await attempt('WS 外部 Origin 被拒', async () => {
    return await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ssh`, { headers: { Origin: 'https://evil.example.com' } });
      const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve('超时'); }, 4000);
      ws.on('open', () => { clearTimeout(timer); ws.close(); resolve('竟然连上了'); });
      ws.on('error', () => { clearTimeout(timer); resolve(true); });
      ws.on('unexpected-response', (_q, res) => { clearTimeout(timer); resolve(res.statusCode ? true : 'no status'); });
    });
  });
  server.close();
}

// ── 汇总 ──
let pass = 0;
let fail = 0;
console.log('');
for (const r of results) {
  if (r.section) { console.log('\n' + r.section); continue; }
  if (r.pass) pass++;
  else fail++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
}
fs.rmSync(tmpLib, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} 通过${fail ? `，${fail} 失败` : ''}`);
process.exit(fail === 0 ? 0 : 1);
