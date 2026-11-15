// 从 CHANGELOG.md 里取出指定版本的段落，写到 RELEASE_NOTES.md。
// 用法：node tools/release-notes.mjs v1.1.0
// 找不到对应版本时回退成整个 CHANGELOG，避免发出空的 Release 说明。
import fs from 'node:fs';
import path from 'node:path';

const tag = (process.argv[2] || '').replace(/^v/, '').trim();
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const outPath = path.join(root, 'RELEASE_NOTES.md');

const md = fs.readFileSync(changelogPath, 'utf8');
const sections = md.split(/^## /m).slice(1);
const hit = sections.find((section) => section.replace(/^v/, '').startsWith(`${tag} `) || section.replace(/^v/, '').startsWith(`${tag}\n`));

const body = hit
  ? `## ${hit.trim()}\n`
  : `${md.trim()}\n\n---\n\n版本 \`${tag || '未知'}\` 的独立说明还没写，以上是完整更新日志。\n`;

fs.writeFileSync(outPath, body);
console.log(`release notes -> ${outPath} (${body.length} chars, ${hit ? `matched v${tag}` : 'fallback: full changelog'})`);
