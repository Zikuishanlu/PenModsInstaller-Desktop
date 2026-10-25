'use strict';
/**
 * PenMods 桌面版本地服务
 *
 *  - 静态托管 dist/（渲染进程通过 http://127.0.0.1:<port> 访问，
 *    这样 WebUSB / fetch('./files/...') / 同源 WebSocket 全部可用）
 *  - /ws/ssh  SSH over WebSocket 代理（原 server.mjs 的能力）
 *  - /api/gh   GitHub API 代理（绕过 CORS + 注入 token + 不受浏览器限流干扰）
 *  - /api/dl   任意白名单地址下载代理（带进度、跟随重定向）
 */
const http = require('http');
const net = require('node:net');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.so': 'application/octet-stream',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.sh': 'text/plain; charset=utf-8',
};

// 下载代理只允许这些域名，避免被当成任意 SSRF 跳板
const ALLOW_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'gist.githubusercontent.com',
  'pen.skdkzzx.dpdns.org',
  'ghproxy.net',
  'gh-proxy.com',
  'mirror.ghproxy.com',
]);

const GH_PATH_PREFIXES = ['/users/', '/repos/', '/search/', '/orgs/', '/rate_limit', '/releases'];

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handleGh(req, res, url) {
  const ghPath = url.searchParams.get('path') || '';
  if (!GH_PATH_PREFIXES.some(p => ghPath.startsWith(p))) {
    return sendJson(res, 400, { error: 'unsupported github api path' });
  }
  const token = req.headers['x-gh-token'] || '';
  const headers = {
    'user-agent': 'PenMods-Installer-Desktop',
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = 'Bearer ' + token;
  try {
    const r = await fetch('https://api.github.com' + ghPath, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    res.writeHead(r.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-RateLimit-Remaining': r.headers.get('x-ratelimit-remaining') || '',
    });
    res.end(text);
  } catch (e) {
    sendJson(res, 502, { error: 'github request failed: ' + (e && e.message) });
  }
}

async function handleDownload(req, res, url) {
  const target = url.searchParams.get('url') || '';
  let u;
  try {
    u = new URL(target);
  } catch {
    return sendJson(res, 400, { error: 'bad url' });
  }
  if (u.protocol !== 'https:' || !ALLOW_HOSTS.has(u.hostname)) {
    return sendJson(res, 403, { error: 'host not allowed: ' + u.hostname });
  }
  const token = req.headers['x-gh-token'] || '';
  // accept-encoding: identity 很关键 —— undici 会自动解压 gzip 并把原始
  // content-length 留在 header 里，直接转发会让渲染进程按旧长度截断文件
  // （实测 metadata.json 309B 被截成 237B）。
  const headers = { 'user-agent': 'PenMods-Installer-Desktop', 'accept-encoding': 'identity' };
  if (token) headers.authorization = 'Bearer ' + token;
  // 断点续传：把渲染进程的 Range 透传给上游
  const range = req.headers.range;
  if (range) headers.range = range;
  try {
    const r = await fetch(u, { headers, redirect: 'follow', signal: AbortSignal.timeout(600000) });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return sendJson(res, r.status, { error: `download failed: HTTP ${r.status}`, detail: t.slice(0, 300) });
    }
    const h = {
      'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    };
    const len = r.headers.get('content-length');
    const enc = r.headers.get('content-encoding');
    // 上游若仍压缩过，长度与实体不再匹配，交给 HTTP 层用 chunked 传输
    if (len && (!enc || enc === 'identity')) h['Content-Length'] = len;
    const cd = r.headers.get('content-disposition');
    if (cd) h['Content-Disposition'] = cd;
    const cr = r.headers.get('content-range');
    if (cr) {
      h['Content-Range'] = cr;
      h['Accept-Ranges'] = 'bytes';
    }
    res.writeHead(r.status === 206 ? 206 : 200, h);
    if (!r.body) return res.end();
    const stream = Readable.fromWeb(r.body);
    stream.pipe(res);
    req.on('close', () => { try { stream.destroy(); } catch { /* noop */ } });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 502, { error: 'download failed: ' + (e && e.message) });
    else res.end();
  }
}

