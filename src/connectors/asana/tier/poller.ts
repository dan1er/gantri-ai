import type { AsanaApiClient, AsanaTask } from '../client.js';
import type { TierClassificationsRepo, TierClassificationRecord } from '../../../storage/repositories/tier-classifications.js';
import {
  DELIVERY_TIER_FIELD_GID,
  SOFTWARE_BOARD_PROJECT_GID,
  TYPE_FIELD_GID,
  isFeatureTemplateTask,
  isInCodeReview,
  isTierExcludedType,
  optionGidToTier,
  tierToOptionGid,
} from '../board-config.js';
import type { DeliveryTier } from '../board-config.js';
import { extractFacts, tierInputHash, type ExtractDeps } from './extract.js';
import { decideTier, DOMAIN_BASE_TIER } from './decide.js';
import { renderTierComment } from './comment.js';
import type { AuthoritativePass, AuthoritativeResult } from './authoritative-pass.js';
import type { RubricSource, Rubric } from './rubric-source.js';
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

/** Minimum description length to attempt a classification (thin tickets are noise).
 *  Shared with the Code-Review authoritative pass, which enforces it only on the
 *  description-fallback path (a ticket with a findable PR is diffed regardless). */
export const MIN_NOTES_CHARS = 40;

/** How many tasks to classify in parallel. */
const CLASSIFY_CONCURRENCY = 3;

export interface TierPollerDeps {
  client: AsanaApiClient;
  repo: TierClassificationsRepo;
  extract: ExtractDeps;
  /** Prompt version parsed from the rubric file (part of the content hash). Used as
   *  the fallback when no live `rubric` source is wired (e.g. unit tests). */
  promptVersion: number;
  /** The runtime rubric source. When present, each tick refreshes it from the live
   *  Notion page and classifies against the freshly-adopted rubric (prompt text,
   *  version, domain table, and hash). Absent → the committed `extract.prompt` /
   *  `promptVersion` / `DOMAIN_BASE_TIER` are used. */
  rubric?: RubricSource;
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
  /** The rubric resolved once at the start of each tick, then applied to every task
   *  processed in that tick (`runOnce` is not reentrant — the runner serializes it). */
  private activeRubric: Rubric = FALLBACK_RUBRIC;

  constructor(private readonly deps: TierPollerDeps) {}

