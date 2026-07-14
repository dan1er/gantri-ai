import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeliveryTier } from '../../connectors/asana/board-config.js';
import type { Facts, FlagKey } from '../../connectors/asana/tier/decide.js';

/**
 * The bot's record of what it classified on each Software Board task. Keyed by
 * the Asana task gid. See `migrations/0036_tier_classifications.sql`.
 */
export interface TierClassificationRecord {
  taskGid: string;
  inputHash: string;
  promptVersion: number;
  facts: Facts;
  tier: DeliveryTier;
  liftedByUnclear: boolean;
  flags: FlagKey[];
  domain: string | null;
  decidedBy: 'bot' | 'human_override';
  humanTier: string | null;
  commentGid: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowFromDb(r: Record<string, any>): TierClassificationRecord {
  return {
    taskGid: r.task_gid,
    inputHash: r.input_hash,
    promptVersion: r.prompt_version,
    facts: r.facts as Facts,
    tier: r.tier as DeliveryTier,
    liftedByUnclear: !!r.lifted_by_unclear,
    flags: (r.flags ?? []) as FlagKey[],
    domain: (r.domain as string | null) ?? null,
    decidedBy: r.decided_by as 'bot' | 'human_override',
    humanTier: (r.human_tier as string | null) ?? null,
    commentGid: (r.comment_gid as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
  };
}

/** What the poller writes after a fresh bot classification. */
export interface TierUpsert {
  taskGid: string;
  inputHash: string;
  promptVersion: number;
  facts: Facts;
  tier: DeliveryTier;
  liftedByUnclear: boolean;
  flags: FlagKey[];
  domain: string | null;
  commentGid: string | null;
}

export class TierClassificationsRepo {
  constructor(private readonly client: SupabaseClient) {}

  async get(taskGid: string): Promise<TierClassificationRecord | null> {
    const { data, error } = await this.client
      .from('tier_classifications')
      .select('*')
      .eq('task_gid', taskGid)
      .maybeSingle();
    if (error) throw new Error(`tier_classifications get failed: ${error.message}`);
    return data ? rowFromDb(data) : null;
  }

  /** Insert or replace a bot classification (resets any override state). */
  async upsertBot(rec: TierUpsert): Promise<void> {
    const { error } = await this.client.from('tier_classifications').upsert(
      {
        task_gid: rec.taskGid,
        input_hash: rec.inputHash,
        prompt_version: rec.promptVersion,
        facts: rec.facts,
        tier: rec.tier,
        lifted_by_unclear: rec.liftedByUnclear,
        flags: rec.flags,
        domain: rec.domain,
        decided_by: 'bot',
        human_tier: null,
        comment_gid: rec.commentGid,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'task_gid' },
    );
    if (error) throw new Error(`tier_classifications upsert failed: ${error.message}`);
  }

  /** Flag a task as human-overridden — the bot never touches it again. */
  async markOverride(taskGid: string, humanTier: string | null): Promise<void> {
    const { error } = await this.client
      .from('tier_classifications')
      .update({ decided_by: 'human_override', human_tier: humanTier, updated_at: new Date().toISOString() })
      .eq('task_gid', taskGid);
    if (error) throw new Error(`tier_classifications markOverride failed: ${error.message}`);
  }

  /** All rows created at or after `sinceIso` (for the weekly report). */
  async listSince(sinceIso: string): Promise<TierClassificationRecord[]> {
    const { data, error } = await this.client
      .from('tier_classifications')
      .select('*')
      .gte('created_at', sinceIso);
    if (error) throw new Error(`tier_classifications listSince failed: ${error.message}`);
    return (data ?? []).map(rowFromDb);
  }

  /** Human-override rows updated at or after `sinceIso` (report disagreements). */
  async listOverridesSince(sinceIso: string): Promise<TierClassificationRecord[]> {
    const { data, error } = await this.client
      .from('tier_classifications')
      .select('*')
      .eq('decided_by', 'human_override')
      .gte('updated_at', sinceIso);
    if (error) throw new Error(`tier_classifications listOverridesSince failed: ${error.message}`);
    return (data ?? []).map(rowFromDb);
  }
}
