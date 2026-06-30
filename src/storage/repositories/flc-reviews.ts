import type { SupabaseClient } from '@supabase/supabase-js';
import type { Finding } from '../../flc/flc-review-service.js';

/** A persisted /review-flc review, keyed by the Slack result-message ts. */
export interface FlcReviewRecord {
  messageTs: string;
  channel: string;
  pageId: string;
  url: string;
  findings: Finding[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowFromDb(r: Record<string, any>): FlcReviewRecord {
  return {
    messageTs: r.message_ts,
    channel: r.channel,
    pageId: r.page_id,
    url: r.url,
    findings: (r.findings ?? []) as Finding[],
  };
}

/**
 * Persists review state so the result message's buttons survive bot restarts /
 * redeploys (the previous in-memory store lost everything on each deploy).
 */
export class FlcReviewsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async save(rec: FlcReviewRecord): Promise<void> {
    const { error } = await this.client.from('flc_reviews').upsert({
      message_ts: rec.messageTs,
      channel: rec.channel,
      page_id: rec.pageId,
      url: rec.url,
      findings: rec.findings,
    });
    if (error) throw new Error(`flc_reviews save failed: ${error.message}`);
  }

  async get(messageTs: string): Promise<FlcReviewRecord | null> {
    const { data, error } = await this.client
      .from('flc_reviews')
      .select('*')
      .eq('message_ts', messageTs)
      .maybeSingle();
    if (error) throw new Error(`flc_reviews get failed: ${error.message}`);
    return data ? rowFromDb(data) : null;
  }

  async delete(messageTs: string): Promise<void> {
    const { error } = await this.client.from('flc_reviews').delete().eq('message_ts', messageTs);
    if (error) throw new Error(`flc_reviews delete failed: ${error.message}`);
  }
}
