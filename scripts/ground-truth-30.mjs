// Compute ground-truth answers for the most numerically-grounded questions
// in the 30-question set. Used to validate the bot's responses against
// independent NB API calls.
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);
const nb = new NorthbeamApiClient({ apiKey, dataClientId });

const fmt = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

// Today is 2026-04-26. "Last 7 days" inclusive = Apr 19-25. "Last 30 days" = Mar 27-Apr 25.
const today = '2026-04-26';
const yesterday = '2026-04-25';
const last7Start = '2026-04-19', last7End = '2026-04-25';
const last30Start = '2026-03-27', last30End = '2026-04-25';
const last90Start = '2026-01-26', last90End = '2026-04-25';
const monthStart = '2026-04-01', monthEnd = '2026-04-26';
const ytdStart = '2026-01-01', ytdEnd = today;
const q1Start = '2026-01-01', q1End = '2026-03-31';
const febStart = '2026-02-01', febEnd = '2026-02-28';
const marStart = '2026-03-01', marEnd = '2026-03-31';

async function exportPlatform(opts) {
  const breakdown = opts.platform ? { key: 'Platform (Northbeam)', values: opts.platform } : undefined;
  return nb.runExport({
    level: opts.level ?? 'platform',
    time_granularity: opts.granularity ?? 'DAILY',
    period_type: 'FIXED',
    period_options: { period_starting_at: `${opts.start}T00:00:00.000Z`, period_ending_at: `${opts.end}T23:59:59.999Z` },
    breakdowns: breakdown ? [breakdown] : (opts.allPlatforms ? [{ key: 'Platform (Northbeam)', values: await listPlatforms() }] : []),
    options: { export_aggregation: opts.bucketByDate ? 'DATE' : 'BREAKDOWN', remove_zero_spend: false, aggregate_data: opts.aggregateData ?? true, include_ids: false },
    attribution_options: { attribution_models: [opts.model ?? 'northbeam_custom__va'], accounting_modes: ['cash'], attribution_windows: ['1'] },
    metrics: opts.metrics.map((id) => ({ id })),
  }, { timeoutMs: 180_000 });
}

let _platforms;
async function listPlatforms() {
  if (_platforms) return _platforms;
  const bds = await nb.listBreakdowns();
  _platforms = bds.find((b) => b.key === 'Platform (Northbeam)').values;
  return _platforms;
}

function pickPrimary(rows) {
  // Pick rows with Cash snapshot only — NB returns mode×window expansion otherwise.
  return rows.filter((r) => !r.accounting_mode || r.accounting_mode === 'Cash snapshot');
}

function sumByGroup(rows, groupCol, valueCol) {
  const m = new Map();
  for (const r of pickPrimary(rows)) {
    const k = r[groupCol] ?? '';
    m.set(k, (m.get(k) ?? 0) + Number(r[valueCol] || 0));
  }
  return m;
}

console.log(`\n--- GROUND TRUTH (today=${today}) ---\n`);

// Q1: spend Meta + Google last week
{
  const csv = await exportPlatform({ start: last7Start, end: last7End, metrics: ['spend'], platform: ['Facebook Ads', 'Google Ads'] });
  const sums = sumByGroup(csv.rows, 'breakdown_platform_northbeam', 'spend');
  console.log(`Q1: Meta+Google spend ${last7Start}→${last7End}:`);
  console.log(`   Meta:   ${fmt(sums.get('Facebook Ads') ?? 0)}`);
  console.log(`   Google: ${fmt(sums.get('Google Ads') ?? 0)}`);
}

// Q2: ROAS by channel last 30d
{
  const csv = await exportPlatform({ start: last30Start, end: last30End, metrics: ['rev', 'spend'], allPlatforms: true });
  const revs = sumByGroup(csv.rows, 'breakdown_platform_northbeam', 'rev');
  const spends = sumByGroup(csv.rows, 'breakdown_platform_northbeam', 'spend');
  console.log(`\nQ2: ROAS by channel ${last30Start}→${last30End} (only spend>$10):`);
  const ranked = [...spends.keys()].filter((k) => spends.get(k) > 10).map((k) => ({
    channel: k, spend: spends.get(k), rev: revs.get(k) ?? 0, roas: (revs.get(k) ?? 0) / spends.get(k),
  })).sort((a, b) => b.roas - a.roas);
  for (const r of ranked) console.log(`   ${r.channel.padEnd(25)} spend=${fmt(r.spend).padStart(10)} rev=${fmt(r.rev).padStart(12)} ROAS=${r.roas.toFixed(2)}`);
}

