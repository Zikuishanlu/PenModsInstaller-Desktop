/**
 * 校验预取的 tarball 与 lockfile 里的 integrity 是否一致（sha512/sha1，base64）。
 * 用法: node tools/verify_tarballs.mjs app/package-lock.json _ref/tarballs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const lockPath = process.argv[2] || 'app/package-lock.json';
const dir = process.argv[3] || '_ref/tarballs';

const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

function safeName(key, info) {
  const name = key.replace(/^.*node_modules\//, '');
  return (name + '-' + (info.version || '')).replace(/[\\/:*?"<>|@]/g, '_') + '.tgz';
}

const byFile = new Map();
for (const [key, info] of Object.entries(lock.packages || {})) {
  if (!key || !info.resolved || !/\.tgz$/.test(info.resolved)) continue;
  byFile.set(safeName(key, info), info);
}

const bad = [];
const missing = [];
let checked = 0;
for (const [file, info] of byFile) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) { missing.push(file); continue; }
  const buf = fs.readFileSync(p);
  let expect = String(info.integrity || '');
  const algo = expect.startsWith('sha512-') ? 'sha512' : expect.startsWith('sha1-') ? 'sha1' : '';
  if (!algo) continue;
  const want = expect.slice(algo.length + 1);
  const got = crypto.createHash(algo).update(buf).digest('base64');
  checked++;
  if (got !== want) bad.push({ file, size: buf.length, url: info.resolved });
}

console.log(`checked=${checked} missing=${missing.length} corrupt=${bad.length}`);
for (const m of missing.slice(0, 20)) console.log('  missing ' + m);
for (const b of bad) console.log(`  CORRUPT ${b.file} (${b.size}B) ${b.url}`);
fs.writeFileSync(path.join(dir, '_corrupt.json'), JSON.stringify(bad, null, 2));
