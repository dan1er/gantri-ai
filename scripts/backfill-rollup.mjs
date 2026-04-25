// One-shot backfill: re-run RollupRefreshJob.refreshWindow(720) to overwrite all
// historical rows after fixing the discount-subtraction bug. Run on Fly so it
// inherits the env vars.
import { getSupabase } from '../dist/storage/supabase.js';
import { readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';
import { RollupRepo } from '../dist/storage/rollup-repo.js';
import { RollupRefreshJob } from '../dist/connectors/rollup/rollup-refresh.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);

const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });
const repo = new RollupRepo(supabase);
const job = new RollupRefreshJob({ grafana, repo });

const days = Number(process.argv[2] || 720);
console.log(`backfilling last ${days} days…`);
const t0 = Date.now();
const { daysWritten } = await job.refreshWindow(days);
console.log(`done in ${Date.now() - t0}ms, days written: ${daysWritten}`);
