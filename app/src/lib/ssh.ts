/**
 * 浏览器端 SSH 客户端
 * 通过 Vite 内置 WebSocket 代理连接设备 SSH
 */

export interface RemoteFileEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  sizeBytes: number;
  mtime: number;
}

let ws: WebSocket | null = null;
let connected = false;
let onShellData: ((data: string) => void) | null = null;
let onShellClose: (() => void) | null = null;
// 非主动断开（设备掉线/网络中断/代理崩溃）时通知上层，用于刷新连接状态
let onDisconnect: (() => void) | null = null;
let shellBuffer: string[] = [];
let msgId = 0;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
// shell_exec 流式输出回调，按请求 id 路由
const shellExecData = new Map<string, (chunk: string) => void>();

export function isSSHConnected() { return connected; }

/** 注册「连接意外丢失」回调（主动 disconnectSSH 不会触发） */
export function setOnDisconnect(cb: (() => void) | null) { onDisconnect = cb; }

function nextId() { return 'r' + (++msgId) + '_' + Date.now(); }

function sendMsg(
  type: string,
  payload: Record<string, any> = {},
  opts: { id?: string; timeout?: number } = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('WebSocket 未连接'));
    const id = opts.id || nextId();
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, type, ...payload }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('请求超时')); }
    }, opts.timeout ?? 30000);
  });
}

export async function connectSSHProxy(proxyUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 关掉旧连接前先摘掉 onclose，避免误触发「意外断开」回调
    if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); ws = null; }

    ws = new WebSocket(proxyUrl);
    const timeout = setTimeout(() => {
      if (!connected) { ws?.close(); reject(new Error('WebSocket 连接超时')); }
    }, 10000);

    ws.onopen = () => clearTimeout(timeout);

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case 'connect_result':
          if (msg.ok) { connected = true; resolve(); }
          else reject(new Error(msg.msg || 'SSH 连接失败'));
          break;
        case 'shell_data':
          if (onShellData) onShellData(msg.data);
          else shellBuffer.push(msg.data);
          break;
        case 'shell_close':
          onShellClose?.();
          break;
        case 'shell_exec_data':
          shellExecData.get(msg.id)?.(msg.data);
          break;
        default:
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.type === 'error') p.reject(new Error(msg.msg));
            else p.resolve(msg);
          }
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      connected = false;
      reject(new Error('浏览器无法连接 Vite 内置代理'));
    };

    ws.onclose = () => {
      const wasConnected = connected;
      connected = false;
      for (const [, p] of pending) p.reject(new Error('连接已关闭'));
      pending.clear();
      // 已建立过连接却被关闭 = 意外掉线，通知上层刷新状态
      if (wasConnected) onDisconnect?.();
    };
  });
}

export function disconnectSSH() {
  connected = false;
  shellBuffer = [];
  for (const [, p] of pending) p.reject(new Error('连接已关闭'));
  pending.clear();
  // 主动断开：摘掉 onclose/onerror，避免触发「意外断开」回调
  if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); ws = null; }
}

// ── Shell ──

export function setShellCallbacks(onData: (data: string) => void, onClose?: () => void) {
  onShellData = onData;
  onShellClose = onClose || null;
  // 回放缓冲的 shell 输出
  while (shellBuffer.length) onShellData(shellBuffer.shift()!);
}

export function shellWrite(data: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'shell_input', data }));
}

// ── Exec（单条命令，用于自动化）──

export async function execCommand(cmd: string): Promise<string> {
  const r = await sendMsg('exec', { cmd });
  return r.data || '';
}

/**
 * 在设备的交互式 shell 里跑一段脚本，流式回传输出。
 * 用于需要真实 shell 的场景（PenMods 安装：mount/unzip/init.sh/patch.sh），
 * 这些在 exec 通道上不工作。超时放宽到 200s（patch.sh 约耗时 1 分钟）。
 */
