/**
 * 市场安装的核心动作（供插件市场 / 安装包市场 / OTA 页面共用）
 */
import type { DeviceConnection } from './device';
import { downloadBytes, type DownloadProgress } from './github';
import { parsePluginFromZip, installPlugin, type InstallProgress } from './plugin-install';
import { installApp } from './app-store';
import type { MarketApp } from './market';

export interface InstallStage {
  phase: string;
  received?: number;
  total?: number;
}

/** 把任意 zip 字节流当插件安装（市场下载 / 手动 URL 都走这里） */
export async function installPluginBytes(
  conn: DeviceConnection,
  bytes: Uint8Array,
  onLog: (msg: string) => void,
  onStage?: (s: InstallStage) => void,
): Promise<string> {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('下载到的内容不是 ZIP（可能是 GitHub 返回的错误页）');
  }
  onStage?.({ phase: '解析插件…' });
  const JSZipMod = (await import('jszip')).default;
  const zip = await JSZipMod.loadAsync(bytes);
  const pkg = await parsePluginFromZip(zip);
  onLog(`识别为插件：${pkg.name} v${pkg.meta.version || '?'}（${pkg.files.length} 个文件）`);
  const target = await installPlugin(conn, pkg, (p: InstallProgress) => {
    onStage?.({ phase: p.file, received: p.done, total: p.total });
  });
  onLog(`✓ 已安装到 ${target}`);
  return pkg.name;
}

/** 安装包里可能自带的 install.sh（解压后在根目录） */
function appScript(kind: 'zip' | 'tar.gz'): string {
  const extract = kind === 'zip'
    ? 'unzip -o __market_pkg.zip'
    : 'tar -xzf __market_pkg.tar.gz';
  const cleanup = kind === 'zip' ? 'rm -f __market_pkg.zip' : 'rm -f __market_pkg.tar.gz';
  return [
    'mount -o remount,rw / 2>/dev/null || true',
    'cd /userdisk || exit 1',
    `echo "解压 ${kind === 'zip' ? '.zip' : '.tar.gz'}…"`,
    `${extract} || exit 1`,
    'if [ -f __market_install.sh ]; then cp -f __market_install.sh ./install.sh; fi',
    'if [ -f ./install.sh ]; then chmod +x ./install.sh; echo "执行 install.sh…"; sh ./install.sh; fi',
    `${cleanup}; rm -f __market_install.sh`,
    'sync',
    'echo "完成"',
  ].join('\n');
}

/** 从市场条目安装（Release 附件 / app.json 清单 / 手动 URL） */
export async function installMarketApp(
  conn: DeviceConnection,
  app: Pick<MarketApp, 'name' | 'url' | 'kind' | 'installScriptUrl' | 'sizeBytes'>,
  onLog: (msg: string) => void,
  onStage?: (s: InstallStage) => void,
): Promise<void> {
  onStage?.({ phase: '下载安装包…', received: 0, total: app.sizeBytes });
  const bytes = await downloadBytes(app.url, (p: DownloadProgress) => {
    onStage?.({ phase: '下载安装包…', received: p.received, total: p.total });
  });
  onLog(`✓ 已下载 ${app.name}（${(bytes.length / 1048576).toFixed(1)}MB）`);

  const files = [{
    data: bytes,
    remotePath: app.kind === 'zip' ? '/userdisk/__market_pkg.zip' : '/userdisk/__market_pkg.tar.gz',
  }];
  if (app.installScriptUrl) {
    onStage?.({ phase: '下载 install.sh…' });
    const scriptBytes = await downloadBytes(app.installScriptUrl);
    files.push({ data: scriptBytes, remotePath: '/userdisk/__market_install.sh' });
  }

  onStage?.({ phase: '推送到设备…' });
  await installApp(conn, {
    id: 'market_' + app.name,
    name: app.name,
    description: '来自安装包市场',
    sizeMB: bytes.length / 1048576,
    files,
    script: appScript(app.kind),
  }, onLog);
}

// ── OTA ──

export const OTA_MARKER = 'OTA_OK';

/** OTA 包在设备端执行的脚本文本（导出以便测试/排障） */
export function otaScript(): string {
  return [
    'ZIP=/userdisk/__penmods_ota.zip',
    'DIR=/userdisk/__penmods_ota',
    'mount -o remount,rw / 2>/dev/null || true',
    'rm -rf "$DIR"',
    'mkdir -p "$DIR" || exit 1',
    'cd "$DIR" || exit 1',
    'unzip -o "$ZIP" >/dev/null 2>&1 || { echo "解压失败"; exit 2; }',
    'BASE="$DIR"',
    'FOUND=$(find "$DIR" -maxdepth 3 -name _do_update.sh 2>/dev/null | head -n 1)',
    'if [ -n "$FOUND" ]; then BASE=$(dirname "$FOUND"); fi',
    'cd "$BASE" || exit 3',
    'RC=0',
    'if [ -f _do_update.sh ]; then echo "执行 _do_update.sh…"; sh _do_update.sh; RC=$?; fi',
    'if [ "$RC" != "0" ]; then echo "更新脚本失败 (exit $RC)"; else',
    '  if [ ! -f "$BASE/INSTALL_SUCCESSFULLY" ] && [ -f _do_update.sh ]; then echo "未找到 INSTALL_SUCCESSFULLY 标记"; RC=4; fi',
    'fi',
    'if [ "$RC" = "0" ]; then echo "' + OTA_MARKER + '"; fi',
    'cd /userdisk; rm -rf "$DIR" "$ZIP"',
    'exit $RC',
  ].join('\n');
}

/** 从 GitHub 下载 OTA 包并推送到设备执行 */
export async function installOtaZip(
  conn: DeviceConnection,
  zipUrl: string,
  onLog: (msg: string) => void,
  onStage?: (s: InstallStage) => void,
): Promise<void> {
  onStage?.({ phase: '下载 OTA 包…', received: 0, total: 0 });
  const bytes = await downloadBytes(zipUrl, (p: DownloadProgress) => {
    onStage?.({ phase: '下载 OTA 包…', received: p.received, total: p.total });
  });
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('OTA 包不是有效的 ZIP');
  }
  if (bytes.length < 1024 * 1024) {
    throw new Error(`OTA 包只有 ${(bytes.length / 1024).toFixed(0)}KB，疑似不完整`);
  }
  onLog(`✓ 已下载 OTA 包（${(bytes.length / 1048576).toFixed(2)}MB）`);

  onStage?.({ phase: '推送到设备…' });
  await conn.pushFile(bytes, '/userdisk/__penmods_ota.zip');
  onLog('✓ 已推送 /userdisk/__penmods_ota.zip');

  onStage?.({ phase: '正在执行更新…' });
  const script = otaScript();
  const result = conn.runScript
    ? await conn.runScript(script, (chunk) => {
        for (const line of chunk.split('\n')) {
          const t = line.trimEnd();
          if (t.trim()) onLog('  ' + t);
        }
      })
    : { output: await conn.shellScript(script), code: 0 };
  if (!result.output.includes(OTA_MARKER)) {
    throw new Error('OTA 更新未成功（设备端未返回成功标记，请查看上方日志）');
  }
  onLog('✓ OTA 更新完成');
}
