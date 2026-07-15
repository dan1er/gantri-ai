import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import { DateRangeArg, normalizeDateRange } from '../base/date-range.js';
import { logger } from '../../logger.js';
import { AsanaApiClient } from './client.js';
import {
  BOARD_NAME,
  SOFTWARE_BOARD_PROJECT_GID,
  isFeatureTemplateTask,
  isQaReviewer,
  shortNameFor,
} from './board-config.js';
import {
  analyzeFeature,
  attachSubtaskEvidence,
  isFeatureTask,
  pacificWindowToUtcMs,
} from './story-analyzer.js';
import {
  classifyBouncedFeatures,
  type BouncedFeatureInput,
} from './qa-classifier.js';
import { extractFacts, type ExtractInput } from './tier/extract.js';
import { decideTier, DOMAIN_BASE_TIER } from './tier/decide.js';
import type { RubricSource } from './tier/rubric-source.js';
import { TYPE_FIELD_GID } from './board-config.js';

/**
 * Asana connector — one read-only tool, `asana.feature_qa_stats`. It computes QA
 * quality statistics for Type=Feature tickets on the Software Board over a date
 * range: which features QA found issues on, real functional bugs vs process
 * bounces, and who found them (QA: Matt/Josh vs devs). Built to feed automated
 * Live Reports as well as ad-hoc Slack questions.
 *
 * Data source is Asana task history (section-move + reopen stories). Only
 * features with QA activity inside the window are counted (the denominator).
 * The real-bug vs process split comes from ONE batched Haiku classification.
 */

const OPT_FIELDS_TASK =
  'name,completed,created_at,modified_at,permalink_url,custom_fields.gid,custom_fields.enum_value.gid';
const OPT_FIELDS_STORY = 'created_at,created_by.name,resource_subtype,text';
const OPT_FIELDS_SUBTASK = 'name,created_at,created_by.name';

/** How many task-story / subtask fetches to run in parallel. */
const STORY_FETCH_CONCURRENCY = 5;

export interface AsanaConnectorDeps {
  client: AsanaApiClient;
  /** Shared Anthropic client for the batched QA classifier. */
  claude: Pick<Anthropic, 'messages'>;
  /** The delivery-tier rubric prompt + its parsed version. When provided, the
   *  read-only `asana.delivery_tier_preview` tool is registered (it reuses the
   *  same extract+decide pipeline as the poller, with NO writes). */
  tierPrompt?: string;
  tierPromptVersion?: number;
  /** The runtime rubric source. When provided, the preview tool classifies against
   *  the live Notion rubric (prompt + version + domain table) instead of the
   *  committed `tierPrompt` / `tierPromptVersion` snapshot. */
  rubricSource?: RubricSource;
}

/** opt_fields the preview tool reads to classify one task. */
const OPT_FIELDS_TIER_PREVIEW =
  'name,notes,custom_fields.gid,custom_fields.enum_value.name';

/** Extract the Asana task gid from a URL or bare gid. Asana task URLs put the
 *  gid as a long numeric path segment; we take the last such run. */
export function parseAsanaTaskGid(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{6,}$/.test(trimmed)) return trimmed;
  const matches = trimmed.match(/\d{6,}/g);
  return matches && matches.length > 0 ? matches[matches.length - 1] : null;
}

type Outcome = 'real_bug' | 'process_bounce' | 'clean_pass' | 'unclassified';

const OUTCOME_RANK: Record<Outcome, number> = {
  real_bug: 0,
  process_bounce: 1,
  unclassified: 2,
  clean_pass: 3,
};

export class AsanaConnector implements Connector {
  readonly name = 'asana';
  readonly tools: readonly ToolDef[];
  private readonly client: AsanaApiClient;
  private readonly claude: Pick<Anthropic, 'messages'>;
  private readonly tierPrompt?: string;
  private readonly tierPromptVersion?: number;
  private readonly rubricSource?: RubricSource;

  constructor(deps: AsanaConnectorDeps) {
    this.client = deps.client;
    this.claude = deps.claude;
    this.tierPrompt = deps.tierPrompt;
    this.tierPromptVersion = deps.tierPromptVersion;
    this.rubricSource = deps.rubricSource;
    this.tools = this.buildTools();
  }

