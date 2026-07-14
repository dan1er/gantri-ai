import type { AsanaApiClient, AsanaTask } from '../client.js';
import type { TierClassificationsRepo, TierClassificationRecord } from '../../../storage/repositories/tier-classifications.js';
import {
  DELIVERY_TIER_FIELD_GID,
  SOFTWARE_BOARD_PROJECT_GID,
  TIER_RANK,
  TYPE_FIELD_GID,
  isFeatureTemplateTask,
  isInCodeReview,
  isTierExcludedType,
  optionGidToTier,
  tierToOptionGid,
} from '../board-config.js';
import type { DeliveryTier } from '../board-config.js';
import { extractFacts, tierInputHash, type ExtractDeps } from './extract.js';
import { decideTier } from './decide.js';
import { renderTierComment } from './comment.js';
import type { AuthoritativePass, AuthoritativeResult } from './authoritative-pass.js';
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
  // Section membership drives the Code-Review authoritative pass.
  'memberships.section.gid',
  'memberships.section.name',
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
  /** The Code-Review authoritative pass. When present, tasks that have entered
   *  the Code Review section on this scan are re-classified from their PR diff.
   *  Optional (disabled when there is no GitHub token). */
  authoritative?: AuthoritativePass;
}

export interface TierPollResult {
  scanned: number;
  candidates: number;
  classified: number;
  reclassified: number;
  overrides: number;
  skipped: number;
  failed: number;
  /** Outcome of the Code-Review authoritative pass this tick (null when disabled). */
  authoritative: AuthoritativeResult | null;
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
    // Full-history scan (unbounded): the board keeps completed tasks, so a 50-page
    // cap would silently drop the newest ones once it grows past 5000.
    const tasks = await this.deps.client.getProjectTasksUnbounded(SOFTWARE_BOARD_PROJECT_GID, OPT_FIELDS_TASK);
    // All bot-owned records, so overrides can be detected even on tasks that no
    // longer pass the candidate gate.
    const botRecords = await this.deps.repo.listActiveBot();
    const botByGid = new Map(botRecords.map((r) => [r.taskGid, r]));
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
      authoritative: null,
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

    // Override sweep over the NON-candidates the bot previously classified. A human
    // often re-tiers a ticket exactly when marking it complete (or after the Type
    // changes / the description shrinks) — that override must still be recorded and
    // fed to the Monday report, even though the task no longer classifies.
    for (const task of tasks) {
      if (this.isCandidate(task)) continue;
      const rec = botByGid.get(task.gid);
      if (!rec) continue;
      const current = currentTierOptionGid(task);
      if (current === null || botKnownGids(rec).has(current)) continue;
      try {
        await this.deps.repo.markOverride(task.gid, optionGidToTier(current));
        result.overrides += 1;
        logger.info({ taskGid: task.gid, botTier: rec.tier, humanTier: optionGidToTier(current) }, 'delivery_tier_human_override');
      } catch (err) {
        result.failed += 1;
        logger.warn(
          { taskGid: task.gid, err: err instanceof Error ? err.message : String(err) },
          'delivery_tier_override_sweep_failed',
        );
      }
    }

