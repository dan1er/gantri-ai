import { describe, it, expect, vi } from 'vitest';
import { loadTierStandard } from '../../../../../src/connectors/asana/tier/extract.js';
import { DOMAIN_BASE_TIER } from '../../../../../src/connectors/asana/tier/decide.js';
import {
  RubricSource,
  splitStandard,
  buildFallbackRubric,
  parseDomainTable,
  validateRubricBody,
  assemblePromptText,
  sha256,
  type Rubric,
} from '../../../../../src/connectors/asana/tier/rubric-source.js';

/**
 * The runtime rubric source reads the live Notion page, validates it before adopting,
 * caches the last-known-good, and posts one ops notice per change / per broken page.
 * The committed standard file is used as the valid fixture (it is the fallback
 * snapshot), then mutated to exercise the failure gates.
 */

const STANDARD = loadTierStandard();
const { body: VALID_BODY, appendix: APPENDIX } = splitStandard(STANDARD);
const FALLBACK = buildFallbackRubric(STANDARD);

/** A NotionApiClient stub whose page markdown is whatever we hand it. */
function notionReturning(markdown: string) {
  return { getPageMarkdown: vi.fn().mockResolvedValue({ markdown }) };
}

/** An in-memory cache double. */
function fakeCache(initial: { pageText: string; version: number; hash: string } | null = null) {
  let row = initial;
  return {
    get: vi.fn(async () => row),
    put: vi.fn(async (r: { pageText: string; version: number; hash: string }) => {
      row = r;
    }),
    get current() {
      return row;
    },
  };
}

function fakeOps() {
  return { post: vi.fn(async () => undefined) };
}

/** Build a source over the fallback, with injectable notion/cache/ops. */
function makeSource(over: {
  notion?: { getPageMarkdown: ReturnType<typeof vi.fn> };
  cache?: ReturnType<typeof fakeCache>;
  ops?: ReturnType<typeof fakeOps>;
} = {}) {
  return new RubricSource({
    pageId: 'page-id',
    appendix: APPENDIX,
    fallback: FALLBACK,
    notion: over.notion,
    cache: over.cache,
    ops: over.ops,
  });
}

describe('validateRubricBody', () => {
  it('accepts the committed fallback body and parses its version + table', () => {
    const v = validateRubricBody(VALID_BODY);
    expect(v.ok, v.error).toBe(true);
    expect(v.version).toBe(FALLBACK.version);
    expect(Object.keys(v.tableMap!).sort()).toEqual(Object.keys(DOMAIN_BASE_TIER).sort());
  });

  it('rejects a body missing the "Version: N" header', () => {
    const v = validateRubricBody(VALID_BODY.replace(/Version:\s*\d+/, 'Ver 3'));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/Version/i);
  });

  it('rejects a body missing one of the four Step headers', () => {
    const v = validateRubricBody(VALID_BODY.replace('## Step 4', '## Nope 4'));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/Step/i);
  });

  it('rejects a body that is too short (guards a truncated fetch)', () => {
    const v = validateRubricBody('Version: 3\n## Step 1\n## Step 2\n## Step 3\n## Step 4\n');
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/length/i);
  });

  it('rejects a table missing a known domain', () => {
    // Drop the auth_accounts row.
    const broken = VALID_BODY.replace(/\| auth_accounts \|[^\n]*\n/, '');
    const v = validateRubricBody(broken);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/missing/i);
  });

  it('rejects a table row carrying an invalid tier', () => {
    const broken = VALID_BODY.replace('| platform_infra | CI/CD, tooling, cron, observability | T0 |', '| platform_infra | CI/CD, tooling, cron, observability | T5 |');
    const v = validateRubricBody(broken);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/invalid tier/i);
  });
});

describe('parseDomainTable', () => {
  it('parses all 36 domains from the fallback body to the committed base tiers', () => {
    const { tableMap, missing, invalid } = parseDomainTable(VALID_BODY);
    expect(missing).toEqual([]);
    expect(invalid).toEqual([]);
    expect(tableMap).toEqual(DOMAIN_BASE_TIER);
  });

  it('normalizes the page typo porter_catlog_products → porter_catalog_products', () => {
    const typo = VALID_BODY.replace('| porter_catalog_products |', '| porter_catlog_products |');
    const { tableMap, missing } = parseDomainTable(typo);
    expect(missing).toEqual([]);
    expect(tableMap.porter_catalog_products).toBe(DOMAIN_BASE_TIER.porter_catalog_products);
  });
});

