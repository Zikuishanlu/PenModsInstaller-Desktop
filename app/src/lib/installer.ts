import { AdbManager } from './adb';
import { getInstallFiles, type InstallFile } from './files';

export type InstallPhase =
  | 'pushing-files'
  | 'installing'
  | 'rebooting'
  | 'done'
  | 'error';

export interface InstallState {
  phase: InstallPhase;
  progress: number;
  currentFile: string;
  log: string[];
}

export type InstallCallback = (state: InstallState) => void;

export class Installer {
  private adb: AdbManager;
  private onUpdate: InstallCallback;
  private log: string[] = [];

  constructor(adb: AdbManager, onUpdate: InstallCallback) {
    this.adb = adb;
    this.onUpdate = onUpdate;
  }

  private emit(phase: InstallPhase, progress: number, currentFile: string, message: string) {
    this.log.push(message);
    this.onUpdate({ phase, progress, currentFile, log: this.log });
  }

  async install(
    components: { base: boolean; certs: boolean; rime: boolean },
    customFiles?: InstallFile[]
  ) {
    this.log = [];

    try {
      // ====== 1. 推送所有文件（sync 协议不需要 auth）======
      this.emit('pushing-files', 0, '', '开始推送文件…');
      let files = customFiles || getInstallFiles();
      if (!components.certs) files = files.filter(f => f.name !== 'CA.zip');
      const totalFiles = files.length;
      const failedPushes: string[] = [];

      for (let i = 0; i < totalFiles; i++) {
        const file = files[i];
        const pct = Math.round((i / totalFiles) * 50);

        this.emit('pushing-files', pct, file.name, `[${i+1}/${totalFiles}] ${file.name}`);

        try {
          const dir = file.remotePath.substring(0, file.remotePath.lastIndexOf('/'));
          await this.adb.mkdir(dir);

          let data: Uint8Array;
          if (file.data) {
            data = file.data;
            this.emit('pushing-files', pct, file.name, `  来自 ZIP: ${(data.length / 1024).toFixed(0)}KB`);
          } else if (file.localPath) {
            const resp = await fetch(file.localPath);
            if (!resp.ok) {
              failedPushes.push(`${file.name}: 打包资源缺失`);
              this.emit('pushing-files', pct, file.name, `  文件不存在，跳过`);
              continue;
            }
            data = new Uint8Array(await resp.arrayBuffer());
            this.emit('pushing-files', pct, file.name, `  ${(data.length / 1024).toFixed(0)}KB`);
          } else { continue; }

          await this.adb.pushFile(data, file.remotePath);
          this.emit('pushing-files', pct, file.name, `  ✓`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          failedPushes.push(`${file.name}: ${msg}`);
          this.emit('pushing-files', pct, file.name, `  ✗ ${msg}`);
        }
      }

      // 推送失败必须中止：以前只打日志，最后照样 emit('done')，
      // 拔 U 盘/空间不足都表现为「安装成功」，用户拿到一台半装设备。
      if (failedPushes.length) {
        throw new Error(
          `${failedPushes.length}/${totalFiles} 个文件推送失败，已中止安装（设备上的系统文件尚未改动）：` +
            failedPushes.slice(0, 3).join('；'),
        );
      }

      // ====== 2. 用一个 PTY 会话执行所有命令（仅需一次 auth）======
      this.emit('installing', 55, '', '正在执行安装脚本…（约 1 分钟）');

      // 每步带超时 + 哨兵退出码。以前固定等 1.5s 就往下走 / 就 reboot，
      // 而 patch.sh 自己的注释写着「约1分钟」，脚本经常执行到一半被打断。
      const steps: Array<{ cmd: string; timeoutMs: number; label: string }> = [
        { cmd: "echo 'CherryYoudao' | auth", timeoutMs: 30_000, label: '提权' },
        { cmd: 'mount -o remount,rw /', timeoutMs: 30_000, label: '挂载根分区为可写' },
        ...(components.certs
          ? [{ cmd: 'cd /userdisk && unzip -oq CA.zip && mv CA/* /etc/ssl/certs/ 2>/dev/null', timeoutMs: 120_000, label: '安装证书' }]
          : []),
        { cmd: 'cd /userdata/PenMods && chmod +x patch.sh misc/init.sh misc/patchelf', timeoutMs: 60_000, label: '设置执行权限' },
        { cmd: 'cd /userdata/PenMods/misc && ./init.sh', timeoutMs: 180_000, label: '初始化' },
        { cmd: 'cd /userdata/PenMods && ./patch.sh', timeoutMs: 300_000, label: '打补丁' },
      ];

      this.emit('installing', 60, '', '打开交互式 Shell 会话…');
      const pty = await this.adb.adbInstance!.subprocess.noneProtocol.pty(['']);
      const session = new PtySession(pty);

      const failedSteps: string[] = [];
      for (let i = 0; i < steps.length; i++) {
        const { cmd, timeoutMs, label } = steps[i];
        const pct = 60 + Math.round((i / steps.length) * 35);
        this.emit('installing', pct, '', `[${label}] ${cmd.substring(0, 50)}`);
        const { code } = await session.run(cmd, timeoutMs, (line) => {
          this.emit('installing', pct, '', '  ' + line);
        });
        if (code !== 0) {
          failedSteps.push(`${label}（退出码 ${code}）`);
          this.emit('installing', pct, '', `  ⚠ ${label} 返回 ${code}`);
        }
      }

      // ====== 3. 重启 ======
      this.emit('rebooting', 96, '', '安装完成！正在重启…');
      await session.write('reboot\n');
      await pty.exited.catch(() => {});

      if (failedSteps.length) {
        this.emit(
          'error',
          95,
          '',
          '安装脚本有步骤失败：' +
            failedSteps.join('；') +
            '。设备已重启，PenMods 可能不可用，建议检查日志后重新安装。',
        );
        return;
      }

      this.emit('done', 100, '', '安装完成！设备正在重启。如果屏幕不可用，长按电源键关机重启即可。');

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('error', 90, '', '❌ 安装失败: ' + message);
    }
  }
}

/**
 * 包一层交互式 PTY：写入命令，等到哨兵行（`__PM_RC_x__:<退出码>`）出现再返回。
 *
 * 之前这里是「写命令 → 死等 1500ms → 读几块输出」，而 patch.sh 自己注释写着
 * 「约1分钟」，结果脚本还在跑就发了 reboot，安装经常做到一半就被重启打断。
 * reader 只创建一次并一直复用（交互式 PTY 的输出流不会 close）。
 */
export class PtySession {
  private pty: any;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  private buf = '';

