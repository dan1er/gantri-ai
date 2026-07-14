import type { AsanaApiClient, AsanaTask } from '../client.js';
import type { TierClassificationsRepo, TierClassificationRecord } from '../../../storage/repositories/tier-classifications.js';
import {
  DELIVERY_TIER_FIELD_GID,
  SOFTWARE_BOARD_PROJECT_GID,
  TYPE_FIELD_GID,
  isFeatureTemplateTask,
  isTierExcludedType,
  optionGidToTier,
  tierToOptionGid,
} from '../board-config.js';
import { extractFacts, tierInputHash, type ExtractDeps } from './extract.js';
import { decideTier } from './decide.js';
import { renderTierComment } from './comment.js';
import { logger } from '../../../logger.js';

/**
 * Polling classifier. Every tick it scans the Software Board for tasks that need
 * a Delivery Tier and classifies them: extract facts (one Haiku call) → compute
 * the tier (pure) → write the field + a comment → persist the record. Idempotent
 * by construction (field set = done, cached by content hash), and it never
 * touches a task a human has overridden.
 */

/** opt_fields needed to classify: the description, completion, creation time, the
 *  Type option name (for exclusion), and the current Delivery Tier value. */
const OPT_FIELDS_TASK = [
  'name',
  'notes',
  'completed',
  'created_at',
  'custom_fields.gid',
  'custom_fields.name',
  'custom_fields.enum_value.gid',
  'custom_fields.enum_value.name',
].join(',');

/** Minimum description length to attempt a classification (thin tickets are noise). */
const MIN_NOTES_CHARS = 40;

/** How many tasks to classify in parallel. */
const CLASSIFY_CONCURRENCY = 3;

export interface TierPollerDeps {
  client: AsanaApiClient;
  repo: TierClassificationsRepo;
  extract: ExtractDeps;
  /** Prompt version parsed from the rubric file (part of the content hash). */
  promptVersion: number;
  /** Only classify tasks created at or after this instant (no backfill spam). */
  rolloutDateMs: number;
}

export interface TierPollResult {
  scanned: number;
  candidates: number;
  classified: number;
  reclassified: number;
  overrides: number;
  skipped: number;
  failed: number;
}

/** Read the enum option gid of a task's Delivery Tier field, or null if empty. */
function currentTierOptionGid(task: AsanaTask): string | null {
  const cf = (task.custom_fields ?? []).find((f) => f.gid === DELIVERY_TIER_FIELD_GID);
  return cf?.enum_value?.gid ?? null;
}

/** Read the display name of a task's Type field option, or '' if absent. */
function typeName(task: AsanaTask): string {
  const cf = (task.custom_fields ?? []).find((f) => f.gid === TYPE_FIELD_GID);
  return cf?.enum_value?.name ?? '';
}

export class TierPoller {
  constructor(private readonly deps: TierPollerDeps) {}

  /** One full scan + classify pass. Safe to call repeatedly; each task is
   *  processed independently so one failure never blocks the batch. */
  async runOnce(): Promise<TierPollResult> {
    const tasks = await this.deps.client.getProjectTasks(SOFTWARE_BOARD_PROJECT_GID, OPT_FIELDS_TASK);
    const candidates = tasks.filter((t) => this.isCandidate(t));
    logger.info({ scanned: tasks.length, candidates: candidates.length }, 'delivery_tier_poll_scan');

    const result: TierPollResult = {
      scanned: tasks.length,
      candidates: candidates.length,
      classified: 0,
      reclassified: 0,
      overrides: 0,
      skipped: 0,
      failed: 0,
    };

    await mapWithConcurrency(candidates, CLASSIFY_CONCURRENCY, async (task) => {
      try {
        const outcome = await this.processOne(task);
        result[outcome] += 1;
      } catch (err) {
        result.failed += 1;
        logger.warn(
          { taskGid: task.gid, err: err instanceof Error ? err.message : String(err) },
          'delivery_tier_classify_failed',
        );
      }
    });

    logger.info(result, 'delivery_tier_poll_done');
    return result;
  }

  /** Structural eligibility (cheap, no I/O): the "which tasks get classified"
   *  gate from the design. */
  private isCandidate(task: AsanaTask): boolean {
    if (task.completed) return false;
    if (isFeatureTemplateTask(task)) return false;
    const createdMs = task.created_at ? Date.parse(task.created_at) : Number.NEGATIVE_INFINITY;
    if (!(createdMs >= this.deps.rolloutDateMs)) return false;
    if ((task.notes ?? '').trim().length < MIN_NOTES_CHARS) return false;
    if (isTierExcludedType(typeName(task))) return false;
    return true;
  }

  private async processOne(
    task: AsanaTask,
  ): Promise<'classified' | 'reclassified' | 'overrides' | 'skipped'> {
    const currentGid = currentTierOptionGid(task);
    const record = await this.deps.repo.get(task.gid);

    if (record) {
      if (record.decidedBy === 'human_override') return 'skipped';
      // Bot-owned record: has a human changed the field out from under us?
      const botGid = tierToOptionGid(record.tier);
      if (currentGid !== botGid) {
        await this.deps.repo.markOverride(task.gid, optionGidToTier(currentGid));
        logger.info({ taskGid: task.gid, botTier: record.tier, humanTier: optionGidToTier(currentGid) }, 'delivery_tier_human_override');
        return 'overrides';
      }
      // Field still matches the bot. Re-classify only if the description changed
      // materially (content hash differs).
      const hash = tierInputHash(this.deps.promptVersion, this.toInput(task));
      if (hash === record.inputHash) return 'skipped';
      await this.classify(task);
      return 'reclassified';
    }

    // No bot record. If the field is already set, a human set it before the bot
    // ever saw the task — leave it alone (the bot has no opinion to compare).
    if (currentGid !== null) return 'skipped';

    // Empty field, never classified → classify it.
    await this.classify(task);
    return 'classified';
  }

  private toInput(task: AsanaTask) {
    return { name: task.name ?? '', notes: task.notes ?? '', typeName: typeName(task) };
  }

  /** Extract → decide → write field + comment → persist. */
  private async classify(task: AsanaTask): Promise<void> {
    const input = this.toInput(task);
    const hash = tierInputHash(this.deps.promptVersion, input);
    const facts = await extractFacts(input, this.deps.extract);
    const decision = decideTier(facts);

    await this.deps.client.setEnumCustomField(
      task.gid,
      DELIVERY_TIER_FIELD_GID,
      tierToOptionGid(decision.tier),
    );
    const commentText = renderTierComment(decision, facts, this.deps.promptVersion);
    const story = await this.deps.client.createStory(task.gid, commentText);

    await this.deps.repo.upsertBot({
      taskGid: task.gid,
      inputHash: hash,
      promptVersion: this.deps.promptVersion,
      facts,
      tier: decision.tier,
      liftedByUnclear: decision.liftedByUnclear,
      flags: decision.flags,
      domain: facts.domain,
      commentGid: story?.gid ?? null,
    });
    logger.info({ taskGid: task.gid, tier: decision.tier, firedRule: decision.firedRule }, 'delivery_tier_classified');
  }
}

/** Re-export so the poll runner can type a record without a deep import. */
export type { TierClassificationRecord };

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}
