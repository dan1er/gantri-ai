import { createHash } from 'node:crypto';
import { logger } from '../../../logger.js';
import { parseTierPromptVersion } from './extract.js';
import { DOMAIN_ENUM, DOMAIN_BASE_TIER, type Domain, type DomainBaseTierMap } from './decide.js';
import { TIER_RANK, type DeliveryTier } from '../board-config.js';

/**
 * Runtime source of the Delivery Tier rubric.
 *
 * Danny's decision: the rubric the classifier applies is READ FROM the live Notion
 * "Delivery Tier Classifier" page at runtime, so editing the page (e.g. a domain's
 * base-tier row) recalibrates the bot within one poll cycle — no PR, no deploy.
 *
 * The adopted prompt is the rendered page BODY + the repo-owned MACHINE APPENDIX
 * (the signals JSON contract stays committed so it is stable under page edits). The
 * `tableMap` (domain → base tier) is parsed from the page's Step 2 table and fed to
 * `decideTier` at runtime; the committed `DOMAIN_BASE_TIER` is the fallback seed.
 *
 * Guardrails (all mandatory):
 *   - A fetched page is STRUCTURALLY VALIDATED before it is adopted (version parses,
 *     the four Step headers are present, the table has all known domains with valid
 *     tiers, and the body length is sane). An invalid fetch is rejected: the
 *     last-known-good stays live and ONE ops-channel notice is posted per distinct
 *     failing hash.
 *   - Cache order: in-memory → Supabase last-known-good → live fetch. A cold boot
 *     with a persisted row works fully offline, so a Notion outage never blocks
 *     classification.
 *   - Adopting a NEW version/hash posts a short ops notice (diffing the table rows)
 *     and re-persists the last-known-good.
 */

/** The live "Delivery Tier Classifier" Notion page (32-char, undashed id). Editing
 *  this page recalibrates the classifier within one poll cycle. */
export const DELIVERY_TIER_RUBRIC_PAGE_ID = '39ddb572aef48169897efefd543290b9';

/** The four fields every consumer reads. */
export interface Rubric {
  /** The system prompt: rendered page body + repo-owned machine appendix. */
  promptText: string;
  /** Version parsed from the page's `Version: N` header line. */
  version: number;
  /** Domain → base tier, parsed from the page's Step 2 table. */
  tableMap: DomainBaseTierMap;
  /** sha256 of `promptText` — part of the classification cache key. */
  hash: string;
}

/** The page-body length window a real rubric must fall inside (guards against a
 *  truncated / empty / runaway fetch). */
const MIN_BODY_CHARS = 2000;
const MAX_BODY_CHARS = 40000;

/** The Notion page's `porter_catlog_products` typo → the code's canonical domain. */
const DOMAIN_TYPO_FIXES: Record<string, Domain> = {
  porter_catlog_products: 'porter_catalog_products',
};

/** sha256 hex of any string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Split the committed standard file into its page BODY (everything before the
 * machine-appendix marker) and the repo-owned APPENDIX (the marker and below). The
 * body is the fallback snapshot of the Notion page; the appendix is never on the
 * page and stays repo-owned.
 */
export function splitStandard(fileText: string): { body: string; appendix: string } {
  const marker = fileText.indexOf('--- MACHINE APPENDIX');
  if (marker === -1) {
    // No appendix marker → the whole file is the body (defensive; the committed
    // file always carries the marker, enforced by prompt.test.ts).
    return { body: fileText.trim(), appendix: '' };
  }
  return { body: fileText.slice(0, marker).trimEnd(), appendix: fileText.slice(marker).trim() };
}

/** Assemble the adopted prompt text from a page body and the repo-owned appendix. */
export function assemblePromptText(body: string, appendix: string): string {
  return appendix ? `${body.trimEnd()}\n\n${appendix.trim()}\n` : `${body.trim()}\n`;
}

/** True when a raw string is one of the three tier labels. */
function isTier(s: string): s is DeliveryTier {
  return s === 'T0' || s === 'T1' || s === 'T2';
}

