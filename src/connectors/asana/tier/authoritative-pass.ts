import type { AsanaApiClient, AsanaStory, AsanaTask } from '../client.js';
import type { GithubDispatcher } from '../../../devops/github.js';
import type {
  TierClassificationsRepo,
  TierClassificationRecord,
} from '../../../storage/repositories/tier-classifications.js';
import type { TierPrChecksRepo, TierPrCheckVerdict } from '../../../storage/repositories/tier-pr-checks.js';
import {
  DELIVERY_TIER_FIELD_GID,
  TYPE_FIELD_GID,
  optionGidToTier,
  tierToOptionGid,
  type DeliveryTier,
} from '../board-config.js';
import { extractFacts, extractFactsFromDiff, tierInputHash, type ExtractDeps } from './extract.js';
import { decideTier } from './decide.js';
import { renderAuthoritativeComment } from './comment.js';
import { MIN_NOTES_CHARS } from './poller.js';
import { logger } from '../../../logger.js';

/**
 * The Code-Review authoritative pass. The delivery tier is consumed at the
 * Code-Review → QA handoff and the PR diff is the authoritative risk source, so
 * once a ticket enters the board's Code Review section the bot re-classifies it
 * from the real diff (fallback: the now-mature description) and CONFIRMS or
 * SUPERSEDES its own provisional tier — in EITHER direction. Finalizing the bot's
 * own early guess is not "lowering a decision", so a lower authoritative tier is
 * a legitimate supersede; a HUMAN-set field is never touched in any direction.
 *
 * The poller already scans the board and hands this pass the tasks currently in
 * Code Review; this class only has to find each task's PR and drive the classify →
 * confirm/supersede write. It finds the PR the way the team actually records it:
 * the PR link usually lives ON THE TICKET — in the description (notes), a comment
 * (story), or the "Notes for QA" subtask — not necessarily as an `app.asana.com`
 * backlink in the PR body. So it resolves the PR FORWARD from the ticket first
 * (notes → stories → Notes-for-QA subtask), accepting a PR under ANY repo owned by
 * GITHUB_OWNER and diffing it whether it is open OR already merged, and only falls
 * back to scanning the configured repos' open PRs for the task's `app.asana.com`
 * link when the ticket names no PR. Idempotent by `(repo, pr_number, head_sha)`
 * (a new push re-runs) plus the per-task `stage` marker for the no-PR path.
 */

/** Repos a Gantri PR that touches a classified ticket can live in. */
export const AUTH_PASS_REPOS: readonly string[] = ['mantle', 'core', 'porter', 'made', 'gantri-components'];

/** opt_fields needed to re-check a task: its text (diff context), the Type option
 *  name, and the current Delivery Tier value (the comparison baseline). */
const OPT_FIELDS_TASK = [
  'name',
  'notes',
  'custom_fields.gid',
  'custom_fields.name',
  'custom_fields.enum_value.gid',
  'custom_fields.enum_value.name',
].join(',');

export interface AuthoritativeResult {
  /** Tasks handed in that were in Code Review. */
  considered: number;
  /** Authoritative pass ran and the provisional tier held. */
  confirmed: number;
  /** Authoritative pass moved the tier (either direction). */
  superseded: number;
  /** Field is human-owned — never touched. */
  humanOwned: number;
  /** Already evaluated at this head sha / already authoritative and unchanged. */
  skipped: number;
  failed: number;
}

type Outcome = 'confirmed' | 'superseded' | 'humanOwned' | 'skipped';

interface OpenPr {
  number: number;
  title: string;
  url: string;
  head: string;
  sha: string;
  body: string;
}

interface LinkedPr {
  repo: string;
  pr: OpenPr;
}

export interface AuthoritativePassDeps {
  gh: GithubDispatcher;
  client: AsanaApiClient;
  classifications: TierClassificationsRepo;
  prChecks: TierPrChecksRepo;
  extract: ExtractDeps;
  promptVersion: number;
  /** Override the repo list (tests). Defaults to `AUTH_PASS_REPOS`. */
  repos?: readonly string[];
}

/**
 * Extract the linked Asana task gid from a PR body. Every Gantri PR carries an
 * `app.asana.com` link by policy. Asana task URLs put the task gid as the last
 * long numeric path segment. Returns the first link's task gid.
 */
