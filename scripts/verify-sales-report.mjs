// Confirm the new gantri.sales_report tool produces the same numbers as
// Grafana's panel SQL run live.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';
import { SalesReportConnector } from '../dist/connectors/sales-report/sales-report-connector.js';

const supabase = getSupabase();
const [grafanaUrl, grafanaToken, grafanaPgUid] = await Promise.all([
  readVaultSecret(supabase, 'GRAFANA_URL'),
  readVaultSecret(supabase, 'GRAFANA_TOKEN'),
  readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
]);
const grafana = new GrafanaConnector({ baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid });
const conn = new SalesReportConnector({ grafana });
const tool = conn.tools.find((t) => t.name === 'gantri.sales_report');

const t0 = Date.now();
const r = await tool.execute({ dateRange: { startDate: '2024-01-01', endDate: '2026-04-23' } });
console.log(`elapsed: ${Date.now() - t0}ms`);
console.log(`period: ${r.period.startDate} → ${r.period.endDate}, source: ${r.source}`);
console.log('\nType                    Orders    Subtotal       Full Total');
for (const row of r.rows) {
  console.log(
    `${row.type.padEnd(22)} ${String(row.orders).padStart(6)} ${('$' + row.subtotalDollars.toFixed(2)).padStart(14)} ${('$' + row.fullTotalDollars.toFixed(2)).padStart(16)}`,
  );
}