    // Authoritative pass: tasks now sitting in Code Review get re-classified from
    // their PR diff, confirming or superseding the provisional tier. Driven off the
    // board scan we already have (no extra board read). Isolated so a failure here
    // never fails the poll.
    if (this.deps.authoritative) {
      const inCodeReview = tasks.filter((t) => !t.completed && isInCodeReview(t));
      try {
        result.authoritative = await this.deps.authoritative.reviewCodeReviewTasks(inCodeReview);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'delivery_tier_authoritative_pass_failed',
        );
      }
    }

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
      const known = botKnownGids(record);
      const targetGid = tierToOptionGid(record.tier);

      // A field holding a tier the bot never wrote → a human changed it. Sacred.
      if (currentGid !== null && !known.has(currentGid)) {
        await this.deps.repo.markOverride(task.gid, optionGidToTier(currentGid));
        logger.info({ taskGid: task.gid, botTier: record.tier, humanTier: optionGidToTier(currentGid) }, 'delivery_tier_human_override');
        return 'overrides';
      }

      if (currentGid === targetGid) {
        // Field matches the bot's latest decision. Finalize the confirmed tier if a
        // previous field write landed but its follow-up persist didn't (crash), OR
        // backfill the rubric comment if the field write landed but `createStory`
        // failed (the v1 residual: a tier with no explanation).
        if (record.confirmedTier !== record.tier || !record.commentGid) {
          await this.finalizeConfirmed(record);
        }
        // Re-classify only if the description changed materially (hash differs).
        const hash = tierInputHash(this.deps.promptVersion, this.toInput(task));
        if (hash === record.inputHash) return 'skipped';
        return this.classify(task, record);
      }

      // A human deliberately CLEARED a tier the bot had already confirmed. An empty
      // field whose record shows `confirmedTier === tier` can only be a human clear:
      // a crashed write always leaves `confirmedTier` BELOW `tier` (or null), never
      // equal. Human override is sacred — record it and never touch the task again.
      if (currentGid === null && record.confirmedTier === record.tier) {
        await this.deps.repo.markOverride(task.gid, null);
        logger.info({ taskGid: task.gid, botTier: record.tier }, 'delivery_tier_human_cleared');
        return 'overrides';
      }

      // The field is empty or still holds the previously CONFIRMED tier: the bot's
      // write of `record.tier` was lost mid-flight (crash between the field write
      // and its persist, or between the pre-write record and the field write).
      // Re-apply it — no LLM, the facts are unchanged.
      await this.repair(task, record);
      return 'reclassified';
    }

    // No bot record. If the field is already set, a human set it before the bot
    // ever saw the task — leave it alone (the bot has no opinion to compare).
    if (currentGid !== null) return 'skipped';

    // Empty field, never classified → classify it.
    return this.classify(task, null);
  }

  private toInput(task: AsanaTask) {
    return { name: task.name ?? '', notes: task.notes ?? '', typeName: typeName(task) };
  }

  /**
   * Extract → decide → persist a pre-write record → write field + comment →
   * finalize. The record is written BEFORE the field so a crash between the two can
   * never orphan the task (the next tick sees a bot record, not an unexplained
   * human-set field). The field is re-read immediately before the write so a human
   * who set the tier during the scan→write window is respected, not overwritten.
   */
  private async classify(
    task: AsanaTask,
    prev: TierClassificationRecord | null,
  ): Promise<'classified' | 'reclassified' | 'overrides'> {
    const input = this.toInput(task);
    const hash = tierInputHash(this.deps.promptVersion, input);
    const facts = await extractFacts(input, this.deps.extract);
    const decision = decideTier(facts);
    const prevConfirmed = prev?.confirmedTier ?? null;
    const floorTier = prev?.diffFloorTier ?? null;
    const outcome = prev ? 'reclassified' : 'classified';

    // Never lower below a diff-derived floor. A prior PR re-check raised this ticket
    // from the authoritative diff; a text-only re-classification (notes edit) must
    // not undo that. When the fresh text tier is below the floor, keep the raised
    // record intact and only refresh the input hash so we stop re-running until the
    // notes change again — no field write, no comment, no LLM-driven lowering.
    if (prev && floorTier && TIER_RANK[decision.tier] < TIER_RANK[floorTier]) {
      await this.deps.repo.upsertBot({
        taskGid: task.gid,
        inputHash: hash,
        promptVersion: prev.promptVersion,
        facts: prev.facts,
        tier: prev.tier,
        confirmedTier: prev.confirmedTier,
        diffFloorTier: floorTier,
        liftedByUnclear: prev.liftedByUnclear,
        calibrationMismatch: prev.calibrationMismatch,
        stage: prev.stage,
        flags: prev.flags,
        domain: prev.domain,
        commentGid: prev.commentGid,
      });
      logger.info(
        { taskGid: task.gid, decided: decision.tier, floor: floorTier },
        'delivery_tier_diff_floor_held',
      );
      return outcome;
    }

    // Phase 1 — record the decision before touching the field. `confirmedTier`
    // stays at the previously confirmed tier so a crash here is recoverable. This
    // is the PROVISIONAL pass — the Code-Review pass confirms it from the diff later.
    await this.deps.repo.upsertBot({
      taskGid: task.gid,
      inputHash: hash,
      promptVersion: this.deps.promptVersion,
      facts,
      tier: decision.tier,
      confirmedTier: prevConfirmed,
      diffFloorTier: floorTier,
      liftedByUnclear: decision.liftedByUnclear,
      calibrationMismatch: decision.calibrationMismatch,
      stage: 'provisional',
      flags: decision.flags,
      domain: facts.domain,
      commentGid: prev?.commentGid ?? null,
    });

    // Phase 2 — close the scan→write TOCTOU window: re-read the field fresh. If a
    // human set a tier we never wrote while we were classifying, respect it.
    const allowed = tierGidSet(decision.tier, prevConfirmed);
    if (await this.humanBeatUsToIt(task.gid, allowed)) return 'overrides';

    // Phase 3 — write the field (commit), post the comment, then finalize the
    // confirmed tier.
    await this.deps.client.setEnumCustomField(
      task.gid,
      DELIVERY_TIER_FIELD_GID,
      tierToOptionGid(decision.tier),
    );
    const commentText = renderTierComment(decision, facts, this.deps.promptVersion, { provisional: true });
    const story = await this.deps.client.createStory(task.gid, commentText);
    await this.deps.repo.upsertBot({
      taskGid: task.gid,
      inputHash: hash,
      promptVersion: this.deps.promptVersion,
      facts,
      tier: decision.tier,
      confirmedTier: decision.tier,
      diffFloorTier: floorTier,
      liftedByUnclear: decision.liftedByUnclear,
      calibrationMismatch: decision.calibrationMismatch,
      stage: 'provisional',
      flags: decision.flags,
      domain: facts.domain,
      commentGid: story?.gid ?? null,
    });
    logger.info({ taskGid: task.gid, tier: decision.tier, firedRule: decision.firedRule }, 'delivery_tier_classified');
    return outcome;
  }

  /** Re-apply the bot's already-decided tier to a field that lost the write, with
   *  no LLM call (the facts are unchanged). Guards the same TOCTOU window. */
  private async repair(task: AsanaTask, record: TierClassificationRecord): Promise<void> {
    const allowed = tierGidSet(record.tier, record.confirmedTier);
    if (await this.humanBeatUsToIt(task.gid, allowed)) return;

    await this.deps.client.setEnumCustomField(
      task.gid,
      DELIVERY_TIER_FIELD_GID,
      tierToOptionGid(record.tier),
    );
    let commentGid = record.commentGid;
    if (!commentGid) {
      const decision = decideTier(record.facts);
      const story = await this.deps.client.createStory(
        task.gid,
        renderTierComment(decision, record.facts, this.deps.promptVersion),
      );
      commentGid = story?.gid ?? null;
    }
    await this.deps.repo.upsertBot({
      taskGid: task.gid,
      inputHash: record.inputHash,
      promptVersion: record.promptVersion,
      facts: record.facts,
      tier: record.tier,
      confirmedTier: record.tier,
      diffFloorTier: record.diffFloorTier,
      liftedByUnclear: record.liftedByUnclear,
      calibrationMismatch: record.calibrationMismatch,
      stage: record.stage,
      flags: record.flags,
      domain: record.domain,
      commentGid,
    });
    logger.info({ taskGid: task.gid, tier: record.tier }, 'delivery_tier_repaired');
  }

  /** Persist `confirmedTier = tier` for a record whose field write landed but whose
   *  follow-up persist did not (crash between the field write and the persist).
   *  Also BACKFILLS the rubric comment when the field write landed but the
   *  `createStory` call failed (the v1 residual): a confirmed tier with no
   *  `commentGid` means the ticket carries a tier but no explanation, so post it. */
  private async finalizeConfirmed(record: TierClassificationRecord): Promise<void> {
    let commentGid = record.commentGid;
    if (!commentGid) {
      const decision = decideTier(record.facts);
      const story = await this.deps.client.createStory(
        record.taskGid,
        renderTierComment(decision, record.facts, record.promptVersion, {
          provisional: record.stage === 'provisional',
        }),
      );
      commentGid = story?.gid ?? null;
    }
    await this.deps.repo.upsertBot({
      taskGid: record.taskGid,
      inputHash: record.inputHash,
      promptVersion: record.promptVersion,
      facts: record.facts,
      tier: record.tier,
      confirmedTier: record.tier,
      diffFloorTier: record.diffFloorTier,
      liftedByUnclear: record.liftedByUnclear,
      calibrationMismatch: record.calibrationMismatch,
      stage: record.stage,
      flags: record.flags,
      domain: record.domain,
      commentGid,
    });
  }

  /** Re-read the field fresh and, if it now holds a tier the bot never wrote (a
   *  human set it in the scan→write window), mark the override and return true. */
  private async humanBeatUsToIt(taskGid: string, allowed: Set<string>): Promise<boolean> {
    const fresh = await this.deps.client.getTask(taskGid, OPT_FIELDS_TASK);
    const freshGid = currentTierOptionGid(fresh);
    if (freshGid === null || allowed.has(freshGid)) return false;
    await this.deps.repo.markOverride(taskGid, optionGidToTier(freshGid));
    logger.info({ taskGid, humanTier: optionGidToTier(freshGid) }, 'delivery_tier_human_override');
    return true;
  }
}

/** The option gids the bot may legitimately have written to a field: its latest
 *  decision plus, if different, the tier it last confirmed. Anything else on the
 *  field is a human's doing. */
function botKnownGids(record: TierClassificationRecord): Set<string> {
  return tierGidSet(record.tier, record.confirmedTier);
}

function tierGidSet(tier: DeliveryTier, confirmed: DeliveryTier | null): Set<string> {
  const s = new Set<string>([tierToOptionGid(tier)]);
  if (confirmed) s.add(tierToOptionGid(confirmed));
  return s;
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
