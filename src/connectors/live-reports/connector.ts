import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { WebClient } from '@slack/web-api';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { PublishedReportsRepo } from '../../storage/repositories/published-reports.js';
import type { ConnectorRegistry } from '../base/registry.js';
import type { ActorContext } from '../../orchestrator/orchestrator.js';
import { extractKeywords, rankCandidates } from '../../reports/live/dedup.js';
import { compileLiveReport } from './compiler.js';
import type { LiveCatalogs } from './live-catalogs.js';
import { runLiveSpec } from '../../reports/live/runner.js';
import { slugifyTitle, generateAccessToken, findFreeSlug } from '../../reports/live/identifiers.js';
import { logger } from '../../logger.js';

export interface LiveReportsConnectorDeps {
  repo: PublishedReportsRepo;
  claude: Anthropic;
  model: string;
  registry: Pick<ConnectorRegistry, 'execute'>;
  getToolCatalog: () => string;
  publicBaseUrl: string;
  getActor: () => ActorContext | undefined;
  getRoleForActor: (slackUserId: string) => Promise<string | null>;
  /** Slack WebClient used to DM the requester when async publish completes. */
  slackClient: WebClient;
  /** Cached enum catalogs (NB metrics/breakdowns/attribution models) injected
   *  into the compiler prompt so the LLM never invents an invalid arg value. */
  liveCatalogs?: LiveCatalogs;
}

const FindArgs = z.object({
  intent: z.string().min(3).max(2000).describe('Natural-language description of the report the user wants. Used to extract keywords and search existing reports.'),
});
type FindArgs = z.infer<typeof FindArgs>;

const PublishArgs = z.object({
  intent: z.string().min(3).max(2000),
  forceCreate: z.boolean().default(false).describe('Skip the dedup gate. Set true ONLY if the user explicitly says they want a new report after seeing the dedup recommendation.'),
});
type PublishArgs = z.infer<typeof PublishArgs>;

const ListMineArgs = z.object({}).strict();
type ListMineArgs = z.infer<typeof ListMineArgs>;

const RecompileArgs = z.object({
  slug: z.string().min(1).max(80),
  newIntent: z.string().min(3).max(2000),
  regenerateToken: z.boolean().default(false),
});
type RecompileArgs = z.infer<typeof RecompileArgs>;

const ArchiveArgs = z.object({
  slug: z.string().min(1).max(80),
});
type ArchiveArgs = z.infer<typeof ArchiveArgs>;

export class LiveReportsConnector implements Connector {
  readonly name = 'live-reports';
  readonly tools: readonly ToolDef[];
  /** Tracks the in-flight background publish job. Tests await this to assert
   *  the async pipeline completed; production code never reads it. */
  _backgroundPublish: Promise<void> | null = null;

  constructor(private readonly deps: LiveReportsConnectorDeps) {
    this.tools = [
      this.findTool(),
      this.publishTool(),
      this.listMineTool(),
      this.recompileTool(),
      this.archiveTool(),
    ];
  }

  async healthCheck() { return { ok: true }; }

  private findTool(): ToolDef<FindArgs> {
    return {
      name: 'reports.find_similar_reports',
      description: [
        'Search existing live reports for ones that already answer the user\'s intent. Returns matches sorted by keyword overlap (≥3 shared keywords).',
        'ALWAYS call this BEFORE `reports.publish_live_report`. If matches are found, recommend them to the user before creating a new one.',
        'Searches across ALL non-archived reports (cross-org). Each match includes owner so the bot can say "owned by @user".',
      ].join(' '),
      schema: FindArgs as z.ZodType<FindArgs>,
      jsonSchema: zodToJsonSchema(FindArgs),
      execute: (args) => this.find(args),
    };
  }

  private publishTool(): ToolDef<PublishArgs> {
    return {
      name: 'reports.publish_live_report',
      description: [
        'Create a Live Report at a shareable URL. Use ONLY when the user explicitly asks for a "live report", "reporte en vivo", "live dashboard", "shareable URL".',
        'BEFORE calling this tool, call `reports.find_similar_reports` first. If matches are returned with score≥3, recommend them to the user. Only call this tool with `forceCreate: true` when the user has explicitly confirmed they want a new one anyway.',
        'Pipeline: dedup → LLM compiles JSON spec → Zod validates → smoke-execute the spec end-to-end → persist with slug + token. Returns the URL.',
      ].join(' '),
      schema: PublishArgs as z.ZodType<PublishArgs>,
      jsonSchema: zodToJsonSchema(PublishArgs),
      execute: (args) => this.publish(args),
    };
  }