export async function shellExec(
  script: string,
  onData?: (chunk: string) => void,
): Promise<{ output: string; code: number }> {
  const id = nextId();
  let output = '';
  shellExecData.set(id, (chunk) => { output += chunk; onData?.(chunk); });
  try {
    const r = await sendMsg('shell_exec', { script }, { id, timeout: 200000 });
    return { output, code: typeof r.code === 'number' ? r.code : 0 };
  } finally {
    shellExecData.delete(id);
  }
}

// ── SFTP ──

export async function sftpReaddir(path: string): Promise<RemoteFileEntry[]> {
  const r = await sendMsg('sftp_readdir', { path });
  return r.files || [];
}

export async function sftpReadFile(path: string): Promise<Uint8Array> {
  const r = await sendMsg('sftp_read', { path });
  if (!r.data) throw new Error('读取文件失败');
  const bin = atob(r.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 分块上传的块大小：128KB 原始数据 ≈ 171KB base64，单帧不会触发 WS 帧上限 */
const SFTP_CHUNK_BYTES = 128 * 1024;

/** Uint8Array → base64。按 32KB 分段调用 fromCharCode，避免参数过多爆栈。 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  }
  return btoa(bin);
}

/**
 * 写文件到设备。
 *
 * 之前是把整个文件拼成一份 base64 塞进一条 WS 消息：几十 MB 的文件在渲染进程里
 * 要额外扛 2~3 倍内存，而且 sendMsg 30s 必超时。现在改成分块上传
 * （begin → chunk × N → end），单块 128KB，进度可选。
 */
export async function sftpWriteFile(
  path: string,
  data: Uint8Array,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const uploadId = 'u' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // 老版本主进程（打包在 exe 里的 server.cjs）没有分块接口：超时/报错就退回单帧写入。
  try {
    const begun = await sendMsg('sftp_write_begin', { uploadId, path }, { timeout: 10000 });
    if (!begun || !begun.ok) throw new Error('分块上传不可用');
  } catch {
    await sftpWriteFileLegacy(path, data);
    return;
  }

  try {
    if (data.length === 0) {
      await sendMsg('sftp_write_chunk', { uploadId, position: 0, data: '' }, { timeout: 30000 });
    }
    for (let offset = 0; offset < data.length; offset += SFTP_CHUNK_BYTES) {
      const chunk = data.subarray(offset, Math.min(offset + SFTP_CHUNK_BYTES, data.length));
      const r = await sendMsg(
        'sftp_write_chunk',
        { uploadId, position: offset, data: bytesToBase64(chunk) },
        { timeout: 60000 },
      );
      if (!r.ok) throw new Error('写入失败');
      onProgress?.(Math.round(((offset + chunk.length) / data.length) * 100));
    }
    const ended = await sendMsg('sftp_write_end', { uploadId }, { timeout: 60000 });
    if (!ended.ok) throw new Error('写入失败');
  } catch (e) {
    await sendMsg('sftp_write_abort', { uploadId }, { timeout: 5000 }).catch(() => {});
    throw e;
  }
}

/** 单帧写入（仅用于回退到老版本主进程） */
async function sftpWriteFileLegacy(path: string, data: Uint8Array): Promise<void> {
  const r = await sendMsg('sftp_write', { path, data: bytesToBase64(data) }, { timeout: 120000 });
  if (!r.ok) throw new Error('写入失败');
}

export async function sftpDelete(path: string): Promise<void> {
  const r = await sendMsg('sftp_delete', { path });
  if (!r.ok) throw new Error('删除失败');
}

export async function sftpRename(oldPath: string, newPath: string): Promise<void> {
  const r = await sendMsg('sftp_rename', { oldPath, newPath });
  if (!r.ok) throw new Error('重命名失败');
}

export async function sftpMkdir(path: string): Promise<void> {
  const r = await sendMsg('sftp_mkdir', { path });
  if (!r.ok) throw new Error('创建目录失败');
}

export async function sftpRmdir(path: string): Promise<void> {
  const r = await sendMsg('sftp_rmdir', { path });
  if (!r.ok) throw new Error('删除目录失败');
}