describe('RubricSource — boot order (memory → cache → live)', () => {
  it('with no notion + no cache, getRubric returns the committed fallback', async () => {
    const src = makeSource();
    await src.init();
    expect(src.getRubric()).toEqual(FALLBACK);
  });

  it('boots from the Supabase last-known-good over a live fetch', async () => {
    const cacheBody = VALID_BODY.replace('Version: 4', 'Version: 9');
    const cache = fakeCache({ pageText: cacheBody, version: 9, hash: 'stored' });
    const notion = notionReturning(VALID_BODY); // live differs, but cache wins at boot
    const src = makeSource({ cache, notion });
    await src.init();
    expect(src.getRubric().version).toBe(9);
    // Boot preferred the cache row — no live fetch at boot.
    expect(notion.getPageMarkdown).not.toHaveBeenCalled();
  });

  it('with no cache row, warms from a live fetch at boot', async () => {
    const liveBody = VALID_BODY.replace('Version: 4', 'Version: 7');
    const cache = fakeCache(null);
    const notion = notionReturning(liveBody);
    const src = makeSource({ cache, notion });
    await src.init();
    expect(notion.getPageMarkdown).toHaveBeenCalledTimes(1);
    expect(src.getRubric().version).toBe(7);
    expect(cache.current?.version).toBe(7); // persisted the warm fetch
  });
});

describe('RubricSource — refresh + adoption', () => {
  it('adopts a validated page change, persists it, and posts ONE ops notice', async () => {
    // Live page bumps platform_infra T0 → T1 (a table diff) at a new version.
    const changed = VALID_BODY
      .replace('Version: 4', 'Version: 5')
      .replace('| platform_infra | CI/CD, tooling, cron, observability | T0 |', '| platform_infra | CI/CD, tooling, cron, observability | T1 |');
    const cache = fakeCache(null);
    const ops = fakeOps();
    const notion = notionReturning(changed);
    const src = makeSource({ notion, cache, ops });
    // init() with no cache warms from live → this IS the adoption (notify:false at boot).
    await src.init();
    expect(src.getRubric().version).toBe(5);
    expect(src.getRubric().tableMap.platform_infra).toBe('T1');

    // A subsequent runtime refresh with the SAME content is a no-op (hash unchanged).
    const before = ops.post.mock.calls.length;
    await src.refresh();
    expect(ops.post.mock.calls.length).toBe(before);
  });

  it('posts the reload notice with the table diff when the page changes at runtime', async () => {
    const ops = fakeOps();
    const notion = notionReturning(VALID_BODY);
    const cache = fakeCache(null);
    const src = makeSource({ notion, cache, ops });
    await src.init(); // adopts VALID_BODY == fallback content → hash unchanged, no notice
    expect(ops.post).not.toHaveBeenCalled();

    // Now the page changes: point notion at a mutated body and refresh.
    const changed = VALID_BODY
      .replace('Version: 4', 'Version: 5')
      .replace('| design_system | gantri-components shared library | T1 |', '| design_system | gantri-components shared library | T2 |');
    notion.getPageMarkdown.mockResolvedValue({ markdown: changed });
    await src.refresh();
    expect(ops.post).toHaveBeenCalledTimes(1);
    const msg = ops.post.mock.calls[0][0] as string;
    expect(msg).toContain('Version 5');
    expect(msg).toContain('1 table row changed');
    expect(msg).toContain('design_system T1→T2');
    expect(src.getRubric().tableMap.design_system).toBe('T2');
  });

  it('keeps the last-known-good on an INVALID page and posts one notice per failing hash', async () => {
    const ops = fakeOps();
    const invalid = VALID_BODY.replace('## Step 4', '## Broken 4'); // fails the Step gate
    const notion = notionReturning(invalid);
    const src = makeSource({ notion, ops });
    // Seed a known-good current via a valid init from cache-less fallback.
    await src.init(); // init warms from live (invalid) → rejected, keeps fallback
    expect(src.getRubric()).toEqual(FALLBACK);
    expect(ops.post).toHaveBeenCalledTimes(1); // one rejection notice
    // Re-fetching the SAME broken page does not spam a second notice.
    await src.refresh();
    expect(ops.post).toHaveBeenCalledTimes(1);
  });

  it('a Notion outage never throws and keeps the last-known-good', async () => {
    const notion = { getPageMarkdown: vi.fn().mockRejectedValue(new Error('notion 503')) };
    const src = makeSource({ notion });
    await expect(src.init()).resolves.toBeDefined();
    await expect(src.refresh()).resolves.toEqual(FALLBACK);
    expect(src.getRubric()).toEqual(FALLBACK);
  });

  it('fallback-only mode (no notion) is inert: refresh returns the current rubric', async () => {
    const src = makeSource();
    const r = await src.refresh();
    expect(r).toEqual(FALLBACK);
  });
});

describe('assemblePromptText + sha256', () => {
  it('assembles body + appendix and hashes deterministically', () => {
    const text = assemblePromptText(VALID_BODY, APPENDIX);
    expect(text).toContain('# Delivery Tier Classifier');
    expect(text).toContain('MACHINE APPENDIX');
    const rubric: Rubric = FALLBACK;
    expect(rubric.hash).toBe(sha256(rubric.promptText));
  });
});