/**
 * Parse the Step 2 domain → base-tier table out of a rendered page body. Reads the
 * slice between the Step 2 and Step 3 headers, then every `| domain | … | tier |`
 * row (normalizing the known page typo). Reports which known domains are missing and
 * which rows carried an invalid tier so the validator can reject a broken page.
 */
export function parseDomainTable(body: string): {
  tableMap: Partial<DomainBaseTierMap>;
  missing: Domain[];
  invalid: string[];
} {
  const s2 = body.indexOf('## Step 2');
  const s3 = body.indexOf('## Step 3');
  const region = s2 >= 0 && s3 > s2 ? body.slice(s2, s3) : body;
  const known = new Set<string>(DOMAIN_ENUM);
  const tableMap: Partial<DomainBaseTierMap> = {};
  const invalid: string[] = [];

  for (const line of region.split(/\r?\n/)) {
    if (!line.includes('|')) continue;
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length < 2) continue;
    const rawDomain = cells[0];
    const domain = (DOMAIN_TYPO_FIXES[rawDomain] ?? rawDomain) as string;
    if (!known.has(domain)) continue; // header row, separator row, prose
    const tierCell = cells[cells.length - 1];
    if (!isTier(tierCell)) {
      invalid.push(`${domain}=${tierCell}`);
      continue;
    }
    tableMap[domain as Domain] = tierCell;
  }

  const missing = (DOMAIN_ENUM as readonly Domain[]).filter((d) => tableMap[d] === undefined);
  return { tableMap, missing, invalid };
}

export interface RubricValidation {
  ok: boolean;
  version?: number;
  tableMap?: DomainBaseTierMap;
  error?: string;
}

/**
 * Structural validation of a fetched page body BEFORE it is adopted. Rejects (keeps
 * the last-known-good) unless: the `Version: N` line parses; the four `## Step`
 * headers are present in order; the Step 2 table carries every known domain with a
 * valid tier; and the body length is sane.
 */
export function validateRubricBody(body: string): RubricValidation {
  if (body.length < MIN_BODY_CHARS || body.length > MAX_BODY_CHARS) {
    return { ok: false, error: `body length ${body.length} out of range [${MIN_BODY_CHARS}, ${MAX_BODY_CHARS}]` };
  }

  let version: number;
  try {
    version = parseTierPromptVersion(body);
  } catch {
    return { ok: false, error: 'missing a "Version: N" header line' };
  }

  const stepIdx = [1, 2, 3, 4].map((n) => body.indexOf(`## Step ${n}`));
  if (stepIdx.some((i) => i < 0)) {
    return { ok: false, error: 'missing one of the four "## Step" headers' };
  }
  for (let i = 1; i < stepIdx.length; i++) {
    if (stepIdx[i] <= stepIdx[i - 1]) return { ok: false, error: 'the "## Step" headers are out of order' };
  }

  const { tableMap, missing, invalid } = parseDomainTable(body);
  // Check invalid tiers first: a row with a bad tier is also counted as "missing"
  // (it is not added to the map), so the invalid-tier reason is the more specific one.
  if (invalid.length > 0) {
    return { ok: false, error: `Step 2 table has invalid tier(s): ${invalid.slice(0, 5).join(', ')}` };
  }
  if (missing.length > 0) {
    return { ok: false, error: `Step 2 table is missing ${missing.length} domains: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}` };
  }

  return { ok: true, version, tableMap: tableMap as DomainBaseTierMap };
}

/** Build the committed fallback rubric from the raw standard file text. */
export function buildFallbackRubric(fileText: string): Rubric {
  const { body, appendix } = splitStandard(fileText);
  const v = validateRubricBody(body);
  const promptText = assemblePromptText(body, appendix);
  // The committed file is the seed of truth: if it somehow fails validation we still
  // build a rubric from it (with DOMAIN_BASE_TIER + the parsed version) rather than
  // crashing the boot — prompt.test.ts guards the file's integrity in CI.
  return {
    promptText,
    version: v.ok && v.version !== undefined ? v.version : safeVersion(body),
    tableMap: v.ok && v.tableMap ? v.tableMap : { ...DOMAIN_BASE_TIER },
    hash: sha256(promptText),
  };
}

