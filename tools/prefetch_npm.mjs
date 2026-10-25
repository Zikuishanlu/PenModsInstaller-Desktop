/**
 * 预取 package-lock.json 里所有 tarball（带 Range 断点续传 + 重试），
 * 下载完再 `npm cache add` 灌进 npm cache，最后离线 npm install。
 *
 * 用法: node tools/prefetch_npm.mjs app/package-lock.json _ref/tarballs
 */
import fs from 'node:fs';
import path from 'node:path';

const lockPath = process.argv[2] || 'app/package-lock.json';
const outDir = process.argv[3] || '_ref/tarballs';
const PARALLEL = Number(process.env.PARALLEL || 6);
const ATTEMPTS = Number(process.env.ATTEMPTS || 40);

fs.mkdirSync(outDir, { recursive: true });

const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const entries = Object.entries(lock.packages || {}).filter(([k]) => k);

function compatible(info) {
  const os = info.os;
  const cpu = info.cpu;
  if (Array.isArray(os) && os.length && !os.includes('win32')) return false;
  if (Array.isArray(cpu) && cpu.length && !cpu.includes('x64')) return false;
  return true;
}

const jobs = [];
for (const [key, info] of entries) {
  if (!info.resolved || !/^https?:/.test(info.resolved)) continue;
  if (!info.resolved.split('?')[0].endsWith('.tgz')) continue;
  if (!compatible(info)) continue;
  const name = key.replace(/^.*node_modules\//, '');
  const safe = (name + '-' + (info.version || '')).replace(/[\\/:*?"<>|@]/g, '_');
  jobs.push({ key, name, version: info.version, url: info.resolved, file: path.join(outDir, safe + '.tgz') });
}

console.log(`entries=${entries.length} tarballs=${jobs.length} -> ${outDir}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOne(job) {
  const out = job.file;
  let received = 0;
  try { received = fs.statSync(out).size; } catch { received = 0; }
  let total = 0;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const headers = {};
    if (received > 0) headers.Range = `bytes=${received}-`;
    let resp;
    try {
      resp = await fetch(job.url, { headers, signal: AbortSignal.timeout(120000) });
    } catch (e) {
      console.log(`[net] ${job.name} attempt ${attempt + 1}: ${e.message} (have ${received})`);
      await sleep(1500 + attempt * 500);
      continue;
    }
    if (resp.status === 416) {
      // 已经下满
      total = received;
      break;
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} for ${job.url}`);
    }
    const len = Number(resp.headers.get('content-length') || 0);
    if (resp.status === 206) total = received + len;
    else { total = len; received = 0; }

    const fd = fs.openSync(out, received > 0 && resp.status === 206 ? 'a' : 'w');
    let broke = false;
    try {
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        fs.writeSync(fd, value);
        received += value.length;
      }
    } catch (e) {
      broke = true;
      console.log(`[brk] ${job.name}: ${e.message} (${received}/${total})`);
    } finally {
      fs.closeSync(fd);
    }
    if (!broke && (total === 0 || received >= total)) break;
    await sleep(1200 + attempt * 400);
  }

  const got = fs.existsSync(out) ? fs.statSync(out).size : 0;
  if (total > 0 && got < total) {
    throw new Error(`incomplete ${job.name}: ${got}/${total}`);
  }
  return got;
}

let idx = 0;
let bytes = 0;
let ok = 0;
const failed = [];

async function worker(n) {
  for (;;) {
    const i = idx++;
    if (i >= jobs.length) return;
    const job = jobs[i];
    try {
      const got = await fetchOne(job);
      bytes += got;
      ok++;
      if (ok % 10 === 0 || ok === jobs.length) {
        console.log(`progress ${ok}/${jobs.length} (${(bytes / 1048576).toFixed(1)}MB) last=${job.name}`);
      }
    } catch (e) {
      failed.push(job.name + ': ' + e.message);
      console.log(`[fail] ${e.message}`);
    }
  }
}

await Promise.all(Array.from({ length: PARALLEL }, (_, i) => worker(i)));

console.log(`DONE ok=${ok}/${jobs.length} bytes=${(bytes / 1048576).toFixed(1)}MB failed=${failed.length}`);
for (const f of failed) console.log('  ! ' + f);
fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify(jobs, null, 2));
