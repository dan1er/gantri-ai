// End-to-end orchestrator test — runs Claude + Northbeam (via deployed Supabase)
// with a real user question, bypassing Slack. Used to catch tool-shape bugs
// without burning iterations in the live bot.
//
// Usage:
//   cd gantri-ai-bot && node scripts/test-orchestrator.mjs "your question"
//
// Env: reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY from process.env.

import Anthropic from '@anthropic-ai/sdk';
import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { ConnectorRegistry } from '../dist/connectors/base/registry.js';
import { NorthbeamConnector } from '../dist/connectors/northbeam/northbeam-connector.js';
import { ReportsConnector } from '../dist/connectors/reports/reports-connector.js';
import { Orchestrator } from '../dist/orchestrator/orchestrator.js';

const question = process.argv.slice(2).join(' ') || 'How much did we spend in Google Ads last week and what was the ROAS?';

const supabase = getSupabase();
const [email, password, dashboardId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_EMAIL'),
  readVaultSecret(supabase, 'NORTHBEAM_PASSWORD'),
  readVaultSecret(supabase, 'NORTHBEAM_DASHBOARD_ID'),
]);

const registry = new ConnectorRegistry();
registry.register(new NorthbeamConnector({ supabase, credentials: { email, password, dashboardId } }));
registry.register(new ReportsConnector());

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const orch = new Orchestrator({
  registry,
  claude,
  model: 'claude-sonnet-4-6',
  maxIterations: 6,
  maxOutputTokens: 16384,
});

console.log('Q:', question);
console.log('---');
const out = await orch.run({ question, threadHistory: [] });
console.log('RESPONSE:');
console.log(out.response);
console.log('---');
console.log(`model=${out.model} iters=${out.iterations} in=${out.tokensInput} out=${out.tokensOutput}`);
console.log(`toolCalls:`);
for (const tc of out.toolCalls) {
  console.log(`  ${tc.ok ? '✓' : '✗'} ${tc.name}${tc.errorMessage ? ' — ' + tc.errorMessage.slice(0, 200) : ''}`);
}
if (out.attachments?.length) {
  console.log(`attachments:`);
  for (const a of out.attachments) {
    console.log(`  📎 ${a.normalizedFilename} (${a.format}, ${a.content.length} bytes)${a.title ? ' — ' + a.title : ''}`);
  }
}
process.exit(0);
