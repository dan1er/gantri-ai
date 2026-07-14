import type { AsanaApiClient, AsanaTask } from '../client.js';
import type { GithubDispatcher } from '../../../devops/github.js';
import type {
  TierClassificationsRepo,
  TierClassificationRecord,
} from '../../../storage/repositories/tier-classifications.js';
import type { TierPrChecksRepo, TierPrCheckVerdict } from '../../../storage/repositories/tier-pr-checks.js';
import {
  DELIVERY_TIER_FIELD_GID,
  TYPE_FIELD_GID,
  isHigherTier,
  optionGidToTier,
  tierToOptionGid,
  type DeliveryTier,
} from '../board-config.js';
import { extractFactsFromDiff, tierInputHash, type ExtractDeps } from './extract.js';
import { decideTier } from './decide.js';
import { renderTierRaiseComment } from './comment.js';
import { logger } from '../../../logger.js';

/**
 * v2 — PR re-check (raise-only). Every 10 minutes it scans open PRs across the
 * configured repos and, for any PR whose linked Asana ticket was already
 * classified, re-runs the rubric against the REAL diff (the authoritative source
 * per the framework). If the diff-derived tier is strictly higher than the tier
 * currently on the ticket, it raises it:
 *
 * - bot-set field → update the field + post a comment, and sync the stored record
 *   so the poller does not misread the raise as a human override.
 * - human-set field → comment only; the field is never touched (lowering, and
 *   overriding a human, are never solo calls).
 * - diff tier ≤ current → record `consistent` and stay silent (no noise).
 *
 * Idempotent by `(repo, pr_number, head_sha)`: a given commit of a PR is checked
 * once; a new push (new head sha) gets a fresh check.
 */

/** Repos every Gantri PR that touches a classified ticket can live in. */
export const PR_RECHECK_REPOS: readonly string[] = ['mantle', 'core', 'porter', 'made', 'gantri-components'];

/** opt_fields needed to re-check a task: its text (for diff context), the Type
 *  option name, and the current Delivery Tier value (the comparison baseline). */
const OPT_FIELDS_TASK = [
  'name',
  'notes',
  'custom_fields.gid',
  'custom_fields.name',
  'custom_fields.enum_value.gid',
  'custom_fields.enum_value.name',
].join(',');

export interface PrRecheckResult {
  scanned: number;
  raised: number;
  consistent: number;
  noTicket: number;
  notClassified: number;
  /** Already seen at this head sha. */
  skipped: number;
  failed: number;
}

type PrOutcome = 'raised' | 'consistent' | 'noTicket' | 'notClassified' | 'skipped';

interface OpenPr {
  number: number;
  title: string;
  url: string;
  head: string;
  sha: string;
  body: string;
}

export interface PrRecheckDeps {
  gh: GithubDispatcher;
  client: AsanaApiClient;
  classifications: TierClassificationsRepo;
  prChecks: TierPrChecksRepo;
  extract: ExtractDeps;
  promptVersion: number;
  /** Override the repo list (tests). Defaults to `PR_RECHECK_REPOS`. */
  repos?: readonly string[];
}

/**
 * Extract the linked Asana task gid from a PR body. Every Gantri PR carries an
 * `app.asana.com` link by policy. Asana task URLs put the task gid as the last
 * long numeric path segment (e.g. `.../0/<project>/<taskGid>` or
 * `.../1/<ws>/project/<p>/task/<taskGid>`). Returns the first link's task gid.
 */
export function extractAsanaTaskGid(body: string | null | undefined): string | null {
  if (!body) return null;
  const urlRe = /https?:\/\/app\.asana\.com\/[^\s)>\]"']+/gi;
  const match = urlRe.exec(body);
  if (!match) return null;
  const nums = match[0].match(/\d{6,}/g);
  return nums && nums.length > 0 ? nums[nums.length - 1] : null;
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

/** The option gids the bot may legitimately have written (its latest decision plus
 *  the tier it last confirmed). Anything else on the field is a human's doing. */