export function extractAsanaTaskGid(body: string | null | undefined): string | null {
  if (!body) return null;
  const urlRe = /https?:\/\/app\.asana\.com\/[^\s)>\]"']+/gi;
  const match = urlRe.exec(body);
  if (!match) return null;
  const nums = match[0].match(/\d{6,}/g);
  return nums && nums.length > 0 ? nums[nums.length - 1] : null;
}

/** A GitHub PR named by a ticket: which `repo` under GITHUB_OWNER, which PR
 *  `number`. Repo can be ANY repo under the owner, not just the sweep list. */
export interface ParsedPrLink {
  repo: string;
  number: number;
}

/**
 * Every `github.com/<owner>/<repo>/pull/<N>` link in `text` whose `<owner>`
 * matches `owner`, in source order. Accepts any repo under the owner (a ticket can
 * link a PR in any Gantri repo); links to other owners are ignored. Callers take
 * the LAST element when they want the most-recent link in a single block of text.
 */
export function extractPrLinks(text: string | null | undefined, owner: string): ParsedPrLink[] {
  if (!text) return [];
  const re = /https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/gi;
  const out: ParsedPrLink[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1].toLowerCase() !== owner.toLowerCase()) continue;
    out.push({ repo: m[2], number: Number(m[3]) });
  }
  return out;
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

export class AuthoritativePass {
  private readonly repos: readonly string[];

  constructor(private readonly deps: AuthoritativePassDeps) {
    this.repos = deps.repos ?? AUTH_PASS_REPOS;
  }

  /** Confirm/supersede the tier for every task currently in Code Review. Resolves
   *  each task's PR FORWARD from the ticket itself (notes → comments → Notes-for-QA
   *  subtask), falling back to the open-PR body scan only when the ticket names no
   *  PR. Processes each task independently so one failure never blocks the batch. */
  async reviewCodeReviewTasks(tasks: AsanaTask[]): Promise<AuthoritativeResult> {
    const result: AuthoritativeResult = {
      considered: tasks.length,
      confirmed: 0,
      superseded: 0,
      humanOwned: 0,
      skipped: 0,
      failed: 0,
    };
    if (tasks.length === 0) return result;

    // The fallback open-PR scan is expensive (one list call per configured repo),
    // so it is built lazily and reused — only when a task's PR can't be resolved
    // from the ticket directly.
    let scanIndex: Map<string, LinkedPr> | null = null;

    for (const task of tasks) {
      try {
        let link = await this.resolvePrFromTicket(task);
        if (!link) {
          if (scanIndex === null) scanIndex = await this.buildPrIndex();
          link = scanIndex.get(task.gid) ?? null;
        }
        const outcome = await this.reviewOne(task, link);
        result[outcome] += 1;
      } catch (err) {
        result.failed += 1;
        logger.warn(
          { taskGid: task.gid, err: err instanceof Error ? err.message : String(err) },
          'delivery_tier_authoritative_failed',
        );
      }
    }

    logger.info(result, 'delivery_tier_authoritative_done');
    return result;
  }

  /**
   * Resolve a task's PR from the TICKET ITSELF, in priority order, stopping at the
   * first source that names a PR under GITHUB_OWNER:
   *   1. the description (notes),
   *   2. the comments (stories), most-recently-added link winning,
   *   3. the "Notes for QA" subtask's notes.
   * The linked PR is fetched directly (open OR merged) so it can be diffed even
   * when the open-PR scan would never surface it. Returns null when the ticket
   * names no resolvable PR, so the caller falls back to the open-PR body scan.
   */
  private async resolvePrFromTicket(task: AsanaTask): Promise<LinkedPr | null> {
    const owner = this.deps.gh.owner;

    // 1. The description. When several links appear, the last one wins.
    const inNotes = extractPrLinks(task.notes, owner);
    if (inNotes.length > 0) return this.fetchLinkedPr(inNotes[inNotes.length - 1]);

    // 2. The comments, newest-first (Asana returns stories oldest-first).
    const inStory = await this.prLinkFromStories(task.gid, owner);
    if (inStory) return this.fetchLinkedPr(inStory);

    // 3. The "Notes for QA" subtask.
    const inQa = await this.prLinkFromNotesForQa(task.gid, owner);
    if (inQa) return this.fetchLinkedPr(inQa);

    return null;
  }