  async healthCheck() {
    try {
      const me = await this.client.getCurrentUser();
      return { ok: true, detail: me.name ? `authed as ${me.name}` : 'authed' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private buildTools(): readonly ToolDef[] {
    const Args = z.object({
      dateRange: DateRangeArg,
      includeFeatures: z
        .boolean()
        .optional()
        .describe('Include the per-feature detail array. Default true; pass false for compact report use.'),
    });
    type Args = z.infer<typeof Args>;

    const tool: ToolDef<Args> = {
      name: 'asana.feature_qa_stats',
      description: [
        'QA quality stats for Feature tickets on the engineering "Software Board" over a period:',
        'how many features QA found issues on, real functional bugs vs process bounces, and who found them',
        '(QA reviewers Matt/Josh vs developers).',
        'Use for QA reports, escape-rate style questions, "how many features had bugs found in QA in <period>",',
        '"cuántos features tuvieron issues encontrados por QA", "real bugs vs process noise", "who caught the most bugs".',
        'Data source is Asana task history (section moves + reopens); ONLY features with QA activity in the window are counted (the denominator).',
        'Args: dateRange (required) and includeFeatures (optional, default true — set false to drop the per-feature list).',
        'NOT for marketing / sales / revenue questions.',
      ].join(' '),
      schema: Args as z.ZodType<Args>,
      jsonSchema: zodToJsonSchema(Args),
      execute: (args) => this.runFeatureQaStats(args),
    };

    const tools: ToolDef[] = [tool as ToolDef];
    if (this.tierPrompt && this.tierPromptVersion !== undefined) {
      tools.push(this.buildTierPreviewTool(this.tierPrompt, this.tierPromptVersion));
    }
    return tools;
  }

  /** Read-only "what tier would this get and why" tool. Reuses the exact
   *  extract + decide pipeline the poller uses; it NEVER writes to Asana. */
  private buildTierPreviewTool(prompt: string, promptVersion: number): ToolDef {
    const Args = z.object({
      task: z
        .string()
        .optional()
        .describe('An Asana task URL or gid to classify. The ticket name + description are read from Asana.'),
      text: z
        .string()
        .optional()
        .describe('Free-text description to classify instead of a real task (used when no ticket exists yet).'),
    });
    type Args = z.infer<typeof Args>;

    const tool: ToolDef<Args> = {
      name: 'asana.delivery_tier_preview',
      description: [
        'Preview the Delivery Tier (T0/T1/T2) a Software Board ticket would get under the risk-based rubric,',
        'with the rule that fired, the extracted facts, the flags, and the domain. READ-ONLY — it never writes',
        'the Asana field or posts a comment. Pass EITHER `task` (an Asana task URL or gid) OR `text` (a free-text',
        'description). Use for "what tier would this be", "why did the bot pick T2", "preview the tier for this ticket".',
      ].join(' '),
      schema: Args as z.ZodType<Args>,
      jsonSchema: zodToJsonSchema(Args),
      execute: (args) => this.runTierPreview(args, prompt, promptVersion),
    };
    return tool as ToolDef;
  }

  private async runTierPreview(
    args: { task?: string; text?: string },
    prompt: string,
    promptVersion: number,
  ) {
    let input: ExtractInput;
    let source: { kind: 'task'; gid: string } | { kind: 'text' };
    if (args.task && args.task.trim()) {
      const gid = parseAsanaTaskGid(args.task);
      if (!gid) {
        return { ok: false, error: `could not parse an Asana task gid from "${args.task}"` };
      }
      const task = await this.client.getTask(gid, OPT_FIELDS_TIER_PREVIEW);
      const type = (task.custom_fields ?? []).find((f) => f.gid === TYPE_FIELD_GID);
      input = { name: task.name ?? '', notes: task.notes ?? '', typeName: type?.enum_value?.name ?? '' };
      source = { kind: 'task', gid };
    } else if (args.text && args.text.trim()) {
      input = { name: '', notes: args.text, typeName: '' };
      source = { kind: 'text' };
    } else {
      return { ok: false, error: 'provide either `task` (URL/gid) or `text`' };
    }

    // Prefer the LIVE rubric (matches what the poller applies right now); fall back
    // to the committed snapshot passed at construction.
    const rubric = this.rubricSource?.getRubric();
    const activePrompt = rubric?.promptText ?? prompt;
    const activeVersion = rubric?.version ?? promptVersion;
    const activeTableMap = rubric?.tableMap ?? DOMAIN_BASE_TIER;

    const facts = await extractFacts(input, { claude: this.claude, prompt: activePrompt });
    const decision = decideTier(facts, activeTableMap);
    const evidence =
      decision.evidenceFact && decision.firedRule !== 'inconclusive'
        ? facts[decision.evidenceFact].evidence
        : '';

    return {
      ok: true,
      source,
      rubricVersion: activeVersion,
      tier: decision.tier,
      baseTier: decision.baseTier,
      firedRule: decision.firedRule,
      liftedByUnclear: decision.liftedByUnclear,
      calibrationMismatch: decision.calibrationMismatch,
      flags: decision.flags,
      domain: facts.domain,
      evidence,
      facts,
    };
  }

  private async runFeatureQaStats(args: { dateRange: DateRangeArg; includeFeatures?: boolean }) {
    const { startDate, endDate } = normalizeDateRange(args.dateRange);
    const includeFeatures = args.includeFeatures ?? true;
    const { startMs, endMs } = pacificWindowToUtcMs(startDate, endDate);

    // 1. All project tasks → keep Features only, excluding the "Feature template"
    // artifact (it records phantom QA moves whenever the template is edited).
    const tasks = await this.client.getProjectTasks(SOFTWARE_BOARD_PROJECT_GID, OPT_FIELDS_TASK);
    const features = tasks.filter((t) => isFeatureTask(t) && !isFeatureTemplateTask(t));

    // 2. Prune features that cannot have a story inside the window.
    const candidates = features.filter((t) => {
      const createdMs = t.created_at ? Date.parse(t.created_at) : Number.NEGATIVE_INFINITY;
      const modifiedMs = t.modified_at ? Date.parse(t.modified_at) : Number.POSITIVE_INFINITY;
      if (createdMs > endMs) return false;
      if (modifiedMs < startMs) return false;
      return true;
    });

    logger.info(
      { totalTasks: tasks.length, features: features.length, candidates: candidates.length, startDate, endDate },
      'asana_feature_qa_stats_candidates',
    );

    // 3. Fetch stories (concurrency-limited) and analyze each candidate.
    const analyses = await mapWithConcurrency(candidates, STORY_FETCH_CONCURRENCY, async (task) => {
      const stories = await this.client.getTaskStories(task.gid, OPT_FIELDS_STORY);
      return analyzeFeature(task, stories, startMs, endMs);
    });

    const inScope = analyses.filter((a) => a.hasQaActivityInWindow);
    const bounced = inScope.filter((a) => a.bounces.length > 0);

    // 4. Sub-task evidence — ONLY for bounced features (one extra API call each,
    // ~40 on the full board). QA logs each defect as a sub-task, so a sub-task
    // created around a bounce is strong evidence of a real functional finding.
    await mapWithConcurrency(bounced, STORY_FETCH_CONCURRENCY, async (a) => {
      const subtasks = await this.client.getTaskSubtasks(a.gid, OPT_FIELDS_SUBTASK);
      attachSubtaskEvidence(a.bounces, subtasks);
    });

    // 5. ONE batched LLM classification of bounced features. Each bounce carries
    // `isQaBouncer` so the classifier can default a reason-less QA bounce to a
    // real bug.
    const classifierInput: BouncedFeatureInput[] = bounced.map((a) => ({
      gid: a.gid,
      taskName: a.name,
      bounces: a.bounces.map((b) => ({
        by: b.by,
        from: b.from,
        to: b.to,
        at: b.at,
        isQaBouncer: isQaReviewer(b.by),
        evidenceComments: b.evidenceComments,
      })),
    }));
    const { classifications, degraded } = await classifyBouncedFeatures(classifierInput, { claude: this.claude });

    // 6. Per-feature outcome.
    const outcomeByGid = new Map<string, Outcome>();
    const features_: Array<{
      gid: string;
      name: string;
      url: string;
      outcome: Outcome;
      finders: string[];
      reason: string;
      bounceCountInWindow: number;
    }> = [];

    for (const a of inScope) {
      let outcome: Outcome;
      let reason: string;
      if (a.bounces.length === 0) {
        outcome = 'clean_pass';
        reason = '';
      } else {
        const cls = classifications.get(a.gid);
        if (!cls) {
          outcome = 'unclassified';
          reason = 'classification unavailable';
        } else if (cls.isRealBug) {
          outcome = 'real_bug';
          reason = cls.reason;
        } else {
          outcome = 'process_bounce';
          reason = cls.reason;
        }
      }
      outcomeByGid.set(a.gid, outcome);
      features_.push({
        gid: a.gid,
        name: a.name,
        url: a.url,
        outcome,
        finders: a.finders,
        reason,
        bounceCountInWindow: a.bounces.length,
      });
    }

    // 7. Totals.
    const featuresWithQaActivity = inScope.length;
    const featuresBouncedAny = bounced.length;
    let featuresRealBugByQa = 0;
    let featuresProcessBounceOnly = 0;
    let featuresBouncedByNonQaOnly = 0;
    let featuresUnclassified = 0;
    for (const a of bounced) {
      const outcome = outcomeByGid.get(a.gid);
      const hasQaFinder = a.finders.some(isQaReviewer);
      if (outcome === 'real_bug' && hasQaFinder) featuresRealBugByQa += 1;
      if (outcome === 'process_bounce') featuresProcessBounceOnly += 1;
      if (outcome === 'unclassified') featuresUnclassified += 1;
      if (!hasQaFinder) featuresBouncedByNonQaOnly += 1;
    }

    // 8. Finder attribution (per bounced feature, union of finders).
    interface FinderAgg {
      name: string;
      shortName: string;
      isQa: boolean;
      featuresWithRealBugs: number;
      featuresWithAnyBounce: number;
    }
    const finderMap = new Map<string, FinderAgg>();
    for (const a of bounced) {
      const isReal = outcomeByGid.get(a.gid) === 'real_bug';
      for (const name of a.finders) {
        let agg = finderMap.get(name);
        if (!agg) {
          agg = {
            name,
            shortName: shortNameFor(name),
            isQa: isQaReviewer(name),
            featuresWithRealBugs: 0,
            featuresWithAnyBounce: 0,
          };
          finderMap.set(name, agg);
        }
        agg.featuresWithAnyBounce += 1;
        if (isReal) agg.featuresWithRealBugs += 1;
      }
    }
    const finders = [...finderMap.values()].sort(
      (x, y) =>
        y.featuresWithRealBugs - x.featuresWithRealBugs ||
        y.featuresWithAnyBounce - x.featuresWithAnyBounce ||
        x.name.localeCompare(y.name),
    );

    // 9. Order the per-feature list by severity, then bounce count, then name.
    features_.sort(
      (x, y) =>
        OUTCOME_RANK[x.outcome] - OUTCOME_RANK[y.outcome] ||
        y.bounceCountInWindow - x.bounceCountInWindow ||
        x.name.localeCompare(y.name),
    );

    return {
      period: { startDate, endDate },
      board: BOARD_NAME,
      degraded,
      totals: {
        featuresWithQaActivity,
        featuresBouncedAny,
        featuresRealBugByQa,
        featuresProcessBounceOnly,
        featuresBouncedByNonQaOnly,
        featuresUnclassified,
        realBugRatePct: rate(featuresRealBugByQa, featuresWithQaActivity),
        anyBounceRatePct: rate(featuresBouncedAny, featuresWithQaActivity),
      },
      finders,
      features: includeFeatures ? features_ : [],
    };
  }
}

/** Percentage to 1 decimal; 0 when the denominator is 0. */
function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
