/**
 * 分段并行 + 断点续传下载器（对付高延迟/易断的链路）。
 *
 * 用法: node tools/dl_parallel.mjs <url> <out> [segments] [expectedSize]
 * 每个分片单独 Range 下载到 <out>.part<i>，可重复运行续传，完成后合并成 <out>。
 */
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2];
const out = process.argv[3];
const SEGS = Number(process.argv[4] || 12);
const EXPECT = Number(process.argv[5] || 0);
if (!url || !out) {
  console.error('usage: node tools/dl_parallel.mjs <url> <out> [segments] [expectedSize]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function head() {
  const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('HEAD failed ' + r.status);
  const len = Number(r.headers.get('content-length') || 0);
  const ranges = /bytes/i.test(r.headers.get('accept-ranges') || '');
  return { len, ranges };
}

let total = EXPECT;
for (let i = 0; i < 5 && !total; i++) {
  try {
    const h = await head();
    total = h.len || 0;
    console.log(`size=${total} accept-ranges=${h.ranges}`);
  } catch (e) {
    console.log('HEAD retry ' + e.message);
    await sleep(2000);
  }
}
if (!total) throw new Error('无法获取文件大小');

const segSize = Math.ceil(total / SEGS);
const parts = Array.from({ length: SEGS }, (_, i) => {
  const start = i * segSize;
  const end = Math.min(total - 1, start + segSize - 1);
  return { i, start, end, file: `${out}.part${i}`, size: end - start + 1 };
}).filter((p) => p.start <= p.end);

const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

async function downloadPart(p) {
  let got = sizeOf(p.file);
  if (got >= p.size) return p.size;
  let attempt = 0;
  while (got < p.size && attempt < 60) {
    attempt++;
    const from = p.start + got;
    try {
      const resp = await fetch(url, {
        headers: { Range: `bytes=${from}-${p.end}` },
        signal: AbortSignal.timeout(180000),
      });
      if (resp.status === 416) break;
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const fd = fs.openSync(p.file, 'a');
      try {
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          fs.writeSync(fd, value);
          got += value.length;
          if (got > p.size) throw new Error('segment overflow');
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      await sleep(1000 + attempt * 300);
    }
  }
  if (got < p.size) throw new Error(`part${p.i} incomplete ${got}/${p.size}`);
  return got;
}

// 进度显示
let done = 0;
const timer = setInterval(() => {
  const cur = parts.reduce((a, p) => a + Math.min(sizeOf(p.file), p.size), 0);
  console.log(`progress ${(cur / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)}MB (${((cur / total) * 100).toFixed(1)}%) parts=${done}/${parts.length}`);
}, 15000);

await Promise.all(
  parts.map(async (p) => {
    await downloadPart(p);
    done++;
    console.log(`part${p.i} done (${p.size}B)`);
  }),
);
clearInterval(timer);

// 合并
const fd = fs.openSync(out, 'w');
for (const p of parts) {
  const buf = fs.readFileSync(p.file);
  fs.writeSync(fd, buf);
}
fs.closeSync(fd);
for (const p of parts) fs.rmSync(p.file, { force: true });

const final = fs.statSync(out).size;
console.log(`RESULT ${out} ${final} bytes (expected ${total})`);
if (final !== total) throw new Error('size mismatch after merge');
