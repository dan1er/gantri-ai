// E2E smoke test for the Notion connector: import the COMPILED dist/ client,
// resolve + fetch a real FLC page, and (only when explicitly enabled) dry-run a
// comment. Catches wrong API paths, wrong auth, wrong response parsing, and
// markdown/anchor extraction bugs that the fetch-stubbed unit tests can't.
//
// IMPORTANT: build first (`npm run build`) so dist/ exists. Do NOT run this until
// a real NOTION_API_TOKEN exists and the page is shared with the integration.
//
// Usage (read-only — fetch + parse only):
//   NOTION_API_TOKEN=<token> NOTION_TEST_PAGE_URL='https://www.notion.so/...' \
//     node scripts/smoke-notion-tools.mjs
//
// To ACTUALLY post a test comment (writes to the page!), opt in explicitly:
//   ALLOW_COMMENT_WRITE=1 NOTION_API_TOKEN=<token> NOTION_TEST_PAGE_URL=<url> \
//     node scripts/smoke-notion-tools.mjs
//
// By default DRY_RUN is on: the script prints what it WOULD post and skips the
// write. Clean up any test comment you create manually afterwards.

import { NotionApiClient } from '../dist/connectors/notion/client.js';

const TOKEN = process.env.NOTION_API_TOKEN;
const PAGE_URL = process.env.NOTION_TEST_PAGE_URL;
const ALLOW_WRITE = process.env.ALLOW_COMMENT_WRITE === '1';

if (!TOKEN) {
  console.error('NOTION_API_TOKEN env var required');
  process.exit(2);
}
if (!PAGE_URL) {
  console.error('NOTION_TEST_PAGE_URL env var required (a page shared with the integration)');
  process.exit(2);
}

const client = new NotionApiClient({ token: TOKEN });

let fail = 0;

try {
  const pageId = client.resolvePageId(PAGE_URL);
  console.log(`  ✓ resolvePageId -> ${pageId}`);

  const { markdown, blocks } = await client.getPageMarkdown(pageId);
  console.log(`  ✓ getPageMarkdown -> ${blocks.length} blocks, ${markdown.length} chars of markdown`);
  console.log('  --- first 400 chars of markdown ---');
  console.log(markdown.slice(0, 400).replace(/^/gm, '    '));

  const firstBlock = blocks.find((b) => b.text.trim().length > 10);
  if (firstBlock) {
    const note = `smoke test comment (safe to delete) — anchored to: "${firstBlock.text.slice(0, 40)}…"`;
    if (ALLOW_WRITE) {
      await client.createBlockComment(firstBlock.blockId, note);
      console.log(`  ✓ createBlockComment -> posted to block ${firstBlock.blockId} (DELETE THIS COMMENT)`);
    } else {
      console.log(`  ⤷ DRY_RUN: would createBlockComment on ${firstBlock.blockId}: "${note}"`);
      console.log('    (set ALLOW_COMMENT_WRITE=1 to actually post)');
    }
  } else {
    console.log('  ! no block with enough text found to anchor a comment dry-run');
  }
} catch (err) {
  console.log(`  ✗ THREW  ${err && err.message ? err.message : String(err)}`);
  fail = 1;
}

console.log(fail === 0 ? '\n  smoke ok' : '\n  smoke FAILED');
process.exit(fail);