function botKnownGids(record: TierClassificationRecord): Set<string> {
  const s = new Set<string>([tierToOptionGid(record.tier)]);
  if (record.confirmedTier) s.add(tierToOptionGid(record.confirmedTier));
  return s;
}

export class PrRecheck {
  private readonly repos: readonly string[];

  constructor(private readonly deps: PrRecheckDeps) {
    this.repos = deps.repos ?? PR_RECHECK_REPOS;
  }

  /** One full pass over every configured repo's open PRs. Each PR is processed
   *  independently so one failure never blocks the batch. */
  async runOnce(): Promise<PrRecheckResult> {
    const result: PrRecheckResult = {
      scanned: 0,
      raised: 0,
      consistent: 0,
      noTicket: 0,
      notClassified: 0,
      skipped: 0,
      failed: 0,
    };

    for (const repo of this.repos) {
      let prs: OpenPr[];
      try {
        prs = await this.deps.gh.listOpenPRs(repo);
      } catch (err) {
        logger.warn(
          { repo, err: err instanceof Error ? err.message : String(err) },
          'delivery_tier_pr_recheck_list_failed',
        );
        continue;
      }
      for (const pr of prs) {
        result.scanned += 1;
        try {
          const outcome = await this.processPr(repo, pr);
          result[outcome] += 1;
        } catch (err) {
          result.failed += 1;
          logger.warn(
            { repo, pr: pr.number, err: err instanceof Error ? err.message : String(err) },
            'delivery_tier_pr_recheck_failed',
          );
        }
      }
    }

    logger.info(result, 'delivery_tier_pr_recheck_done');
    return result;
  }