  /** One full scan + classify pass. Safe to call repeatedly; each task is
   *  processed independently so one failure never blocks the batch. */
  async runOnce(): Promise<TierPollResult> {
    // Refresh the live rubric first (adopts a validated page change + posts the ops
    // notice at most once). Never throws — a Notion outage keeps the last-known-good.
    if (this.deps.rubric) await this.deps.rubric.refresh();
    this.activeRubric = this.deps.rubric ? this.deps.rubric.getRubric() : this.fallbackRubric();

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
      // The tier is consumed at the Code-Review → QA handoff, so the ENTIRE in-flight
      // backlog that reaches Code Review must be classified — including tickets
      // created before ROLLOUT_DATE. That cutoff exists only to avoid a board-wide
      // backfill at launch, not to starve the review lane, so this lane uses a
      // rollout-free gate: excluded Types and feature-template rows are still
      // filtered, but created_at is not. The thin-description gate is enforced
      // downstream by the pass, and only for the description-fallback case (a ticket
      // with a findable PR is classified from its diff regardless of length).
      const inCodeReview = tasks.filter((t) => this.isCodeReviewCandidate(t) && isInCodeReview(t));
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

  /** Eligibility for the Code-Review AUTHORITATIVE lane. Deliberately does NOT apply
   *  the ROLLOUT_DATE cutoff or the thin-description gate that `isCandidate` uses:
   *  the tier is consumed at the Code-Review → QA handoff, so every in-flight ticket
   *  that reaches Code Review must be classifiable regardless of when it was created,
   *  and a ticket with a findable PR is diffed even with a thin description (the
   *  pass enforces the thin-notes bar only on its description-fallback path). The
   *  completed, feature-template, and excluded-Type gates still hold. */
  private isCodeReviewCandidate(task: AsanaTask): boolean {
    if (task.completed) return false;
    if (isFeatureTemplateTask(task)) return false;
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
        const hash = tierInputHash(this.activeRubric.version, this.toInput(task), this.activeRubric.hash);
        if (hash === record.inputHash) return 'skipped';
        // An authoritative row was finalized from the PR diff at Code Review — the
        // diff is the authoritative risk source. A later notes edit must NOT trigger
        // a provisional text re-classification that could silently downgrade it; the
        // tier only moves again when a new head_sha re-runs the authoritative pass.
        if (record.stage === 'authoritative') return 'skipped';
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

  /** The rubric to apply when no live source is wired (unit tests): the committed
   *  prompt / version, `DOMAIN_BASE_TIER`, and an empty hash (so `tierInputHash`
   *  stays identical to a two-arg call). */
  private fallbackRubric(): Rubric {
    return {
      promptText: this.deps.extract.prompt,
      version: this.deps.promptVersion,
      tableMap: DOMAIN_BASE_TIER,
      hash: '',
    };
  }

  /** Extract deps for the current tick — the shared Anthropic client plus the
   *  active rubric's prompt text as the cache-primed system block. */
  private extractDeps(): ExtractDeps {
    return { claude: this.deps.extract.claude, prompt: this.activeRubric.promptText };
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
    const hash = tierInputHash(this.activeRubric.version, input, this.activeRubric.hash);
    const facts = await extractFacts(input, this.extractDeps());
    const decision = decideTier(facts, this.activeRubric.tableMap);
    const prevConfirmed = prev?.confirmedTier ?? null;
    const outcome = prev ? 'reclassified' : 'classified';

    // Silent-update guard: a re-classification of an EXISTING provisional ticket
    // whose decided tier is UNCHANGED (the field already holds it — this branch is
    // only reached when the field matches the bot's last decision) must NOT re-write
    // the field or post a duplicate comment; it only refreshes the stored facts /
    // input hash. Without this, adopting a new rubric — which bumps the rubric hash so
    // every tracked ticket's input hash mismatches — would spam a fresh provisional
    // comment (and a redundant field write) across the whole board on the next tick.
    if (prev && decision.tier === prev.tier && prev.commentGid) {
      await this.deps.repo.upsertBot({
        taskGid: task.gid,
        inputHash: hash,
        promptVersion: this.activeRubric.version,
        facts,
        tier: decision.tier,
        confirmedTier: prevConfirmed ?? decision.tier,
        liftedByUnclear: decision.liftedByUnclear,
        calibrationMismatch: decision.calibrationMismatch,
        stage: 'provisional',
        flags: decision.flags,
        domain: facts.domain,
        commentGid: prev.commentGid,
      });
      logger.info(
        { taskGid: task.gid, tier: decision.tier },
        'delivery_tier_reclassify_unchanged',
      );
      return outcome;
    }

    // Phase 1 — record the decision before touching Asana. `confirmedTier` stays at
    // the previously confirmed tier so a crash here is recoverable. This is the
    // PROVISIONAL pass — the Code-Review pass confirms it from the diff later.
    const provisional = {
      taskGid: task.gid,
      inputHash: hash,
      promptVersion: this.activeRubric.version,
      facts,
      tier: decision.tier,
      confirmedTier: prevConfirmed,
      liftedByUnclear: decision.liftedByUnclear,
      calibrationMismatch: decision.calibrationMismatch,
      stage: 'provisional' as const,
      flags: decision.flags,
      domain: facts.domain,
    };
    await this.deps.repo.upsertBot({ ...provisional, commentGid: prev?.commentGid ?? null });

    // Phase 2 — post the explanatory comment BEFORE the field write, so the Asana
    // activity trail always reads bot-explanation → field change (a papertrail),
    // never the reverse. Persist the comment gid immediately (confirmedTier still
    // unconfirmed) so a crash before the field write cannot orphan a duplicate
    // comment on the recovery path.
    const comment = renderTierComment(decision, facts, this.activeRubric.version, { provisional: true });
    const story = await this.deps.client.createStory(task.gid, comment.text, comment.html);
    await this.deps.repo.upsertBot({ ...provisional, commentGid: story?.gid ?? prev?.commentGid ?? null });

    // Phase 3 — close the scan→write TOCTOU window immediately before the field
    // write: re-read the field fresh. If a human set a tier we never wrote while we
    // were classifying, respect it. The announcement comment above is acceptable
    // residue in that race (it documents what the bot WOULD have set); the human
    // value stands.
    const allowed = tierGidSet(decision.tier, prevConfirmed);
    if (await this.humanBeatUsToIt(task.gid, allowed)) return 'overrides';

    // Phase 4 — write the field (commit), then finalize the confirmed tier.
    await this.deps.client.setEnumCustomField(
      task.gid,
      DELIVERY_TIER_FIELD_GID,
      tierToOptionGid(decision.tier),
    );
    await this.deps.repo.upsertBot({
      ...provisional,
      confirmedTier: decision.tier,
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

    // Backfill the explanation BEFORE re-applying the field so the recovery path
    // keeps the same explanation → field-change ordering as a fresh classify.
    let commentGid = record.commentGid;
    if (!commentGid) {
      const decision = decideTier(record.facts, this.activeRubric.tableMap);
      const comment = renderTierComment(decision, record.facts, this.activeRubric.version);
      const story = await this.deps.client.createStory(task.gid, comment.text, comment.html);
      commentGid = story?.gid ?? null;
    }
    await this.deps.client.setEnumCustomField(
      task.gid,
      DELIVERY_TIER_FIELD_GID,
      tierToOptionGid(record.tier),
    );
    await this.deps.repo.upsertBot({
      taskGid: task.gid,
      inputHash: record.inputHash,
      promptVersion: record.promptVersion,
      facts: record.facts,
      tier: record.tier,
      confirmedTier: record.tier,
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
      const decision = decideTier(record.facts, this.activeRubric.tableMap);
      const comment = renderTierComment(decision, record.facts, record.promptVersion, {
        provisional: record.stage === 'provisional',
      });
      const story = await this.deps.client.createStory(record.taskGid, comment.text, comment.html);
      commentGid = story?.gid ?? null;
    }
    await this.deps.repo.upsertBot({
      taskGid: record.taskGid,
      inputHash: record.inputHash,
      promptVersion: record.promptVersion,
      facts: record.facts,
      tier: record.tier,
      confirmedTier: record.tier,
      liftedByUnclear: record.liftedByUnclear,
      calibrationMismatch: record.calibrationMismatch,
      stage: record.stage,
      flags: record.flags,
      domain: record.domain,
      commentGid,
    });
    // Keep the caller's in-memory record consistent with what we just persisted, so a
    // downstream re-classify in the SAME tick (the silent-update guard in `classify`)
    // reads the freshly-backfilled comment gid / confirmed tier and doesn't re-post.
    record.confirmedTier = record.tier;
    record.commentGid = commentGid;
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

/** Neutral default so `activeRubric` is always defined before the first tick sets
 *  it. Only its shape matters; `runOnce` overwrites it before any task is read. */
const FALLBACK_RUBRIC: Rubric = { promptText: '', version: 0, tableMap: DOMAIN_BASE_TIER, hash: '' };

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
