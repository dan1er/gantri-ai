// Copy src/prompts/*.md -> dist/prompts/ after `tsc` (tsc ignores .md files).
// Wired as `postbuild` in package.json. The Dockerfile does the same copy
// inline (it runs `npx tsc` directly and doesn't have scripts/ available).
import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve('src/prompts');
const dstDir = path.resolve('dist/prompts');

mkdirSync(dstDir, { recursive: true });
let copied = 0;
for (const file of readdirSync(srcDir)) {
  if (file.endsWith('.md')) {
    copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
    copied += 1;
  }
}
console.log(`copy-prompts: copied ${copied} markdown file(s) to dist/prompts/`);