  private listMineTool(): ToolDef<ListMineArgs> {
    return {
      name: 'reports.list_my_reports',
      description: 'List Live Reports owned by the current user.',
      schema: ListMineArgs as z.ZodType<ListMineArgs>,
      jsonSchema: zodToJsonSchema(ListMineArgs),
      execute: () => this.listMine(),
    };
  }

  private recompileTool(): ToolDef<RecompileArgs> {
    return {
      name: 'reports.recompile_report',
      description: [
        'Replace the spec of an existing Live Report. Author or admin only.',
        'The slug + URL stay stable (bookmarks survive). Old spec is preserved in history (last 5 versions).',
        '`regenerateToken: true` rotates the access token (invalidates old links).',
      ].join(' '),
      schema: RecompileArgs as z.ZodType<RecompileArgs>,
      jsonSchema: zodToJsonSchema(RecompileArgs),
      execute: (args) => this.recompile(args),
    };
  }

  private archiveTool(): ToolDef<ArchiveArgs> {
    return {
      name: 'reports.archive_report',
      description: 'Soft-delete a Live Report. Author or admin only.',
      schema: ArchiveArgs as z.ZodType<ArchiveArgs>,
      jsonSchema: zodToJsonSchema(ArchiveArgs),
      execute: (args) => this.archive(args),
    };
  }

  // ---- find ----
  private async find(args: FindArgs) {
    const keywords = extractKeywords(args.intent);
    const all = await this.deps.repo.listAll();
    const matches = rankCandidates(
      keywords,
      all.map((r) => ({ slug: r.slug, title: r.title, ownerSlackId: r.ownerSlackId, intentKeywords: r.intentKeywords })),
    );
    return {
      keywords,
      matches: matches.map((m) => ({
        slug: m.slug,
        title: m.title,
        owner_slack_id: m.ownerSlackId,
        score: m.score,
        url: `${this.deps.publicBaseUrl}/r/${m.slug}`,
      })),
    };
  }

