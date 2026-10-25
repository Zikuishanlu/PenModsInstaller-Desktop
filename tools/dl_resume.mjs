// 断点续传下载：node tools/dl_resume.mjs <url> <out> [expectedSize]
// 慢速不稳定网络下用 Range 续传，避免每次 ECONNRESET 都从头再来。
import fs from 'fs';

const [, , url, out, expectedArg] = process.argv;
const expected = expectedArg ? Number(expectedArg) : 0;
const UA = { 'user-agent': 'Mozilla/5.0', connection: 'keep-alive' };

async function attempt(offset, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      const headers = { ...UA };
      if (offset > 0) headers.range = `bytes=${offset}-`;
      const r = await fetch(url, { headers });
      if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
      const total = r.status === 206
        ? offset + Number(r.headers.get('content-length') || 0)
        : Number(r.headers.get('content-length') || expected || 0);
      return { r, total };
    } catch (e) {
      console.log(`  attempt ${i + 1} failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error('all attempts failed');
}

fs.writeFileSync(out, Buffer.alloc(0));
let got = 0;
let total = expected;
for (let round = 0; round < 12; round++) {
  const { r, total: t } = await attempt(got);
  total = t || total;
  const fd = fs.openSync(out, 'r+');
  fs.ftruncateSync(fd, got);
  let roundBytes = 0;
  try {
    for await (const chunk of r.body) {
      fs.writeSync(fd, chunk, 0, chunk.length, got);
      got += chunk.length;
      roundBytes += chunk.length;
    }
  } catch (e) {
    console.log(`  stream broke after +${roundBytes}B: ${e.message}`);
  } finally {
    fs.closeSync(fd);
  }
  console.log(`  ${got}/${total || '?'} (${(got / 1048576).toFixed(2)}MB)`);
  if (total ? got >= total : roundBytes === 0) break;
}

console.log(`RESULT ${out} ${got} bytes${total ? ' / ' + total : ''}`);
if (total && got < total) process.exit(1);