  constructor(pty: any) {
    this.pty = pty;
    this.reader = pty.output.getReader();
  }

  async write(text: string): Promise<void> {
    const writer = this.pty.input.getWriter();
    try {
      await writer.write(new TextEncoder().encode(text) as any);
    } finally {
      writer.releaseLock();
    }
  }

  async run(
    cmd: string,
    timeoutMs: number,
    onLine?: (line: string) => void,
  ): Promise<{ code: number; output: string }> {
    const marker = '__PM_RC_' + Math.random().toString(36).slice(2, 10) + '__';
    await this.write(`${cmd}; echo "${marker}:$?"\n`);

    const decoder = new TextDecoder();
    let output = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.pending) this.pending = this.reader.read();
      // 有数据就立刻处理；没有就等一小会儿再看，避免 read() 永久挂住
      const raced = await Promise.race([
        this.pending.then((v) => ({ v })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
      ]);
      if (!raced) continue;
      this.pending = null;
      if (raced.v.done) break;
      const chunk = raced.v.value;
      if (!chunk) continue;
      const text = decoder.decode(chunk, { stream: true });
      output += text;
      this.buf += text;

      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).replace(/\r$/, '');
        this.buf = this.buf.slice(nl + 1);
        const m = new RegExp(marker + ':(\\d+)').exec(line);
        if (m) return { code: Number(m[1]), output };
        // PTY 会把刚敲进去的命令原样回显一行，跳过它
        if (line.includes(marker)) continue;
        if (onLine && line.trim()) onLine(line);
      }
    }
    throw new Error(
      `命令执行超时（${Math.round(timeoutMs / 1000)}s）：${cmd.slice(0, 60)}`,
    );
  }
}