function safeVersion(body: string): number {
  try {
    return parseTierPromptVersion(body);
  } catch {
    return 0;
  }
}

/** Reads a Notion page as markdown — the subset of `NotionApiClient` we need. */
export interface RubricPageReader {
  getPageMarkdown(pageId: string): Promise<{ markdown: string }>;
}

/** The persisted last-known-good store — implemented by `TierRubricCacheRepo`. */
export interface RubricCache {
  get(): Promise<{ pageText: string; version: number; hash: string } | null>;
  put(row: { pageText: string; version: number; hash: string }): Promise<void>;
}

/** Posts an operational notice (rubric reloaded / rejected). */
export interface RubricOps {
  post(text: string): Promise<void>;
}

export interface RubricSourceDeps {
  /** The Notion page id (32-char, undashed). */
  pageId: string;
  /** The repo-owned machine appendix (from `splitStandard`). */
  appendix: string;
  /** The committed fallback snapshot rubric (seed + offline last resort). */
  fallback: Rubric;
  /** Live page reader. Absent → fallback-only mode (no live fetch). */
  notion?: RubricPageReader;
  /** Persisted last-known-good. Absent → no persistence (memory + live only). */
  cache?: RubricCache;
  /** Ops-channel notifier. Absent → notices are logged only. */
  ops?: RubricOps;
}

/**
 * Holds the in-memory adopted rubric and refreshes it from the live page. `init()`
 * establishes the boot rubric (memory → cache → live), `getRubric()` returns the
 * current adopted rubric synchronously (no I/O — safe to call anywhere in a tick),
 * and `refresh()` (called once per poll tick) fetches the live page and adopts it on
 * a validated change.
 */
export class RubricSource {
  private current: Rubric;
  private booted = false;
  /** Failing-fetch hashes already reported, so we post ONE ops notice per distinct
   *  broken page revision instead of every tick. */
  private readonly reportedFailures = new Set<string>();

  constructor(private readonly deps: RubricSourceDeps) {
    this.current = deps.fallback;
  }

  /** The current adopted rubric — synchronous, never throws, never does I/O. */
  getRubric(): Rubric {
    return this.current;
  }

  /**
   * Boot order: in-memory (the fallback seed, already set) → Supabase last-known-good
   * → live fetch. A persisted row is preferred over a live fetch at boot so a cold
   * boot is fast and offline-safe; the first `refresh()` then pulls the live page.
   */
  async init(): Promise<Rubric> {
    if (this.booted) return this.current;
    this.booted = true;

    // 1. Supabase last-known-good.
    if (this.deps.cache) {
      try {
        const row = await this.deps.cache.get();
        if (row) {
          const adopted = this.rubricFromBody(row.pageText, row.version);
          if (adopted) {
            this.current = adopted;
            logger.info(
              { version: adopted.version, hash: adopted.hash.slice(0, 8) },
              'delivery_tier_rubric_boot_from_cache',
            );
            return this.current;
          }
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'delivery_tier_rubric_cache_read_failed',
        );
      }
    }

    // 2. No cache row → try one live fetch to warm the cache (best-effort).
    if (this.deps.notion) {
      await this.refresh({ notify: false });
    }
    return this.current;
  }

  /**
   * Fetch the live page and adopt it if it validates and its hash changed. Never
   * throws: a Notion outage logs a warning and leaves the last-known-good live. Call
   * once per poll tick.
   */
  async refresh(opts: { notify?: boolean } = {}): Promise<Rubric> {
    const notify = opts.notify ?? true;
    if (!this.deps.notion) return this.current;

    let body: string;
    try {
      const page = await this.deps.notion.getPageMarkdown(this.deps.pageId);
      body = (page.markdown ?? '').trim();
    } catch (err) {
      // A Notion outage must never block classification — keep the last-known-good.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'delivery_tier_rubric_fetch_failed',
      );
      return this.current;
    }

