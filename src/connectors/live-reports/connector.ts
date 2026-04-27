import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { Connector, ToolDef } from '../base/connector.js';
import { zodToJsonSchema } from '../base/zod-to-json-schema.js';
import type { PublishedReportsRepo } from '../../storage/repositories/published-reports.js';
import type { ConnectorRegistry } from '../base/registry.js';
import type { ActorContext } from '../../orchestrator/orchestrator.js';
import { extractKeywords, rankCandidates } from '../../reports/live/dedup.js';
import { compileLiveReport } from './compiler.js';
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

    // 1. Dedup gate
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

    // 2. Compile via LLM (with Zod retry inside)
    let compileOut;
    try {
      compileOut = await compileLiveReport({
        intent: args.intent,
        claude: this.deps.claude,
        model: this.deps.model,
        toolCatalog: this.deps.getToolCatalog(),
      });
    } catch (err) {
      return { status: 'compile_failed' as const, message: err instanceof Error ? err.message : String(err) };
    }
    const spec = compileOut.spec;

    // 3. Smoke-execute the spec end-to-end. If EVERY step errors, abort.
    const smoke = await runLiveSpec(spec, this.deps.registry);
    if (smoke.errors.length === spec.data.length) {
      return {
        status: 'smoke_failed' as const,
        errors: smoke.errors,
        spec,
        message: 'Every data step failed during smoke execution. Spec was not persisted.',
      };
    }

    // 4. Persist
    const slugBase = slugifyTitle(spec.title);
    const slug = await findFreeSlug(slugBase, async (s) => (await this.deps.repo.getBySlug(s)) !== null);
    const accessToken = generateAccessToken();
    const intentKeywords = extractKeywords(args.intent);
    const created = await this.deps.repo.create({
      slug,
      title: spec.title,
      description: spec.description ?? null,
      ownerSlackId: actor.slackUserId,
      intent: args.intent,
      intentKeywords,
      spec,
      accessToken,
    });

    const url = `${this.deps.publicBaseUrl}/r/${created.slug}?t=${accessToken}`;
    logger.info({ slug, owner: actor.slackUserId, attempts: compileOut.attempts, ms: smoke.meta.durationMs }, 'live-report published');
    return {
      status: 'created' as const,
      slug: created.slug,
      title: created.title,
      url,
      compileAttempts: compileOut.attempts,
      smokeWarnings: smoke.errors,
    };
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
    });
    const smoke = await runLiveSpec(compileOut.spec, this.deps.registry);
    if (smoke.errors.length === compileOut.spec.data.length) {
      return { error: { code: 'SMOKE_FAILED', message: 'Every step errored. Spec was not saved.' }, errors: smoke.errors };
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
    };
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