function serveStatic(req, res, root, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  let urlPath = decodeURIComponent(url.pathname);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 带扩展名的资源缺失就直接 404，避免把 index.html 当成 .js/.png 返回
      if (path.extname(urlPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      fs.readFile(path.join(root, 'index.html'), (err2, fallback) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not Found');
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(fallback);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http://127.0.0.1:*; " +
  "img-src 'self' data: blob: https:; font-src 'self' data:;";

/** SSH over WebSocket（与上游 vite/server 实现协议一致） */
function attachSshProxy(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, sock, head) => {
    if (!req.url || !req.url.startsWith('/ws/ssh')) {
      sock.destroy();
      return;
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    const target = u.searchParams.get('target') || '';
    const parts = target.split(':');
    const targetHost = parts[0] || '127.0.0.1';
    const targetPort = parseInt(parts[1]) || 22;
    const sshUser = u.searchParams.get('user') || 'root';
    const sshPass = u.searchParams.get('password') || 'CherryYoudao';

    wss.handleUpgrade(req, sock, head, (ws) => {
      let sshClient = null;
      let sftpSession = null;
      let shellStream = null;

      const send = (data) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data)); };
      const sendData = (type, payload) => send({ type, ...payload });

      function openShell(cb) {
        if (!sshClient) return cb(new Error('SSH 未连接'));
        sshClient.shell({ term: 'xterm', cols: 90, rows: 30 }, (err, stream) => {
          if (err) return cb(err);
          shellStream = stream;
          stream.on('data', (d) => sendData('shell_data', { data: d.toString('utf-8') }));
          stream.stderr && stream.stderr.on('data', (d) => sendData('shell_data', { data: d.toString('utf-8') }));
          stream.on('close', () => { shellStream = null; sendData('shell_close', {}); });
          cb();
        });
      }

      sshClient = new Client();
      sshClient.on('ready', () => {
        sendData('connect_result', { ok: true });
        openShell((err) => {
          if (err) sendData('shell_data', { data: `\r\n[shell 启动失败: ${err.message}]\r\n` });
        });
      });
      sshClient.on('error', (err) => {
        sendData('connect_result', { ok: false, msg: err.message });
        sendData('shell_close', {});
      });
      sshClient.on('close', () => { sftpSession = null; shellStream = null; });
      sshClient.connect({ host: targetHost, port: targetPort, username: sshUser, password: sshPass, readyTimeout: 15000 });

      const sftpOpMap = {
        sftp_readdir(sftp, msg, cb) {
          sftp.readdir(msg.path, (err, list) => {
            if (err) return cb(err);
            cb(null, {
              files: list.map((e) => ({
                name: e.filename, isDir: e.attrs.isDirectory(), isSymlink: e.attrs.isSymbolicLink(),
                sizeBytes: Number(e.attrs.size), mtime: Math.floor(Number(e.attrs.mtime)),
              })),
            });
          });
        },
        sftp_read(sftp, msg, cb) {
          sftp.readFile(msg.path, (err, data) => {
            if (err) return cb(err);
            cb(null, { data: data.toString('base64'), isBase64: true });
          });
        },
        sftp_write(sftp, msg, cb) {
          sftp.writeFile(msg.path, Buffer.from(msg.data, 'base64'), (err) => cb(err, { ok: !err }));
        },
        sftp_delete(sftp, msg, cb) {
          sftp.unlink(msg.path, (err) => cb(err, { ok: !err }));
        },
        sftp_rename(sftp, msg, cb) {
          sftp.rename(msg.oldPath, msg.newPath, (err) => cb(err, { ok: !err }));
        },
        sftp_mkdir(sftp, msg, cb) {
          sftp.mkdir(msg.path, (err) => cb(err, { ok: !err }));
        },
        sftp_rmdir(sftp, msg, cb) {
          sftp.rmdir(msg.path, (err) => cb(err, { ok: !err }));
        },
      };

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        switch (msg.type) {
          case 'shell_input':
            if (shellStream) shellStream.write(msg.data);
            break;
          case 'shell_resize':
            if (shellStream) shellStream.setWindow(msg.rows || 30, msg.cols || 90);
            break;
          case 'exec':
            if (!sshClient) return sendData('error', { id: msg.id, msg: 'SSH 未连接' });
            sshClient.exec(msg.cmd, (err, stream) => {
              if (err) return sendData('error', { id: msg.id, msg: err.message });
              let output = '';
              stream.on('data', (d) => { output += d.toString(); });
              stream.stderr.on('data', (d) => { output += d.toString(); });
              stream.on('close', (code) => sendData('output', { id: msg.id, data: output.trim(), code }));
            });
            break;
          case 'shell_exec': {
            if (!sshClient) return sendData('error', { id: msg.id, msg: 'SSH 未连接' });
            const marker = '__PM_DONE_' + msg.id + '__';
            sshClient.shell({ term: 'dumb', cols: 200, rows: 50 }, (err, stream) => {
              if (err) return sendData('error', { id: msg.id, msg: err.message });
              let buf = '';
              let exitCode = 0;
              let finished = false;
              const finish = () => {
                if (finished) return;
                finished = true;
                sendData('shell_exec_result', { id: msg.id, code: exitCode });
                try { stream.end(); } catch { /* 已关闭 */ }
              };
              const onChunk = (d) => {
                buf += d.toString('utf-8');
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                  const line = buf.slice(0, nl);
                  buf = buf.slice(nl + 1);
                  const mi = line.indexOf(marker);
                  if (mi >= 0) {
                    const m = line.slice(mi + marker.length).match(/:(\d+)/);
                    if (m) exitCode = parseInt(m[1]);
                    return finish();
                  }
                  sendData('shell_exec_data', { id: msg.id, data: line + '\n' });
                }
              };
              stream.on('data', onChunk);
              stream.stderr && stream.stderr.on('data', onChunk);
              stream.on('close', () => finish());
              stream.write(msg.script + '\n');
              stream.write('echo ' + marker + ':$?\n');
              stream.write('exit\n');
            });
            break;
          }
          case 'sftp_readdir':
          case 'sftp_read':
          case 'sftp_write':
          case 'sftp_delete':
          case 'sftp_rename':
          case 'sftp_mkdir':
          case 'sftp_rmdir': {
            const sftpOp = (err, sftp) => {
              if (err) return sendData('error', { id: msg.id, msg: err.message });
              sftpOpMap[msg.type](sftp, msg, (err2, result) => {
                if (err2) return sendData('error', { id: msg.id, msg: err2.message });
                sendData('sftp_result', { id: msg.id, ...result });
              });
            };
            if (sftpSession) return sftpOp(null, sftpSession);
            if (!sshClient) return sendData('error', { id: msg.id, msg: 'SSH 未连接' });
            sshClient.sftp((err, sftp) => {
              if (err) return sendData('error', { id: msg.id, msg: err.message });
              sftpSession = sftp;
              sftpOp(null, sftp);
            });
            break;
          }
          default:
            break;
        }
      });

      ws.on('close', () => { try { sshClient && sshClient.end(); } catch { /* noop */ } });
      ws.on('error', () => { try { sshClient && sshClient.end(); } catch { /* noop */ } });
    });
  });
}

