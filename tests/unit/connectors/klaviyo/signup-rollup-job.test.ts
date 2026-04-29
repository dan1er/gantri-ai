import { describe, it, expect, vi } from 'vitest';
import { KlaviyoSignupRollupJob } from '../../../../src/connectors/klaviyo/signup-rollup-job.js';

function makeProfile(id: string, createdISO: string, consent?: string) {
  return {
    id,
    type: 'profile' as const,
    attributes: {
      created: createdISO,
      subscriptions: consent
        ? { email: { marketing: { consent } } }
        : null,
    },
  };
}

function makeStreamingClient(profiles: ReturnType<typeof makeProfile>[]) {
  return {
    streamProfilesByCreatedRange: vi.fn().mockImplementation(
      async (_opts: { startDate: string; endDate: string }, onItem: (p: unknown) => void) => {
        for (const p of profiles) onItem(p);
        return { pages: 1, items: profiles.length };
      },
    ),
  };
}

function makeRepo() {
  const upserts: Array<Array<{ day: string; signupsTotal: number; signupsConsentedEmail: number }>> = [];
  return {
    upserts,
    upsertManyDays: vi.fn(async (rows) => { upserts.push(rows); }),
    getRange: vi.fn(),
    latestDay: vi.fn(),
    count: vi.fn(),
  };
}

describe('KlaviyoSignupRollupJob', () => {
  it('counts SUBSCRIBED profiles as consented and others as total-only', async () => {
    const client = makeStreamingClient([
      makeProfile('1', '2026-01-15T20:00:00.000Z', 'SUBSCRIBED'),
      makeProfile('2', '2026-01-15T21:00:00.000Z', 'UNSUBSCRIBED'),
      makeProfile('3', '2026-01-15T22:00:00.000Z'),
    ]) as any;
    const repo = makeRepo();
    const job = new KlaviyoSignupRollupJob({ client, repo: repo as any });
    const result = await job.run();
    expect(result.profilesSeen).toBe(3);
    expect(repo.upsertManyDays).toHaveBeenCalledOnce();
    const rows = repo.upserts[0];
    const jan15 = rows.find((r) => r.day === '2026-01-15');
    expect(jan15).toEqual({ day: '2026-01-15', signupsTotal: 3, signupsConsentedEmail: 1 });
  });

  it('buckets by Pacific Time, not UTC', async () => {
    const client = makeStreamingClient([
      // 2026-01-01T05:00:00Z = 2025-12-31 21:00 PT (Dec 31 PT bucket)
      makeProfile('1', '2026-01-01T05:00:00.000Z', 'SUBSCRIBED'),
    ]) as any;
    const repo = makeRepo();
    const job = new KlaviyoSignupRollupJob({ client, repo: repo as any });
    await job.run();
    const rows = repo.upserts[0];
    expect(rows[0].day).toBe('2025-12-31');
  });

  it('skips profiles with malformed `created`', async () => {
    const client = {
      streamProfilesByCreatedRange: vi.fn().mockImplementation(
        async (_opts: any, onItem: (p: unknown) => void) => {
          onItem({ id: '1', type: 'profile', attributes: { created: 'not-a-date' } });
          onItem(makeProfile('2', '2026-01-15T20:00:00.000Z', 'SUBSCRIBED'));
          return { pages: 1, items: 2 };
        },
      ),
    } as any;
    const repo = makeRepo();
    const job = new KlaviyoSignupRollupJob({ client, repo: repo as any });
    const result = await job.run();
    expect(result.profilesSeen).toBe(2);
    const rows = repo.upserts[0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ day: '2026-01-15', signupsTotal: 1, signupsConsentedEmail: 1 });
  });

  it('absorbs unsubscribe drift on re-run', async () => {
    const repo = makeRepo();

    const client1 = makeStreamingClient([makeProfile('1', '2026-01-15T20:00:00.000Z', 'SUBSCRIBED')]) as any;
    const job1 = new KlaviyoSignupRollupJob({ client: client1, repo: repo as any });
    await job1.run();
    expect(repo.upserts[0][0].signupsConsentedEmail).toBe(1);

    const client2 = makeStreamingClient([makeProfile('1', '2026-01-15T20:00:00.000Z', 'UNSUBSCRIBED')]) as any;
    const job2 = new KlaviyoSignupRollupJob({ client: client2, repo: repo as any });
    await job2.run();
    expect(repo.upserts[1][0].signupsConsentedEmail).toBe(0);
  });

  it('returns zeros and logs error when client throws (does not crash)', async () => {
    const client = {
      streamProfilesByCreatedRange: vi.fn().mockRejectedValue(new Error('rate limited')),
    } as any;
    const repo = makeRepo();
    const job = new KlaviyoSignupRollupJob({ client, repo: repo as any });
    const result = await job.run();
    expect(result).toEqual({ daysWritten: 0, profilesSeen: 0 });
    expect(repo.upsertManyDays).not.toHaveBeenCalled();
  });

  it('serializes overlapping run() calls (second returns 0)', async () => {
    let resolveFirst: () => void = () => {};
    const client = {
      streamProfilesByCreatedRange: vi.fn().mockImplementation(
        (_opts: any, onItem: (p: unknown) => void) => new Promise((resolve) => {
          resolveFirst = () => {
            onItem(makeProfile('1', '2026-01-15T20:00:00.000Z', 'SUBSCRIBED'));
            resolve({ pages: 1, items: 1 });
          };
        }),
      ),
    } as any;
    const repo = makeRepo();
    const job = new KlaviyoSignupRollupJob({ client, repo: repo as any });
    const p1 = job.run();
    const p2 = job.run();
    resolveFirst();
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.profilesSeen).toBe(1);
    expect(r2.profilesSeen).toBe(0);
  });
});