// Q5: total spend YTD
{
  const csv = await exportPlatform({ start: ytdStart, end: ytdEnd, metrics: ['spend'], allPlatforms: true });
  const total = pickPrimary(csv.rows).reduce((a, r) => a + Number(r.spend || 0), 0);
  console.log(`\nQ5: Total paid-media spend YTD (${ytdStart}→${ytdEnd}): ${fmt(total)}`);
}

// Q6: day with max spend Q1
{
  const csv = await exportPlatform({ start: q1Start, end: q1End, metrics: ['spend'], bucketByDate: true });
  const days = [...pickPrimary(csv.rows)].map((r) => ({ date: r.date, spend: Number(r.spend || 0) }))
    .sort((a, b) => b.spend - a.spend);
  console.log(`\nQ6: Top 5 spend days in Q1 2026:`);
  for (const d of days.slice(0, 5)) console.log(`   ${d.date}: ${fmt(d.spend)}`);
}

// Q10: Email revenue this month
{
  const csv = await exportPlatform({ start: monthStart, end: monthEnd, metrics: ['rev'], platform: ['Klaviyo', 'Other Email', 'Transactional', 'Yotpo'] });
  const total = pickPrimary(csv.rows).reduce((a, r) => a + Number(r.rev || 0), 0);
  console.log(`\nQ10: NB-attributed Email revenue (${monthStart}→${monthEnd}): ${fmt(total)}`);
  const byCh = sumByGroup(csv.rows, 'breakdown_platform_northbeam', 'rev');
  for (const [ch, v] of byCh) console.log(`   ${ch}: ${fmt(v)}`);
}

// Q11: daily revenue last week
{
  const csv = await exportPlatform({ start: last7Start, end: last7End, metrics: ['rev'], bucketByDate: true });
  const byDay = new Map();
  for (const r of pickPrimary(csv.rows)) byDay.set(r.date, (byDay.get(r.date) ?? 0) + Number(r.rev || 0));
  console.log(`\nQ11: NB-attributed daily rev ${last7Start}→${last7End}:`);
  for (const k of [...byDay.keys()].sort()) console.log(`   ${k}: ${fmt(byDay.get(k))}`);
}

// Q16: orders yesterday in NB
{
  const orders = await nb.listOrders({ startDate: yesterday, endDate: yesterday });
  const real = orders.filter((o) => !o.is_cancelled && !o.is_deleted);
  console.log(`\nQ16: NB orders ${yesterday}: ${real.length} (${orders.length - real.length} cancelled/deleted excluded)`);
}

// Q17: daily NB order breakdown last week
{
  const orders = await nb.listOrders({ startDate: last7Start, endDate: last7End });
  const byDay = new Map();
  for (const o of orders) {
    if (o.is_cancelled || o.is_deleted) continue;
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(o.time_of_purchase));
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  console.log(`\nQ17: NB daily order counts ${last7Start}→${last7End}:`);
  for (const k of [...byDay.keys()].sort()) console.log(`   ${k}: ${byDay.get(k)}`);
}

// Q18: orders Feb vs Mar
{
  const fb = await nb.listOrders({ startDate: febStart, endDate: febEnd });
  const mr = await nb.listOrders({ startDate: marStart, endDate: marEnd });
  const fbReal = fb.filter((o) => !o.is_cancelled && !o.is_deleted).length;
  const mrReal = mr.filter((o) => !o.is_cancelled && !o.is_deleted).length;
  console.log(`\nQ18: NB orders Feb=${fbReal}, Mar=${mrReal}`);
}

// Q21: CAC new Meta vs Google last 7d
{
  const csv = await exportPlatform({ start: last7Start, end: last7End, metrics: ['cac', 'cacFt', 'spend'], platform: ['Facebook Ads', 'Google Ads'] });
  console.log(`\nQ21: CAC ${last7Start}→${last7End}:`);
  for (const r of pickPrimary(csv.rows)) {
    console.log(`   ${r.breakdown_platform_northbeam.padEnd(15)} cac=${r.cac || '-'} cacFt=${r.cac_1st_time || '-'}`);
  }
}

console.log('\n--- DONE ---');
