import type { SupabaseClient } from '@supabase/supabase-js';
import type { LiveReportSpec } from '../../reports/live/spec.js';

export interface PublishedReport {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  spec: LiveReportSpec;
  specVersion: number;
  ownerSlackId: string;
  intent: string;
  intentKeywords: string[];
  accessToken: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastVisitedAt: string | null;
  visitCount: number;
}

interface CreateInput {
  slug: string;
  title: string;
  description?: string | null;
  ownerSlackId: string;
  intent: string;
  intentKeywords: string[];
  spec: LiveReportSpec;
  accessToken: string;
}

function rowToReport(r: any): PublishedReport {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description ?? null,
    spec: r.spec,
    specVersion: r.spec_version ?? 1,
    ownerSlackId: r.owner_slack_id,
    intent: r.intent,
    intentKeywords: r.intent_keywords ?? [],
    accessToken: r.access_token,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
    archivedAt: r.archived_at ?? null,
    lastVisitedAt: r.last_visited_at ?? null,
    visitCount: r.visit_count ?? 0,
  };
}

export class PublishedReportsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: CreateInput): Promise<PublishedReport> {
    const { data, error } = await this.client
      .from('published_reports')
      .insert({
        slug: input.slug,
        title: input.title,
        description: input.description ?? null,
        spec: input.spec,
        spec_version: input.spec.version,
        owner_slack_id: input.ownerSlackId,
        intent: input.intent,
        intent_keywords: input.intentKeywords,
        access_token: input.accessToken,
      });
    if (error) throw new Error(`published_reports insert failed: ${error.message}`);
    // data is the inserted row from the fake; in production Supabase insert without
    // .select() returns null, so we fall back to getBySlug to stay compatible with both.
    if (data) return rowToReport(data);
    const fetched = await this.getBySlugIncludeArchived(input.slug);
    if (!fetched) throw new Error(`published_reports insert did not return data for slug ${input.slug}`);
    return fetched;
  }

  private async getBySlugIncludeArchived(slug: string): Promise<PublishedReport | null> {
    const { data, error } = await this.client
      .from('published_reports')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw new Error(`published_reports read failed: ${error.message}`);
    return data ? rowToReport(data) : null;
  }

  async getBySlug(slug: string): Promise<PublishedReport | null> {
    const { data, error } = await this.client
      .from('published_reports')
      .select('*')
      .eq('slug', slug)
      .is('archived_at', null)
      .maybeSingle();
    if (error) throw new Error(`published_reports read failed: ${error.message}`);
    return data ? rowToReport(data) : null;
  }

  async listByOwner(ownerSlackId: string): Promise<PublishedReport[]> {
    const { data, error } = await this.client
      .from('published_reports')
      .select('*')
      .eq('owner_slack_id', ownerSlackId)
      .is('archived_at', null)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`published_reports list failed: ${error.message}`);
    return (data ?? []).map(rowToReport);
  }

  async listAll(): Promise<PublishedReport[]> {
    const { data, error } = await this.client
      .from('published_reports')
      .select('*')
      .is('archived_at', null)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`published_reports listAll failed: ${error.message}`);
    return (data ?? []).map(rowToReport);
  }

  async searchByKeywords(keywords: string[]): Promise<PublishedReport[]> {
    if (keywords.length === 0) return [];
    const { data, error } = await this.client
      .from('published_reports')
      .select('*')
      .is('archived_at', null)
      .overlaps('intent_keywords', keywords);
    if (error) throw new Error(`published_reports keyword search failed: ${error.message}`);
    return (data ?? []).map(rowToReport);
  }

  async recordVisit(slug: string): Promise<void> {
    const existing = await this.getBySlug(slug);
    if (!existing) return;
    await this.client
      .from('published_reports')
      .update({ visit_count: existing.visitCount + 1, last_visited_at: new Date().toISOString() })
      .eq('slug', slug);
  }

  async archive(slug: string, _byUser: string): Promise<void> {
    await this.client
      .from('published_reports')
      .update({ archived_at: new Date().toISOString() })
      .eq('slug', slug);
  }

  async replaceSpec(input: { slug: string; spec: LiveReportSpec; intent: string; intentKeywords: string[]; replacedBy: string; newAccessToken?: string }): Promise<PublishedReport> {
    const existing = await this.getBySlug(input.slug);
    if (!existing) throw new Error(`No active report with slug ${input.slug}`);
    await this.client.from('published_reports_history').insert({
      report_id: existing.id,
      spec: existing.spec,
      spec_version: existing.specVersion,
      intent: existing.intent,
      replaced_by_slack_id: input.replacedBy,
    });
    const update: Record<string, unknown> = {
      spec: input.spec,
      spec_version: input.spec.version,
      intent: input.intent,
      intent_keywords: input.intentKeywords,
      title: input.spec.title,
      description: (input.spec as any).description ?? null,
      updated_at: new Date().toISOString(),
    };
    if (input.newAccessToken) update.access_token = input.newAccessToken;
    const { data, error } = await this.client
      .from('published_reports')
      .update(update)
      .eq('slug', input.slug)
      .select('*')
      .single();
    if (error) throw new Error(`published_reports replaceSpec failed: ${error.message}`);
    return rowToReport(data);
  }

  async listHistory(slug: string, limit = 5): Promise<Array<{ spec: LiveReportSpec; intent: string; replacedAt: string; replacedBy: string }>> {
    const existing = await this.getBySlug(slug);
    if (!existing) return [];
    const { data, error } = await this.client
      .from('published_reports_history')
      .select('spec, intent, replaced_at, replaced_by_slack_id')
      .eq('report_id', existing.id)
      .order('replaced_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`published_reports_history read failed: ${error.message}`);
    return (data ?? []).map((r: any) => ({ spec: r.spec, intent: r.intent, replacedAt: r.replaced_at, replacedBy: r.replaced_by_slack_id }));
  }
}