  /** The most recently added PR link across a task's comments, or null. Asana
   *  returns stories oldest-first, so the newest comment is scanned first. */
  private async prLinkFromStories(taskGid: string, owner: string): Promise<ParsedPrLink | null> {
    let stories: AsanaStory[];
    try {
      stories = await this.deps.client.getTaskStories(taskGid, 'text,created_at,resource_subtype');
    } catch (err) {
      logger.warn(
        { taskGid, err: err instanceof Error ? err.message : String(err) },
        'delivery_tier_authoritative_stories_failed',
      );
      return null;
    }
    for (let i = stories.length - 1; i >= 0; i--) {
      const links = extractPrLinks(stories[i].text, owner);
      if (links.length > 0) return links[links.length - 1];
    }
    return null;
  }

  /** The PR link in the "Notes for QA" subtask's description, or null. */
  private async prLinkFromNotesForQa(taskGid: string, owner: string): Promise<ParsedPrLink | null> {
    let subtasks: AsanaTask[];
    try {
      subtasks = await this.deps.client.getTaskSubtasks(taskGid, 'name,notes');
    } catch (err) {
      logger.warn(
        { taskGid, err: err instanceof Error ? err.message : String(err) },
        'delivery_tier_authoritative_subtasks_failed',
      );
      return null;
    }
    const qa = subtasks.find((s) => (s.name ?? '').toLowerCase().includes('notes for qa'));
    if (!qa) return null;
    const links = extractPrLinks(qa.notes, owner);
    return links.length > 0 ? links[links.length - 1] : null;
  }

  /** Fetch a directly-linked PR (open OR merged) as a `LinkedPr`, or null when it
   *  no longer exists (a stale link → the caller falls back to the open-PR scan). */
  private async fetchLinkedPr(link: ParsedPrLink): Promise<LinkedPr | null> {
    const pr = await this.deps.gh.getPr(link.repo, link.number);
    return pr ? { repo: link.repo, pr } : null;
  }

  /** Map each linked Asana task gid to its open PR, scanning the configured repos
   *  once. The first PR seen for a gid wins (most-recently-updated, since
   *  `listOpenPRs` sorts by update time). */
  private async buildPrIndex(): Promise<Map<string, LinkedPr>> {
    const index = new Map<string, LinkedPr>();
    for (const repo of this.repos) {
      let prs: OpenPr[];
      try {
        prs = await this.deps.gh.listOpenPRs(repo);
      } catch (err) {
        logger.warn(
          { repo, err: err instanceof Error ? err.message : String(err) },
          'delivery_tier_authoritative_list_failed',
        );
        continue;
      }
      for (const pr of prs) {
        const gid = extractAsanaTaskGid(pr.body);
        if (gid && !index.has(gid)) index.set(gid, { repo, pr });
      }
    }
    return index;
  }

