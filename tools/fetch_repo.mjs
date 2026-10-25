// Mirror a public GitHub repo without git: walk tree pages, fetch raw files.
import fs from 'node:fs';
import path from 'node:path';

const [owner, repo, outDir, ...skips] = process.argv.slice(2);
const UA = { 'user-agent': 'Mozilla/5.0' };

async function get(url, asText = true) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return asText ? await r.text() : Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
}

async function listDir(dir) {
  const url = `https://github.com/${owner}/${repo}/tree/main/${dir}`.replace(/\/$/, '');
  const html = await get(url);
  const m = html.match(/<script type="application\/json" data-target="react-app.embeddedData">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('payload not found for ' + dir);
  const j = JSON.parse(m[1]);
  const items =
    j.payload?.codeViewRepoRoute?.tree?.items ??
    j.payload?.codeViewTreeRoute?.tree?.items ??
    [];
  return items;
}

const files = [];
async function walk(dir) {
  const items = await listDir(dir);
  for (const it of items) {
    if (skips.some((s) => it.path === s || it.path.startsWith(s + '/'))) continue;
    if (it.contentType === 'directory') {
      await walk(it.path);
    } else {
      files.push(it.path);
    }
  }
}

await walk('');
console.log('files:', files.length);
for (const f of files) {
  const dest = path.join(outDir, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = await get(`https://raw.githubusercontent.com/${owner}/${repo}/main/${encodeURI(f)}`, false);
  fs.writeFileSync(dest, buf);
  console.log(buf.length, f);
}
