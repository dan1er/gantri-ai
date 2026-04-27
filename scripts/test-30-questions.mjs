// Run all 30 NB-related questions through the live orchestrator (no Slack)
// using the SAME registry we wire up in src/index.ts. Captures response,
// tool calls, errors. Throttles between questions to respect NB's 60/min cap.
//
// Usage:
//   node scripts/test-30-questions.mjs            # run all 30
//   node scripts/test-30-questions.mjs --only 6   # run only Q6
//   node scripts/test-30-questions.mjs --from 15  # resume from Q15

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { ConnectorRegistry } from '../dist/connectors/base/registry.js';
import { CachingRegistry } from '../dist/connectors/base/caching-registry.js';
import { DEFAULT_CACHE_POLICIES } from '../dist/connectors/base/default-policies.js';
import { TtlCache } from '../dist/storage/cache.js';
import { NorthbeamApiConnector } from '../dist/connectors/northbeam-api/connector.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';
import { MarketingAnalysisConnector } from '../dist/connectors/marketing-analysis/connector.js';
import { GantriPorterConnector } from '../dist/connectors/gantri-porter/gantri-porter-connector.js';
import { GrafanaConnector } from '../dist/connectors/grafana/grafana-connector.js';
import { SalesReportConnector } from '../dist/connectors/sales-report/sales-report-connector.js';
import { LateOrdersConnector } from '../dist/connectors/late-orders/late-orders-connector.js';
import { RollupRepo } from '../dist/storage/rollup-repo.js';
import { Orchestrator } from '../dist/orchestrator/orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUESTIONS = [
  // Spend & ROAS
  { n: 1, cat: 'Spend & ROAS', q: '¿Cuánto gastamos en Meta y Google la semana pasada?' },
  { n: 2, cat: 'Spend & ROAS', q: '¿Cuál es nuestro ROAS por canal en los últimos 30 días?' },
  { n: 3, cat: 'Spend & ROAS', q: '¿En qué canal tenemos el mejor ROAS este mes?' },
  { n: 4, cat: 'Spend & ROAS', q: '¿Cómo se compara el ROAS de Meta nativo vs el ROAS atribuido por Northbeam?' },
  { n: 5, cat: 'Spend & ROAS', q: '¿Cuánto gastamos en total en paid media este año?' },
  { n: 6, cat: 'Spend & ROAS', q: '¿Cuál fue el día con mayor spend en Q1 2026?' },
  // Revenue
  { n: 7, cat: 'Revenue', q: '¿Cuál es el revenue atribuido por canal en los últimos 7 días?' },
  { n: 8, cat: 'Revenue', q: '¿Qué canal generó más revenue atribuido en marzo?' },
  { n: 9, cat: 'Revenue', q: '¿Cómo se distribuye el revenue entre Forecast channels (Meta, Google, Email, Organic, etc.)?' },
  { n: 10, cat: 'Revenue', q: '¿Cuánto revenue atribuyó Northbeam a Email este mes?' },
  { n: 11, cat: 'Revenue', q: '¿Cómo fue el revenue diario atribuido la semana pasada?' },
  // Atribución
  { n: 12, cat: 'Atribución', q: '¿Cómo cambia el ROAS de Google si uso last-touch vs linear vs Northbeam custom?' },
  { n: 13, cat: 'Atribución', q: '¿Qué canales están sobrevaluados bajo last-click comparado con el modelo de Northbeam?' },
  { n: 14, cat: 'Atribución', q: '¿Cuál es la diferencia en revenue atribuido entre first-touch y Clicks + Modeled Views?' },
  { n: 15, cat: 'Atribución', q: '¿Qué tan estable es el ranking de canales entre los 7 modelos de atribución?' },
  // Órdenes
  { n: 16, cat: 'Órdenes', q: '¿Cuántas órdenes atribuyó Northbeam ayer?' },
  { n: 17, cat: 'Órdenes', q: '¿Cuál fue el desglose diario de órdenes en NB la última semana?' },
  { n: 18, cat: 'Órdenes', q: '¿Cuántas órdenes tuvimos en NB en febrero vs marzo?' },
  { n: 19, cat: 'Órdenes', q: '¿Cómo se comparan las órdenes de Northbeam vs Porter día a día este mes?' },
  // New vs Returning
  { n: 20, cat: 'New vs Returning', q: '¿Qué porcentaje del revenue viene de clientes nuevos vs recurrentes por canal?' },
  { n: 21, cat: 'New vs Returning', q: '¿Cuál es el CAC de clientes nuevos en Meta vs Google?' },
  { n: 22, cat: 'New vs Returning', q: '¿Estamos pagando para reactivar clientes que ya teníamos en Email u Organic?' },
  { n: 23, cat: 'New vs Returning', q: '¿Cuál es el AOV de clientes nuevos vs recurrentes esta semana?' },
  // LTV & CAC
  { n: 24, cat: 'LTV & CAC', q: '¿Cuál es el ratio LTV/CAC por canal en los últimos 90 días?' },
  { n: 25, cat: 'LTV & CAC', q: '¿Qué canal trae clientes de mayor calidad (LTV más alto)?' },
  { n: 26, cat: 'LTV & CAC', q: '¿Cuál es el CAC proyectado por canal este trimestre?' },
  // Campañas
  { n: 27, cat: 'Campañas', q: '¿Cuáles son las top 10 campañas por revenue atribuido este mes?' },
  { n: 28, cat: 'Campañas', q: '¿Qué campañas tienen el ROAS marginal más bajo? (para decidir cortes de presupuesto)' },
  { n: 29, cat: 'Campañas', q: '¿Cuál fue la campaña más eficiente en Q1 2026?' },
  { n: 30, cat: 'Campañas', q: 'Si tuviera que cortar 20% del presupuesto de Meta, ¿qué campañas cortarías primero?' },
  // GA4 — only fire when user explicitly mentions it
  { n: 31, cat: 'GA4', q: '¿Cuántas sesiones tuvimos en GA4 los últimos 7 días?' },
  { n: 32, cat: 'GA4', q: 'Top 10 landing pages por sesiones la semana pasada en Google Analytics' },
  { n: 33, cat: 'GA4', q: '¿Cuántos usuarios activos hay en el sitio ahora mismo?' },
  // Routing-canary: this should still fire NB, NOT GA4 (no GA4 trigger words)
  { n: 34, cat: 'Routing canary (must use NB)', q: '¿Qué canal generó más revenue atribuido la semana pasada?' },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only') opts.only = Number(args[++i]);
    else if (args[i] === '--from') opts.from = Number(args[++i]);
    else if (args[i] === '--to') opts.to = Number(args[++i]);
    else if (args[i] === '--qs') opts.qs = args[++i].split(',').map(Number);
    else if (args[i] === '--out') opts.out = args[++i];
  }
  return opts;
}

