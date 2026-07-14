import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Dedupe ledger for the v2 PR re-check. One row per `(repo, pr_number, head_sha)`
 * so a given commit of a PR is only re-evaluated once — a new push (new head sha)
 * gets a fresh check. See `migrations/0036_tier_classifications.sql`.
 */
export type TierPrCheckVerdict = 'consistent' | 'raise' | 'no_ticket' | 'not_classified';

export interface TierPrCheckInsert {
  repo: string;
  prNumber: number;
  headSha: string;
  taskGid: string | null;
  verdict: TierPrCheckVerdict;
  suggestedTier: string | null;
  commented: boolean;
}

export class TierPrChecksRepo {
  constructor(private readonly client: SupabaseClient) {}

  /** True when this exact `(repo, pr, head_sha)` has already been evaluated. */
  async exists(repo: string, prNumber: number, headSha: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('tier_pr_checks')
      .select('repo')
      .eq('repo', repo)
      .eq('pr_number', prNumber)
      .eq('head_sha', headSha)
      .maybeSingle();
    if (error) throw new Error(`tier_pr_checks exists failed: ${error.message}`);
    return data !== null;
  }

  /** Record the verdict for a PR commit. Upsert on the composite key so a racing
   *  double-check is a no-op rather than a duplicate-key error. */
  async insert(rec: TierPrCheckInsert): Promise<void> {
    const { error } = await this.client.from('tier_pr_checks').upsert(
      {
        repo: rec.repo,
        pr_number: rec.prNumber,
        head_sha: rec.headSha,
        task_gid: rec.taskGid,
        verdict: rec.verdict,
        suggested_tier: rec.suggestedTier,
        commented: rec.commented,
      },
      { onConflict: 'repo,pr_number,head_sha' },
    );
    if (error) throw new Error(`tier_pr_checks insert failed: ${error.message}`);
  }
}