    const validation = validateRubricBody(body);
    if (!validation.ok || validation.version === undefined || !validation.tableMap) {
      await this.reportInvalid(body, validation.error ?? 'invalid');
      return this.current;
    }

    const promptText = assemblePromptText(body, this.deps.appendix);
    const hash = sha256(promptText);
    if (hash === this.current.hash) return this.current; // unchanged

    const prev = this.current;
    const next: Rubric = { promptText, version: validation.version, tableMap: validation.tableMap, hash };
    this.current = next;

    // Persist the new last-known-good (body only; the appendix is re-appended on load).
    if (this.deps.cache) {
      try {
        await this.deps.cache.put({ pageText: body, version: next.version, hash: next.hash });
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'delivery_tier_rubric_cache_write_failed',
        );
      }
    }

    await this.announceAdoption(prev, next, notify);
    return next;
  }

  /** Reassemble + validate a persisted / cached page body into a Rubric, or null. */
  private rubricFromBody(body: string, fallbackVersion: number): Rubric | null {
    const trimmed = (body ?? '').trim();
    const validation = validateRubricBody(trimmed);
    if (!validation.ok || !validation.tableMap) return null;
    const promptText = assemblePromptText(trimmed, this.deps.appendix);
    return {
      promptText,
      version: validation.version ?? fallbackVersion,
      tableMap: validation.tableMap,
      hash: sha256(promptText),
    };
  }

  /** Log + post ONE ops notice per distinct failing page hash. */
  private async reportInvalid(body: string, reason: string): Promise<void> {
    const failHash = sha256(body);
    logger.warn({ reason, hash: failHash.slice(0, 8) }, 'delivery_tier_rubric_rejected');
    if (this.reportedFailures.has(failHash)) return;
    this.reportedFailures.add(failHash);
    const text = `:warning: Delivery Tier rubric page REJECTED (kept last-known-good Version ${this.current.version}): ${reason}. Fix the Notion page — the bot is still classifying on the previous rubric.`;
    if (this.deps.ops) {
      try {
        await this.deps.ops.post(text);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'delivery_tier_rubric_ops_notice_failed');
      }
    }
  }

  /** Log + (optionally) post the "rubric reloaded" ops notice with a table diff. */
  private async announceAdoption(prev: Rubric, next: Rubric, notify: boolean): Promise<void> {
    const changes = diffTableMaps(prev.tableMap, next.tableMap);
    const changeText = changes.length ? `: ${changes.join(', ')}` : '';
    const text = `Delivery Tier rubric reloaded: Version ${next.version} (hash ${next.hash.slice(0, 8)}) — ${changes.length} table row${changes.length === 1 ? '' : 's'} changed${changeText}`;
    logger.info(
      { fromVersion: prev.version, toVersion: next.version, hash: next.hash.slice(0, 8), changedRows: changes.length },
      'delivery_tier_rubric_reloaded',
    );
    if (notify && this.deps.ops) {
      try {
        await this.deps.ops.post(text);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'delivery_tier_rubric_ops_notice_failed');
      }
    }
  }
}

/** Human-readable list of domains whose base tier changed between two maps. */
export function diffTableMaps(prev: DomainBaseTierMap, next: DomainBaseTierMap): string[] {
  const changes: string[] = [];
  for (const domain of DOMAIN_ENUM as readonly Domain[]) {
    const a = prev[domain];
    const b = next[domain];
    if (a !== b) changes.push(`${domain} ${a ?? '?'}→${b ?? '?'}`);
  }
  // Deterministic order already (DOMAIN_ENUM order). Reference TIER_RANK to keep the
  // import meaningful for future tier-aware sorting without changing behavior.
  void TIER_RANK;
  return changes;
}