const opts = parseArgs();
const outFile = opts.out ?? path.join(__dirname, '..', '.test-30-results.json');

async function main() {
  const supabase = getSupabase();
  const [
    nbApiKey, nbDataClientId,
    porterUrl, porterEmail, porterPw,
    grafanaUrl, grafanaToken, grafanaPgUid,
  ] = await Promise.all([
    readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
    readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
    readVaultSecret(supabase, 'PORTER_API_BASE_URL'),
    readVaultSecret(supabase, 'PORTER_BOT_EMAIL'),
    readVaultSecret(supabase, 'PORTER_BOT_PASSWORD'),
    readVaultSecret(supabase, 'GRAFANA_URL'),
    readVaultSecret(supabase, 'GRAFANA_TOKEN'),
    readVaultSecret(supabase, 'GRAFANA_POSTGRES_DS_UID'),
  ]);

  const registry = new ConnectorRegistry();
  registry.register(new NorthbeamApiConnector({ apiKey: nbApiKey, dataClientId: nbDataClientId }));

  const rollupRepo = new RollupRepo(supabase);
  registry.register(new GantriPorterConnector({
    baseUrl: porterUrl, email: porterEmail, password: porterPw, rollupRepo,
  }));
  const grafana = new GrafanaConnector({
    baseUrl: grafanaUrl, token: grafanaToken, postgresDsUid: grafanaPgUid,
  });
  registry.register(grafana);

  const nbClient = new NorthbeamApiClient({ apiKey: nbApiKey, dataClientId: nbDataClientId });
  registry.register(new SalesReportConnector({ grafana, nb: nbClient }));
  registry.register(new MarketingAnalysisConnector({ nb: nbClient }));
  registry.register(new LateOrdersConnector({ grafana }));

  // Caching wrapper (matches index.ts setup)
  const cache = new TtlCache(supabase);
  const cachingRegistry = new CachingRegistry(registry, cache, DEFAULT_CACHE_POLICIES);

  const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const orch = new Orchestrator({
    registry: cachingRegistry,
    claude,
    model: 'claude-sonnet-4-6',
    maxIterations: 8,
    maxOutputTokens: 16384,
  });

  // Filter set
  let toRun = QUESTIONS;
  if (opts.only) toRun = QUESTIONS.filter((q) => q.n === opts.only);
  if (opts.qs) toRun = QUESTIONS.filter((q) => opts.qs.includes(q.n));
  if (opts.from) toRun = toRun.filter((q) => q.n >= opts.from);
  if (opts.to) toRun = toRun.filter((q) => q.n <= opts.to);

  // Load prior results so we can resume + only re-run a subset
  let priorResults = {};
  try {
    if (fs.existsSync(outFile)) {
      const prior = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      for (const r of prior.results ?? []) priorResults[r.n] = r;
    }
  } catch {}

  const results = QUESTIONS.map((q) => priorResults[q.n] ?? null).filter(Boolean);
  const startedAt = new Date().toISOString();

  for (const q of toRun) {
    const t0 = Date.now();
    console.log(`\n=== Q${q.n} (${q.cat}) ===`);
    console.log(`Q: ${q.q}`);
    let resultEntry = { n: q.n, cat: q.cat, q: q.q };
    try {
      const out = await orch.run({ question: q.q, threadHistory: [] });
      const elapsedMs = Date.now() - t0;
      resultEntry = {
        ...resultEntry,
        response: out.response,
        toolCalls: (out.toolCalls ?? []).map((tc) => ({
          name: tc.name,
          args: tc.args,
          ok: tc.ok,
          errorMessage: tc.errorMessage ?? null,
        })),
        iterations: out.iterations,
        tokensIn: out.tokensInput,
        tokensOut: out.tokensOutput,
        elapsedMs,
        ok: true,
      };
      console.log(`✓ ${(elapsedMs / 1000).toFixed(1)}s, iters=${out.iterations}, tools=${(out.toolCalls ?? []).map((tc) => tc.name).join(',')}`);
      console.log(`  RESPONSE: ${out.response.slice(0, 280)}${out.response.length > 280 ? '…' : ''}`);
    } catch (err) {
      const elapsedMs = Date.now() - t0;
      resultEntry = {
        ...resultEntry,
        error: err instanceof Error ? err.message : String(err),
        elapsedMs,
        ok: false,
      };
      console.log(`✗ ${(elapsedMs / 1000).toFixed(1)}s, ERROR: ${resultEntry.error.slice(0, 200)}`);
    }
    // Update results in place (replace prior entry with same n)
    const idx = results.findIndex((r) => r.n === q.n);
    if (idx >= 0) results[idx] = resultEntry;
    else results.push(resultEntry);

    // Persist after each question so we can resume on crash / interrupt
    results.sort((a, b) => a.n - b.n);
    fs.writeFileSync(outFile, JSON.stringify({ startedAt, completedAt: null, results }, null, 2));

    // Throttle for NB rate limit (60/min). Each question makes 1-3 NB calls.
    // ~3s between questions keeps us comfortably under the cap.
    await new Promise((r) => setTimeout(r, 3000));
  }

  results.sort((a, b) => a.n - b.n);
  fs.writeFileSync(outFile, JSON.stringify({ startedAt, completedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nResults saved to ${outFile}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