// 固定端口：渲染进程的 localStorage / IndexedDB 是按 origin(host:port) 隔离的，
// 每次启动换端口会让用户设置（连接模式、SSH 主机、已读免责声明、市场 Token）全部丢失。
const PREFERRED_PORT = 47821;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = err => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function startServer({ root, appVersion }) {
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400);
      return res.end('Bad Request');
    }
    if (url.pathname === '/api/gh') return handleGh(req, res, url);
    if (url.pathname === '/api/dl') return handleDownload(req, res, url);
    if (url.pathname === '/api/info') {
      return sendJson(res, 200, {
        app: 'penmods-installer-desktop',
        version: appVersion,
        platform: process.platform,
      });
    }
    serveStatic(req, res, root, url);
  });
  attachSshProxy(server);

  // 先用临时 socket 探测端口是否真的能绑，再让正式 server 去绑。
  // （直接对同一个 server 连续 listen 两次，Windows 上失败后容易拿到 address()===null，
  //   表现为窗口空白且 url 是 http://127.0.0.1:null/，所以改成先探测。）
  let port = 0;
  for (let attempt = 0; attempt < 6 && !port; attempt++) {
    const preferredThisTime = attempt === 0 ? PREFERRED_PORT : 0;
    let candidate = 0;
    const probe = net.createServer();
    try {
      candidate = await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(preferredThisTime, '127.0.0.1', () => resolve(probe.address().port));
      });
    } catch {
      candidate = 0;
    } finally {
      await new Promise((r) => probe.close(r));
    }
    if (!candidate) continue;
    try {
      await listen(server, candidate);
      const addr = server.address();
      if (addr && addr.port) port = addr.port;
    } catch {
      /* 端口刚好被抢走，换一个再来 */
    }
  }
  if (!port) throw new Error('本地服务启动失败：无法绑定 127.0.0.1 上的任何端口');
  return { server, port };
}

module.exports = { startServer };
