import { getSupabase, readVaultSecret } from '../dist/storage/supabase.js';
import { NorthbeamApiConnector } from '../dist/connectors/northbeam-api/connector.js';
import { NorthbeamApiClient } from '../dist/connectors/northbeam-api/client.js';

const supabase = getSupabase();
const [apiKey, dataClientId] = await Promise.all([
  readVaultSecret(supabase, 'NORTHBEAM_API_KEY'),
  readVaultSecret(supabase, 'NORTHBEAM_DATA_CLIENT_ID'),
]);

// 1) Direct client call
const client = new NorthbeamApiClient({ apiKey, dataClientId });
const t0 = Date.now();
const direct = await client.listOrders({ startDate: '2026-02-01', endDate: '2026-02-28' });
console.log(`client.listOrders: ${Date.now() - t0}ms, returned ${direct.length} orders`);
if (direct.length > 0) console.log('first order:', { order_id: direct[0].order_id, time: direct[0].time_of_purchase, cancelled: direct[0].is_cancelled, deleted: direct[0].is_deleted });

// 2) Via the connector tool
const conn = new NorthbeamApiConnector({ apiKey, dataClientId });
const tool = conn.tools.find((t) => t.name === 'northbeam.list_orders');
const r = await tool.execute({ dateRange: { startDate: '2026-02-01', endDate: '2026-02-28' }, includeCancelled: false });
console.log('tool result:', { count: r.count, totalReturned: r.totalReturned, cancelledOrDeletedExcluded: r.cancelledOrDeletedExcluded, source: r.source });
if (r.error) console.log('error:', r.error);