  // ---- publish ----
  private async publish(args: PublishArgs) {
    const actor = this.deps.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'no active actor' } };

    // 1. Dedup gate — synchronous, fast.
    if (!args.forceCreate) {
      const dedup = await this.find({ intent: args.intent });
      if (dedup.matches.length > 0) {
        return {
          status: 'existing_match' as const,
          keywords: dedup.keywords,
          matches: dedup.matches,
          notes: 'Existing reports match this intent. Recommend them to the user. To create a new one anyway, call again with forceCreate: true.',
        };
      }
    }

    // 2. Compile + smoke + verify + persist runs in the background. The tool
    //    returns immediately so the assistant can tell the user "this will
    //    take a minute, I'll DM you the link when ready" instead of holding
    //    the Slack thread open for 30–90s. The background job posts the
    //    final URL (or failure reason) to the requester via DM.
    const startedAt = Date.now();
    this._backgroundPublish = this.publishInBackground(args, actor, startedAt);
    void this._backgroundPublish;

    return {
      status: 'queued' as const,
      message: 'Compiling the report in background. The user will receive a DM with the URL when ready (typically 30–90 seconds). Do not wait for the URL — acknowledge the request and end the turn.',
      requesterSlackUserId: actor.slackUserId,
    };
  }

  /**
   * Background publish job. Runs after the tool has already returned to the
   * orchestrator. Any error must be caught here — an unhandled rejection
   * would crash the process.
   */
  private async publishInBackground(args: PublishArgs, actor: ActorContext, startedAt: number): Promise<void> {
    try {
      // Compile via LLM (with Zod retry inside)
      let compileOut;
      try {
        compileOut = await compileLiveReport({
          intent: args.intent,
          claude: this.deps.claude,
          model: this.deps.model,
          toolCatalog: this.deps.getToolCatalog(),
          liveCatalogs: this.deps.liveCatalogs,
        });
      } catch (err) {
        await this.notifyFailure(actor.slackUserId, 'compile_failed', err instanceof Error ? err.message : String(err));
        return;
      }
      const spec = compileOut.spec;

      // Smoke-execute the spec end-to-end. If EVERY step errors, abort.
      const smoke = await runLiveSpec(spec, this.deps.registry);
      if (smoke.errors.length === spec.data.length) {
        await this.notifyFailure(actor.slackUserId, 'smoke_failed', `Every data step failed during smoke execution. Errors: ${smoke.errors.map((e) => `${e.tool}: ${e.message}`).join('; ')}`);
        return;
      }

      let verificationIssues = this.verifyResolvedRefs(spec, smoke.dataResults);
      let finalSpec = spec;
      let finalSmoke = smoke;
      let finalCompileAttempts = compileOut.attempts;
      // Hard issues mean the report won't actually work — refs that don't
      // resolve, columns that aren't in the data, leftover template tokens
      // the user would see. We block publish on these. Soft issues
      // (text_block_uses_data_refs, empty_array) are cosmetic / handled at
      // render time and only generate a warning DM.
      const HARD_REASONS = new Set([
        'ref_undefined',
        'column_field_missing_in_data',
        'unresolved_date_macro',
        'unresolved_report_range',
        'unresolved_dollar_brace',
      ]);
      const hardCount = (issues: typeof verificationIssues) => issues.filter((i) => HARD_REASONS.has(i.reason)).length;
      if (verificationIssues.length > 0) {
        const shapePreview = this.summarizeDataShape(smoke.dataResults);
        const feedback = [
          'Your previous spec produced these verification issues:',
          ...verificationIssues.map((i) => `- block ${i.blockIndex}: ref="${i.ref}" reason=${i.reason}`),
          '',
          'Fix the data refs / column field names so they match the actual tool output shape.',
          'Common pitfalls:',
          '- NB metrics_explorer with breakdown returns rows where the channel name lives under field "breakdown_value" (literally — not the breakdown KEY name). Daily breakdowns include a "date" field.',
          '- reason="text_block_uses_data_refs" → you wrote `path.to.field` or ${path.to.field} INSIDE a `text` block\'s markdown. Text blocks are rendered as plain markdown — they do NOT template data refs. Replace with a `kpi` block (single value) or a `table` block (rows × columns) that resolves the ref properly. Move the dynamic numbers OUT of the text and into proper data blocks.',
          '- reason="ref_undefined" → the data ref doesn\'t exist in tool output; double-check field names against the real shape.',
          '- reason="empty_array" → the tool returned no rows; either fix the args or remove the block.',
          '- reason="unresolved_date_macro" → a `$DATE:<base>[±Nd]` token reached the rendered output without being substituted. Either you used an unknown base name (allowed: today, yesterday, this_monday, last_monday, monday_2w_ago, last_sunday, sunday_2w_ago) OR you embedded the macro as a code-style backticked literal (e.g. `` `$DATE:today` ``) which the runner would still substitute — but the issue here is the regex didn\'t match. Use the macro plain (no backticks needed in prose, e.g. "Comparing $DATE:this_monday to $DATE:today") or replace the literal date altogether.',
          '- reason="unresolved_report_range" → the literal "$REPORT_RANGE" string ended up in user-visible text (title, description, KPI label). That token is only meaningful inside step args. Use the actual period name in human-readable text.',
          '- reason="unresolved_dollar_brace" → you wrote `${something}` somewhere expecting interpolation. The runner doesn\'t support that syntax outside of step args. Either move the value into a derived step / data ref, or write the literal value.',
          '',
          '--- ACTUAL DATA SHAPE FROM YOUR SMOKE RUN (use these EXACT field names) ---',
          shapePreview,
          '',
          'Match every value/data ref against the shape above. Common gotcha: NB metrics_explorer rows DO NOT have a `totals` wrapper — the rows array IS the data. NB metrics use the metric ID as the field name (rev, spend, txns) — NOT the human-readable "transactions" / "revenue" / "spend". Breakdown values live at `breakdown_value`.',
        ].join('\n');
        try {
          const retry = await compileLiveReport({
            intent: `${args.intent}\n\n--- VERIFICATION FEEDBACK FROM PREVIOUS ATTEMPT ---\n${feedback}`,
            claude: this.deps.claude,
            model: this.deps.model,
            toolCatalog: this.deps.getToolCatalog(),
          liveCatalogs: this.deps.liveCatalogs,
            maxAttempts: 1,
          });
          const retrySmoke = await runLiveSpec(retry.spec, this.deps.registry);
          const retryIssues = this.verifyResolvedRefs(retry.spec, retrySmoke.dataResults);
          // Prefer the retry if it strictly reduces hard issues, hard-issue
          // tied with fewer total issues, or strictly fewer step errors.
          if (
            retrySmoke.errors.length < finalSmoke.errors.length
            || hardCount(retryIssues) < hardCount(verificationIssues)
            || (hardCount(retryIssues) === hardCount(verificationIssues) && retryIssues.length < verificationIssues.length)
          ) {
            finalSpec = retry.spec;
            finalSmoke = retrySmoke;
            finalCompileAttempts += retry.attempts;
            verificationIssues = retryIssues;
          }
        } catch (err) {
          logger.warn({ err }, 'publish re-validation retry failed — keeping original spec');
        }
      }

      // Block publish if hard issues remain — the report would render broken.
      const remainingHard = hardCount(verificationIssues);
      if (remainingHard > 0) {
        // Distinguish ROOT-CAUSE failures: when a step errored during smoke,
        // every ref pointing into that step's output shows up as
        // `ref_undefined` — but the user's actual fix is to address the step
        // failure, not "use a different ref". Surface step errors first.
        const failedStepIds = new Set(finalSmoke.errors.map((e) => e.stepId));
        const stepFailureBlock = finalSmoke.errors.length > 0
          ? `\nROOT CAUSE — these data steps failed in smoke (so any ref into them won\'t resolve):\n${finalSmoke.errors.slice(0, 5).map((e) => `• step \`${e.stepId}\` (${e.tool}): ${e.code} — ${e.message}`).join('\n')}\n`
          : '';
        // Filter out ref_undefined issues that are caused by step failures —
        // they're symptoms, not separate problems. Keep them only when the
        // step actually succeeded (meaning the LLM picked the wrong path).
        const realIssues = verificationIssues.filter((i) => {
          if (!HARD_REASONS.has(i.reason)) return false;
          if (i.reason !== 'ref_undefined') return true;
          const head = i.ref.split('.')[0]?.replace(/\[.*$/, '');
          return !failedStepIds.has(head);
        });
        const issueList = realIssues.slice(0, 8).map((i) => `• block ${i.blockIndex} (${i.reason}) → \`${i.ref}\``).join('\n');
        const more = realIssues.length > 8 ? `\n…and ${realIssues.length - 8} more` : '';
        const issuesSection = realIssues.length > 0
          ? `\nAdditional ref/shape issues:\n${issueList}${more}`
          : '';
        const summary = finalSmoke.errors.length > 0
          ? `Couldn\'t publish: ${finalSmoke.errors.length} data step${finalSmoke.errors.length === 1 ? '' : 's'} failed during smoke. The ${remainingHard} undefined-ref issue${remainingHard === 1 ? '' : 's'} are downstream consequences.`
          : `${remainingHard} hard verification issue${remainingHard === 1 ? '' : 's'} after retry — the report would render with missing/broken data, so I didn\'t publish it.`;
        await this.notifyFailure(
          actor.slackUserId,
          'verification_failed',
          `${summary}${stepFailureBlock}${issuesSection}\n\nFix: ${finalSmoke.errors.length > 0 ? 'address the step failure (check tool args, retry the source) or' : ''} recompile with a more specific intent — mention exact field names, breakdown keys, attribution model, etc.`,
        );
        logger.warn({ owner: actor.slackUserId, hard: remainingHard, stepErrors: finalSmoke.errors.length, total: verificationIssues.length }, 'live-report publish blocked by hard verification issues');
        return;
      }

      // Persist
      const slugBase = slugifyTitle(finalSpec.title);
      const slug = await findFreeSlug(slugBase, async (s) => (await this.deps.repo.getBySlug(s)) !== null);
      const accessToken = generateAccessToken();
      const intentKeywords = extractKeywords(args.intent);
      const created = await this.deps.repo.create({
        slug,
        title: finalSpec.title,
        description: finalSpec.description ?? null,
        ownerSlackId: actor.slackUserId,
        intent: args.intent,
        intentKeywords,
        spec: finalSpec,
        accessToken,
      });

      const url = `${this.deps.publicBaseUrl}/r/${created.slug}?t=${accessToken}`;
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      logger.info({ slug, owner: actor.slackUserId, attempts: finalCompileAttempts, ms: finalSmoke.meta.durationMs, elapsedSec }, 'live-report published (async)');
      await this.notifySuccess(actor.slackUserId, {
        title: created.title,
        url,
        elapsedSec,
        verificationIssues,
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'publishInBackground unhandled failure');
      await this.notifyFailure(actor.slackUserId, 'unexpected_error', err instanceof Error ? err.message : String(err));
    }
  }

  private async notifySuccess(slackUserId: string, info: { title: string; url: string; elapsedSec: number; verificationIssues: Array<{ blockIndex: number; ref: string; reason: string }> }): Promise<void> {
    let issuesNote = '';
    if (info.verificationIssues.length > 0) {
      const top = info.verificationIssues.slice(0, 5).map((i) => `• block ${i.blockIndex} (${i.reason}) → \`${i.ref}\``).join('\n');
      const more = info.verificationIssues.length > 5 ? `\n…and ${info.verificationIssues.length - 5} more` : '';
      issuesNote = `\n\n⚠️ ${info.verificationIssues.length} verification issue${info.verificationIssues.length === 1 ? '' : 's'} after retry — please review:\n${top}${more}\nIf the report looks wrong, ask me to recompile it.`;
    }
    const text = `✅ Tu live report está listo: *${info.title}*\n${info.url}\n_(${info.elapsedSec}s)_${issuesNote}`;
    await this.dm(slackUserId, text);
  }

  private async notifyFailure(slackUserId: string, code: string, message: string): Promise<void> {
    const text = `❌ No pude publicar tu live report (${code}).\n${message}\n\nTry again or rephrase the intent.`;
    await this.dm(slackUserId, text);
  }

  private async dm(slackUserId: string, text: string): Promise<void> {
    try {
      const open = await this.deps.slackClient.conversations.open({ users: slackUserId });
      if (!open.ok || !open.channel?.id) {
        throw new Error(`conversations.open failed: ${open.error ?? 'unknown'}`);
      }
      await this.deps.slackClient.chat.postMessage({
        channel: open.channel.id,
        text,
        unfurl_links: false,
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), slackUserId }, 'live-reports DM notification failed');
    }
  }
  private async listMine() {
    const actor = this.deps.getActor();
    if (!actor) return { error: { code: 'NO_ACTOR', message: 'no actor' } };
    const rows = await this.deps.repo.listByOwner(actor.slackUserId);
    return {
      reports: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        url: `${this.deps.publicBaseUrl}/r/${r.slug}?t=${r.accessToken}`,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        visitCount: r.visitCount,
        lastVisitedAt: r.lastVisitedAt,
      })),
    };
  }

  private async assertCanModify(slug: string): Promise<{ allowed: boolean; report?: any; reason?: string }> {
    const actor = this.deps.getActor();
    if (!actor) return { allowed: false, reason: 'NO_ACTOR' };
    const report = await this.deps.repo.getBySlug(slug);
    if (!report) return { allowed: false, reason: 'NOT_FOUND' };
    const role = await this.deps.getRoleForActor(actor.slackUserId);
    if (report.ownerSlackId === actor.slackUserId || role === 'admin') return { allowed: true, report };
    return { allowed: false, reason: 'FORBIDDEN', report };
  }

  private async recompile(args: RecompileArgs) {
    const gate = await this.assertCanModify(args.slug);
    if (!gate.allowed) {
      const code = gate.reason ?? 'FORBIDDEN';
      return { error: { code, message: code === 'NOT_FOUND' ? 'Report not found' : 'Only the report author or an admin can recompile' } };
    }
    const compileOut = await compileLiveReport({
      intent: args.newIntent,
      claude: this.deps.claude,
      model: this.deps.model,
      toolCatalog: this.deps.getToolCatalog(),
          liveCatalogs: this.deps.liveCatalogs,
    });
    const smoke = await runLiveSpec(compileOut.spec, this.deps.registry);
    if (smoke.errors.length === compileOut.spec.data.length) {
      return { error: { code: 'SMOKE_FAILED', message: 'Every step errored. Spec was not saved.' }, errors: smoke.errors };
    }
    const verificationIssues = this.verifyResolvedRefs(compileOut.spec, smoke.dataResults);
    // Same hard-issue gate as publish — refuse to overwrite a working spec
    // with a broken one. The original report stays intact at its URL.
    const HARD_REASONS = new Set(['ref_undefined', 'column_field_missing_in_data', 'unresolved_date_macro', 'unresolved_report_range', 'unresolved_dollar_brace']);
    const hardIssues = verificationIssues.filter((i) => HARD_REASONS.has(i.reason));
    if (hardIssues.length > 0) {
      return {
        error: { code: 'VERIFICATION_FAILED', message: `${hardIssues.length} hard verification issue${hardIssues.length === 1 ? '' : 's'} — recompile aborted; existing spec preserved.` },
        verificationIssues,
        hardIssues: hardIssues.slice(0, 8).map((i) => ({ blockIndex: i.blockIndex, ref: i.ref, reason: i.reason })),
      };
    }
    const actor = this.deps.getActor()!;
    const newToken = args.regenerateToken ? generateAccessToken() : undefined;
    const updated = await this.deps.repo.replaceSpec({
      slug: args.slug,
      spec: compileOut.spec,
      intent: args.newIntent,
      intentKeywords: extractKeywords(args.newIntent),
      replacedBy: actor.slackUserId,
      newAccessToken: newToken,
    });
    return {
      status: 'recompiled' as const,
      slug: updated.slug,
      title: updated.title,
      url: `${this.deps.publicBaseUrl}/r/${updated.slug}?t=${updated.accessToken}`,
      tokenRotated: !!newToken,
      verificationIssues,
    };
  }

  /** Produce a human/LLM-readable summary of the actual data shape returned by
   *  the smoke run. Used in retry feedback so the next compile attempt can see
   *  EXACTLY which paths are valid instead of guessing. For arrays, includes
   *  the first row's keys (the LLM only needs the shape, not the values).
   *  Capped to keep the prompt small. */
  private summarizeDataShape(dataResults: Record<string, unknown>): string {
    const lines: string[] = [];
    const inspect = (v: unknown, depth: number): string => {
      if (v === null) return 'null';
      if (Array.isArray(v)) {
        if (v.length === 0) return 'array(0)';
        const sample = v[0];
        if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
          const keys = Object.keys(sample as Record<string, unknown>).slice(0, 30);
          return `array(${v.length}) of { ${keys.join(', ')} }`;
        }
        return `array(${v.length}) of ${typeof sample}`;
      }
      if (typeof v === 'object') {
        const keys = Object.keys(v as Record<string, unknown>);
        if (depth >= 2) return `{ ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', …' : ''} }`;
        const parts = keys.slice(0, 12).map((k) => `${k}: ${inspect((v as Record<string, unknown>)[k], depth + 1)}`);
        return `{ ${parts.join(', ')}${keys.length > 12 ? ', …' : ''} }`;
      }
      if (typeof v === 'string') return v.length > 40 ? `string(${v.length})` : `"${v}"`;
      return typeof v;
    };
    for (const [stepId, value] of Object.entries(dataResults)) {
      lines.push(`${stepId}: ${inspect(value, 0)}`);
    }
    return lines.join('\n');
  }

  /** Patterns that should NEVER appear in the final user-visible payload —
   *  they indicate a templating step didn't run or didn't cover this field. */
  private static readonly UNRESOLVED_TOKEN_PATTERNS: Array<{ reason: string; re: RegExp }> = [
    { reason: 'unresolved_date_macro', re: /\$DATE:[a-z][a-z0-9_]*(?:[+-]\d+d)?/g },
    { reason: 'unresolved_report_range', re: /\$REPORT_RANGE/g },
    { reason: 'unresolved_dollar_brace', re: /\$\{[^}]+\}/g },
  ];

  /** Recursively walk a value looking for unresolved template tokens. Reports
   *  every match as a verification issue tagged with the given block index. */
  private scanUnresolvedTokensInBlock(value: unknown, blockIndex: number, issues: Array<{ blockIndex: number; ref: string; reason: string }>): void {
    if (typeof value === 'string') {
      for (const { reason, re } of LiveReportsConnector.UNRESOLVED_TOKEN_PATTERNS) {
        const matches = value.match(re);
        if (matches) {
          for (const m of matches) issues.push({ blockIndex, ref: m, reason });
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) this.scanUnresolvedTokensInBlock(v, blockIndex, issues);
      return;
    }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) {
        this.scanUnresolvedTokensInBlock(v, blockIndex, issues);
      }
    }
  }

  private verifyResolvedRefs(spec: import('../../reports/live/spec.js').LiveReportSpec, dataResults: Record<string, unknown>) {
    const issues: Array<{ blockIndex: number; ref: string; reason: string }> = [];
    // Top-level spec fields (title, description, subtitle) — same sweep.
    // We use blockIndex=-1 to mark "not a UI block" so the retry feedback
    // can identify it correctly.
    this.scanUnresolvedTokensInBlock(spec.title, -1, issues);
    if (spec.description) this.scanUnresolvedTokensInBlock(spec.description, -1, issues);
    if ('subtitle' in spec) this.scanUnresolvedTokensInBlock((spec as { subtitle?: string }).subtitle, -1, issues);
    const tryResolve = (ref: string): unknown => {
      if (!ref || typeof ref !== 'string') return undefined;
      const segs = ref.split('.');
      if (segs.some((s) => !s)) return undefined;
      let cur: unknown = dataResults;
      for (const raw of segs) {
        const m = raw.match(/^([^[\]]+)((?:\[\d+\])*)$/);
        if (!m) return undefined;
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[m[1]];
        const idxs = m[2].match(/\[(\d+)\]/g) ?? [];
        for (const ix of idxs) {
          const i = Number(ix.slice(1, -1));
          if (!Array.isArray(cur)) return undefined;
          cur = cur[i];
        }
      }
      return cur;
    };
    const dataKeys = new Set(Object.keys(dataResults ?? {}));
    spec.ui.forEach((b: any, idx: number) => {
      const checks: string[] = [];
      if (b.type === 'kpi') checks.push(b.value);
      if (b.type === 'chart' || b.type === 'table') checks.push(b.data);
      if (b.type === 'kpi' && b.delta?.from) checks.push(b.delta.from);
      for (const ref of checks) {
        const v = tryResolve(ref);
        if (v === undefined) issues.push({ blockIndex: idx, ref, reason: 'ref_undefined' });
        else if (Array.isArray(v) && v.length === 0 && (b.type === 'chart' || b.type === 'table')) issues.push({ blockIndex: idx, ref, reason: 'empty_array' });
      }
      // Also check: for tables, do columns reference fields that exist in the first row?
      if (b.type === 'table') {
        const rows = tryResolve(b.data);
        if (Array.isArray(rows) && rows.length > 0) {
          const sample = rows[0] as Record<string, unknown>;
          for (const col of b.columns) {
            if (!(col.field in sample)) issues.push({ blockIndex: idx, ref: `${b.data}[].${col.field}`, reason: 'column_field_missing_in_data' });
          }
        }
      }
      // Generic post-render sweep: any string anywhere in the spec that still
      // looks like an unresolved template token is a bug. This is a defense-
      // in-depth net that catches NEW classes of "templating didn't apply"
      // bugs without enumerating every place a token could land — covers
      // unresolved $DATE macros, stranded $REPORT_RANGE, ${…} interpolations.
      this.scanUnresolvedTokensInBlock(b, idx, issues);
      // Text blocks: detect the LLM anti-pattern of writing data refs as
      // `${path.to.field}` or `` `path.to.field` `` (backticked) inside markdown,
      // expecting them to be templated. They are NOT — text is rendered as-is.
      // The fix is to use a kpi/table block instead.
      if (b.type === 'text' && typeof b.markdown === 'string') {
        const md: string = b.markdown;
        const found = new Set<string>();
        // Match either `${a.b.c}` or backtick-wrapped a.b.c (≥2 dotted segments,
        // first segment matches a known dataResults step id).
        const dollar = /\$\{\s*([a-zA-Z_]\w*(?:\.[\w[\]]+){1,})\s*\}/g;
        const tick = /`([a-zA-Z_]\w*(?:\.[\w[\]]+){1,})`/g;
        for (const re of [dollar, tick]) {
          let m: RegExpExecArray | null;
          while ((m = re.exec(md)) !== null) {
            const path = m[1];
            const head = path.split('.')[0].replace(/\[.*$/, '');
            if (dataKeys.has(head)) found.add(path);
          }
        }
        for (const path of found) {
          issues.push({ blockIndex: idx, ref: path, reason: 'text_block_uses_data_refs' });
        }
      }
    });
    return issues;
  }


  private async archive(args: ArchiveArgs) {
    const gate = await this.assertCanModify(args.slug);
    if (!gate.allowed) {
      const code = gate.reason ?? 'FORBIDDEN';
      return { error: { code, message: code === 'NOT_FOUND' ? 'Report not found' : 'Only the report author or an admin can archive' } };
    }
    const actor = this.deps.getActor()!;
    await this.deps.repo.archive(args.slug, actor.slackUserId);
    return { status: 'archived' as const, slug: args.slug };
  }
}
