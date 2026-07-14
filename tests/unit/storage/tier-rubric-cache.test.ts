import { describe, it, expect, vi } from 'vitest';
import { TierRubricCacheRepo } from '../../../src/storage/repositories/tier-rubric-cache.js';

// Minimal fake Supabase client:
//   from().upsert(...)                             -> { error }
//   from().select('*').eq('id', 1).maybeSingle()  -> { data, error }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFake(getRow: any) {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const maybeSingle = vi.fn().mockResolvedValue({ data: getRow, error: null });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ upsert, select }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, upsert, eq };
}

describe('TierRubricCacheRepo', () => {
  it('get maps the single row to camelCase', async () => {
    const { client, eq } = makeFake({ id: 1, page_text: 'body', version: 4, hash: 'abc' });
    const row = await new TierRubricCacheRepo(client).get();
    expect(eq).toHaveBeenCalledWith('id', 1);
    expect(row).toEqual({ pageText: 'body', version: 4, hash: 'abc' });
  });

  it('get returns null when nothing is cached', async () => {
    const { client } = makeFake(null);
    expect(await new TierRubricCacheRepo(client).get()).toBeNull();
  });

  it('put upserts the fixed id=1 row with snake_case columns', async () => {
    const { client, upsert } = makeFake(null);
    await new TierRubricCacheRepo(client).put({ pageText: 'body', version: 4, hash: 'abc' });
    expect(upsert).toHaveBeenCalledTimes(1);
    const [payload, opts] = upsert.mock.calls[0];
    expect(payload).toMatchObject({ id: 1, page_text: 'body', version: 4, hash: 'abc' });
    expect(payload.fetched_at).toEqual(expect.any(String));
    expect(opts).toEqual({ onConflict: 'id' });
  });
});
