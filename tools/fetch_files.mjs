import fs from 'fs';
import path from 'path';

const UA = { 'user-agent': 'Mozilla/5.0' };
const ROOT = 'app/public/files';
const LIST = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean) : [];

async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}

let done = 0, bytes = 0;
const queue = [...LIST];
async function worker() {
  while (queue.length) {
    const rel = queue.shift();
    if (!rel) break;
    const local = path.join(ROOT, rel);
    if (fs.existsSync(local) && fs.statSync(local).size > 0) { done++; continue; }
    try {
      const buf = await get('https://raw.githubusercontent.com/skdkzzx/PenModsInstaller/main/public/files/' + rel);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, buf);
      bytes += buf.length; done++;
      if (done % 10 === 0) console.log(`[${done}/${LIST.length}] ${(bytes / 1048576).toFixed(1)}MB`);
    } catch (e) {
      console.log('FAIL', rel, e.message);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log('DONE', done, 'files', (bytes / 1048576).toFixed(1) + 'MB');