  private async processPr(repo: string, pr: OpenPr): Promise<PrOutcome> {
    // Dedupe: this exact commit of this PR was already evaluated.
    if (await this.deps.prChecks.exists(repo, pr.number, pr.sha)) return 'skipped';

    const taskGid = extractAsanaTaskGid(pr.body);
    if (!taskGid) {
      await this.record(repo, pr, null, 'no_ticket', null, false);
      return 'noTicket';
    }

    const record = await this.deps.classifications.get(taskGid);
    if (!record) {
      await this.record(repo, pr, taskGid, 'not_classified', null, false);
      return 'notClassified';
    }

    // Re-read the task to get its current field value (the comparison baseline)
    // and its text (context for the diff extraction).
    const task = await this.deps.client.getTask(taskGid, OPT_FIELDS_TASK);
    const currentGid = currentTierOptionGid(task);
    const currentTier: DeliveryTier =
      optionGidToTier(currentGid) ?? record.confirmedTier ?? record.tier;

    const { diff, truncated } = await this.deps.gh.prDiff(repo, pr.number);
    const facts = await extractFactsFromDiff(
      { name: task.name ?? '', notes: task.notes ?? '', typeName: typeName(task), diff, truncated },
      this.deps.extract,
    );
    const decision = decideTier(facts);
    const diffTier = decision.tier;

    // Raise-only: a lower or equal diff tier (vs the baseline read) is silent.
    if (!isHigherTier(diffTier, currentTier)) {
      await this.record(repo, pr, taskGid, 'consistent', diffTier, false);
      return 'consistent';
    }

    // Close the read → LLM → write TOCTOU: the baseline read above was taken before
    // the multi-second diff extraction, so a human may have set the field meanwhile.
    // Re-read fresh and recompute both ownership and the raise decision against it —
    // never overwrite (or lower) a human decision made in that window.
    const fresh = await this.deps.client.getTask(taskGid, OPT_FIELDS_TASK);
    const freshGid = currentTierOptionGid(fresh);
    const freshTier: DeliveryTier = optionGidToTier(freshGid) ?? record.confirmedTier ?? record.tier;
    const botOwns =
      record.decidedBy === 'bot' && (freshGid === null || botKnownGids(record).has(freshGid));

    if (!isHigherTier(diffTier, freshTier)) {
      // A human (or a prior tick) already raised the field to or above the diff tier.
      await this.record(repo, pr, taskGid, 'consistent', diffTier, false);
      return 'consistent';
    }

    const comment = renderTierRaiseComment({
      prNumber: pr.number,
      fromTier: freshTier,
      toTier: diffTier,
      decision,
      facts,
      promptVersion: this.deps.promptVersion,
    });

    if (botOwns) {
      // Keep the ticket-TEXT hash so a follow-up poll (with unchanged notes) does
      // not re-run and revert the raise; the facts are the diff facts that justify it.
      const textHash = tierInputHash(this.deps.promptVersion, {
        name: task.name ?? '',
        notes: task.notes ?? '',
        typeName: typeName(task),
      });
      // Phase 1 — persist the raise BEFORE writing the field (crash-safe, mirroring
      // the poller): confirmedTier stays at the previously confirmed tier so a crash
      // between the field write and the finalize cannot manufacture a false override.
      // diffFloorTier records the diff-authoritative floor a later text
      // re-classification must not lower.
      await this.deps.classifications.upsertBot({
        taskGid,
        inputHash: textHash,
        promptVersion: this.deps.promptVersion,
        facts,
        tier: diffTier,
        confirmedTier: record.confirmedTier ?? record.tier,
        diffFloorTier: diffTier,
        liftedByUnclear: decision.liftedByUnclear,
        flags: decision.flags,
        domain: facts.domain,
        commentGid: record.commentGid,
      });
      // Phase 2 — write the field, comment, then finalize the confirmed tier so the
      // next poll sees `field === record.tier` and does not flag a false override.
      await this.deps.client.setEnumCustomField(taskGid, DELIVERY_TIER_FIELD_GID, tierToOptionGid(diffTier));
      const story = await this.deps.client.createStory(taskGid, comment);
      await this.deps.classifications.upsertBot({
        taskGid,
        inputHash: textHash,
        promptVersion: this.deps.promptVersion,
        facts,
        tier: diffTier,
        confirmedTier: diffTier,
        diffFloorTier: diffTier,
        liftedByUnclear: decision.liftedByUnclear,
        flags: decision.flags,
        domain: facts.domain,
        commentGid: story?.gid ?? record.commentGid,
      });
      logger.info({ repo, pr: pr.number, taskGid, from: freshTier, to: diffTier }, 'delivery_tier_pr_raise_bot');
    } else {
      // Human owns the field: comment only, never touch the field or the record.
      await this.deps.client.createStory(taskGid, comment);
      logger.info({ repo, pr: pr.number, taskGid, from: freshTier, to: diffTier }, 'delivery_tier_pr_raise_human');
    }

    await this.record(repo, pr, taskGid, 'raise', diffTier, true);
    return 'raised';
  }

  private async record(
    repo: string,
    pr: OpenPr,
    taskGid: string | null,
    verdict: TierPrCheckVerdict,
    suggestedTier: string | null,
    commented: boolean,
  ): Promise<void> {
    await this.deps.prChecks.insert({
      repo,
      prNumber: pr.number,
      headSha: pr.sha,
      taskGid,
      verdict,
      suggestedTier,
      commented,
    });
  }
}

// --- Scheduler --------------------------------------------------------------

const DEFAULT_PR_RECHECK_INTERVAL_MS = 10 * 60 * 1000;

const EMPTY_RESULT: PrRecheckResult = {
  scanned: 0,
  raised: 0,
  consistent: 0,
  noTicket: 0,
  notClassified: 0,
  skipped: 0,
  failed: 0,
};

/** In-process 10-minute scheduler for the PR re-check, mirroring `TierRunner`: a
 *  tick never overlaps itself, and a failure is logged, not thrown, so the loop
 *  keeps running. */
export class PrRecheckRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly recheck: PrRecheck,
    private readonly intervalMs: number = DEFAULT_PR_RECHECK_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, 'delivery tier PR re-check runner started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<PrRecheckResult> {
    if (this.running) return EMPTY_RESULT;
    this.running = true;
    try {
      return await this.recheck.runOnce();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.stack : String(err) },
        'delivery tier PR re-check tick failed',
      );
      return EMPTY_RESULT;
    } finally {
      this.running = false;
    }
  }
}