  private async reviewOne(task: AsanaTask, link: LinkedPr | null): Promise<Outcome> {
    const record = await this.deps.classifications.get(task.gid);

    // A human owns the field → never touched, in any direction.
    if (record?.decidedBy === 'human_override') {
      await this.record(link, task.gid, 'human_owned', null, false);
      return 'humanOwned';
    }

    const input = { name: task.name ?? '', notes: task.notes ?? '', typeName: typeName(task) };
    const textHash = tierInputHash(this.deps.promptVersion, input);

    // Dedupe. With a PR: this exact commit was already reviewed. Without a PR: the
    // task is already authoritative and its description has not changed since.
    if (link) {
      if (await this.deps.prChecks.exists(link.repo, link.pr.number, link.pr.sha)) return 'skipped';
    } else if (record?.stage === 'authoritative' && record.inputHash === textHash) {
      return 'skipped';
    }

    // No PR to diff → the description is the only source. The rollout cutoff was
    // removed for this lane so the whole in-flight backlog reaches Code Review, but
    // the thin-description bar still applies to THIS fallback: a ticket with no
    // findable PR and only a stub description is noise, not a classification. A
    // ticket WITH a PR is diffed above regardless of description length.
    if (!link && input.notes.trim().length < MIN_NOTES_CHARS) return 'skipped';

    // Classify: diff-first (authoritative), else the now-mature description.
    const facts = link
      ? await extractFactsFromDiff(
          {
            ...input,
            ...(await this.deps.gh.prDiff(link.repo, link.pr.number)),
          },
          this.deps.extract,
        )
      : await extractFacts(input, this.deps.extract);
    const decision = decideTier(facts);
    const authTier = decision.tier;

    // Re-read the field fresh (close the read → LLM → write TOCTOU) and decide
    // ownership against it: a human may have SET or CLEARED the field during the
    // extraction.
    const fresh = await this.deps.client.getTask(task.gid, OPT_FIELDS_TASK);
    const freshGid = currentTierOptionGid(fresh);
    const currentTier = optionGidToTier(freshGid);

    // Ownership, mirroring the poller. A non-empty field holding a tier the bot
    // never wrote is a human override. An EMPTY field whose record shows
    // `confirmedTier === tier` can only be a human CLEAR — a crashed write always
    // leaves `confirmedTier` below `tier` (or null), never equal — so it is sacred:
    // record the override and never overwrite it.
    const humanCleared = freshGid === null && record != null && record.confirmedTier === record.tier;
    const botOwns =
      !humanCleared && (freshGid === null || (record ? botKnownGids(record).has(freshGid) : false));
    if (!botOwns) {
      if (humanCleared) {
        await this.deps.classifications.markOverride(task.gid, null);
        logger.info({ taskGid: task.gid, botTier: record?.tier }, 'delivery_tier_authoritative_human_cleared');
      }
      await this.record(link, task.gid, 'human_owned', authTier, false);
      return 'humanOwned';
    }

    // `changed` is driven by the ACTUAL field value: an empty field (currentTier
    // null) always needs the write, so the tier the bot computed is never silently
    // dropped with a false "holds" comment. `fromTier` is the prior tier shown on
    // the field, or the provisional guess when the field is empty, or null on a
    // first-ever write.
    const fromTier: DeliveryTier | null = currentTier ?? record?.confirmedTier ?? record?.tier ?? null;
    const changed = authTier !== currentTier;
    const comment = renderAuthoritativeComment({
      fromTier,
      toTier: authTier,
      source: link ? 'diff' : 'description',
      prNumber: link?.pr.number,
      decision,
      facts,
      promptVersion: this.deps.promptVersion,
    });

    // Crash-safe two-phase write, mirroring the poller: persist the decision with
    // the PREVIOUS confirmed tier first, then COMMENT, then write the field, then
    // finalize. The comment lands before the field write so the Asana activity trail
    // reads bot-explanation → field change (a papertrail). A crash in between never
    // manufactures a phantom human override.
    const base = {
      taskGid: task.gid,
      inputHash: textHash,
      promptVersion: this.deps.promptVersion,
      facts,
      tier: authTier,
      liftedByUnclear: decision.liftedByUnclear,
      calibrationMismatch: decision.calibrationMismatch,
      stage: 'authoritative' as const,
      flags: decision.flags,
      domain: facts.domain,
    };
    await this.deps.classifications.upsertBot({
      ...base,
      confirmedTier: record?.confirmedTier ?? record?.tier ?? null,
      commentGid: record?.commentGid ?? null,
    });
    const story = await this.deps.client.createStory(task.gid, comment);
    if (changed) {
      await this.deps.client.setEnumCustomField(task.gid, DELIVERY_TIER_FIELD_GID, tierToOptionGid(authTier));
    }
    await this.deps.classifications.upsertBot({
      ...base,
      confirmedTier: authTier,
      commentGid: story?.gid ?? record?.commentGid ?? null,
    });

    await this.record(link, task.gid, changed ? 'superseded' : 'confirmed', authTier, true);
    logger.info(
      { taskGid: task.gid, from: fromTier, to: authTier, source: link ? 'diff' : 'description' },
      changed ? 'delivery_tier_authoritative_superseded' : 'delivery_tier_authoritative_confirmed',
    );
    return changed ? 'superseded' : 'confirmed';
  }

  /** Record the dedupe ledger row when a PR drove the pass (no PR → the per-task
   *  `stage` marker is the dedupe key, so nothing to write here). */
  private async record(
    link: LinkedPr | null,
    taskGid: string,
    verdict: TierPrCheckVerdict,
    suggestedTier: string | null,
    commented: boolean,
  ): Promise<void> {
    if (!link) return;
    await this.deps.prChecks.insert({
      repo: link.repo,
      prNumber: link.pr.number,
      headSha: link.pr.sha,
      taskGid,
      verdict,
      suggestedTier,
      commented,
    });
  }
}
