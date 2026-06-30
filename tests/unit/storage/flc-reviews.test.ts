import { describe, it, expect, vi } from 'vitest';
import { FlcReviewsRepo } from '../../../src/storage/repositories/flc-reviews.js';

// Minimal fake Supabase client covering the query shapes the repo uses:
//   from().upsert(...)                      -> { error }
//   from().select('*').eq(...).maybeSingle() -> { data, error }
//   from().delete().eq(...)                 -> { error }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFake(getRow: any) {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const maybeSingle = vi.fn().mockResolvedValue({ data: getRow, error: null });
  const selectEq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq: selectEq }));
  const eqDelete = vi.fn().mockResolvedValue({ error: null });
  const del = vi.fn(() => ({ eq: eqDelete }));
  const from = vi.fn(() => ({ upsert, select, delete: del }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, upsert, selectEq, eqDelete, from };
}

describe('FlcReviewsRepo', () => {
  it('save upserts snake_case columns', async () => {
    const { client, upsert } = makeFake(null);
    await new FlcReviewsRepo(client).save({
      messageTs: '1.2',
      channel: 'C',
      pageId: 'p',
      url: 'u',
      findings: [],
    });
    expect(upsert).toHaveBeenCalledWith({
      message_ts: '1.2',
      channel: 'C',
      page_id: 'p',
      url: 'u',
      findings: [],
    });
  });

  it('get maps a db row to camelCase', async () => {
    const { client } = makeFake({
      message_ts: '1.2',
      channel: 'C',
      page_id: 'p',
      url: 'u',
      findings: [{ id: 'F1' }],
    });
    const rec = await new FlcReviewsRepo(client).get('1.2');
    expect(rec).toEqual({
      messageTs: '1.2',
      channel: 'C',
      pageId: 'p',
      url: 'u',
      findings: [{ id: 'F1' }],
    });
  });

  it('get returns null when there is no row', async () => {
    const { client } = makeFake(null);
    expect(await new FlcReviewsRepo(client).get('missing')).toBeNull();
  });

  it('delete removes by message_ts', async () => {
    const { client, eqDelete } = makeFake(null);
    await new FlcReviewsRepo(client).delete('1.2');
    expect(eqDelete).toHaveBeenCalledWith('message_ts', '1.2');
  });
});
