import { describe, it, expect, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
  computeWeeklyReport,
  renderWeeklyReport,
  nyWeekStart,
  isAfterMonday9am,
  WeeklyTierReporter,
  type WeeklyReportInputs,
} from '../../../../../src/connectors/asana/tier/weekly-report.js';
import type { AsanaApiClient } from '../../../../../src/connectors/asana/client.js';
import type { TierClassificationsRepo, TierClassificationRecord } from '../../../../../src/storage/repositories/tier-classifications.js';
import type { TierWeeklyReportsRepo } from '../../../../../src/storage/repositories/tier-weekly-reports.js';
import type { TierPrChecksRepo } from '../../../../../src/storage/repositories/tier-pr-checks.js';

const NOW = new Date('2026-07-15T15:00:00Z'); // Wed afternoon (NY), same week as Mon 2026-07-13.

function rec(o: Partial<TierClassificationRecord>): TierClassificationRecord {
  return {
    taskGid: o.taskGid ?? 'g',
    inputHash: 'h',
    promptVersion: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    facts: {} as any,
    tier: o.tier ?? 'T0',
    confirmedTier: o.confirmedTier ?? o.tier ?? 'T0',
    liftedByUnclear: o.liftedByUnclear ?? false,
    calibrationMismatch: o.calibrationMismatch ?? false,
    stage: o.stage ?? 'provisional',
    flags: [],
    domain: o.domain ?? 'unknown',
    decidedBy: o.decidedBy ?? 'bot',
    humanTier: o.humanTier ?? null,
    commentGid: null,
    reviewRequested: o.reviewRequested ?? false,
    createdAt: o.createdAt ?? '2026-07-14T00:00:00Z',
    updatedAt: o.updatedAt ?? '2026-07-14T00:00:00Z',
  };
}

describe('date helpers', () => {
  it('nyWeekStart returns the Monday of the current NY week', () => {
    expect(nyWeekStart(NOW)).toBe('2026-07-13');
  });
  it('isAfterMonday9am is false Monday before 9am NY, true otherwise', () => {
    expect(isAfterMonday9am(new Date('2026-07-13T12:00:00Z'))).toBe(false); // Mon 08:00 NY
    expect(isAfterMonday9am(new Date('2026-07-13T13:30:00Z'))).toBe(true); // Mon 09:30 NY
    expect(isAfterMonday9am(NOW)).toBe(true);
  });
});

describe('computeWeeklyReport', () => {
  const inputs: WeeklyReportInputs = {
    classificationsLast30d: [
      // shopping_checkout: one ticket below T2 → drives Move up (it has an escape).
      rec({ taskGid: 's1', domain: 'shopping_checkout', tier: 'T1' }),
      // content_marketing: 3 clean T2 tickets, no escape → drives Move down.
      rec({ taskGid: 'c1', domain: 'content_marketing', tier: 'T2' }),
      rec({ taskGid: 'c2', domain: 'content_marketing', tier: 'T2' }),
      rec({ taskGid: 'c3', domain: 'content_marketing', tier: 'T2' }),
      // design_workflow: 2 tickets, 1 lifted → 50% inconclusive (flagged > 30%).
      rec({ taskGid: 'd1', domain: 'design_workflow', tier: 'T1', liftedByUnclear: true }),
      // One calibration mismatch this week.
      rec({ taskGid: 'd2', domain: 'design_workflow', tier: 'T0', calibrationMismatch: true }),
    ],
    escapeTasksLast30d: [{ gid: 'e1', domain: 'shopping_checkout' }],
    overridesLast7d: [rec({ taskGid: 'ov1', domain: 'shopping_checkout', tier: 'T0', humanTier: 'T2', decidedBy: 'human_override' })],
    // The three content_marketing T2 tickets have shipped → they count toward move-down.
    completedTaskGids: ['c1', 'c2', 'c3'],
    authoritativeLast7d: { confirmed: 3, superseded: 1 },
  };

  const payload = computeWeeklyReport(inputs, NOW);

  it('reports the correct week', () => {
    expect(payload.weekStart).toBe('2026-07-13');
  });

  it('Move up: a domain with an escape and recent tickets below T2', () => {
    expect(payload.moveUp).toEqual([{ domain: 'shopping_checkout', escapes: 1, ticketsBelowT2: 1 }]);
  });

  it('Move down: a domain with ≥3 clean COMPLETED T2 tickets and zero escapes', () => {
    expect(payload.moveDown).toEqual([{ domain: 'content_marketing', from: 'T2', to: 'T1', cleanTickets: 3 }]);
  });

  it('Move down: does NOT fire when the T2 tickets are still open (never QA-cleared)', () => {
    const openPayload = computeWeeklyReport({ ...inputs, completedTaskGids: [] }, NOW);
    expect(openPayload.moveDown).toEqual([]);
  });

  it('Disagreements: last-7d human overrides', () => {
    expect(payload.disagreements).toEqual([{ taskGid: 'ov1', botTier: 'T0', humanTier: 'T2' }]);
  });

  it('Inconclusive: domains over 30% lifted-by-unclear in 7d', () => {
    expect(payload.inconclusive).toEqual([{ domain: 'design_workflow', ratePct: 50, lifted: 1, total: 2 }]);
  });

  it('Volume: counts bot classifications from the last 7d', () => {
    expect(payload.volume.classified7d).toBe(6);
    expect(payload.volume.approxTokens).toBe(6 * 4300);
  });

  it('Provisional → authoritative: change rate over 7d', () => {
    expect(payload.authoritative).toEqual({ confirmed: 3, superseded: 1, total: 4, changeRatePct: 25 });
  });

  it('Calibration mismatches: counts 7d LLM/rubric disagreements', () => {
    expect(payload.calibrationMismatches7d).toBe(1);
  });

  it('renders a deterministic report body', () => {
    const text = renderWeeklyReport(payload);
    expect(text).toContain('week of 2026-07-13');
    expect(text).toContain('shopping_checkout: 1 escape(s), 1 recent ticket(s) below T2');
    expect(text).toContain('content_marketing: T2→T1 (3 clean T2 ticket(s))');
    expect(text).toContain('task ov1: bot T0 → human T2');
    expect(text).toContain('design_workflow: 50% (1/2)');
    expect(text).toContain('1/4 superseded (25%)');
    expect(text).toContain('*6. Calibration mismatches*');
    expect(text).toContain('• 1 — the model disagreed');
  });
});

describe('WeeklyTierReporter.maybeSend — scheduling & idempotency', () => {
  function buildReporter(over: {
    now?: Date;
    existingRow?: unknown;
  }) {
    const weeklyRepo = {
      get: vi.fn().mockResolvedValue(over.existingRow ?? null),
      insert: vi.fn().mockResolvedValue(undefined),
    } as unknown as TierWeeklyReportsRepo;
    const classifications = {
      listSince: vi.fn().mockResolvedValue([]),
      listOverridesSince: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    } as unknown as TierClassificationsRepo;
    const prChecks = {
      countByVerdictSince: vi
        .fn()
        .mockResolvedValue({ confirmed: 0, superseded: 0, human_owned: 0, no_record: 0 }),
    } as unknown as TierPrChecksRepo;
    const client = {
      getProjectTasksUnbounded: vi.fn().mockResolvedValue([]),
    } as unknown as AsanaApiClient;
    const chatPost = vi.fn().mockResolvedValue({ ok: true });
    const slack = {
      conversations: { open: vi.fn().mockResolvedValue({ ok: true, channel: { id: 'D1' } }) },
      chat: { postMessage: chatPost },
    } as unknown as WebClient;
    const reporter = new WeeklyTierReporter({
      classifications,
      weeklyRepo,
      prChecks,
      client,
      slack,
      resolveDannySlackId: async () => 'U123',
      now: () => over.now ?? NOW,
    });
    return { reporter, weeklyRepo, chatPost };
  }

  it('does not send before Monday 9am', async () => {
    const { reporter, chatPost } = buildReporter({ now: new Date('2026-07-13T12:00:00Z') });
    const res = await reporter.maybeSend();
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('before_monday_9am');
    expect(chatPost).not.toHaveBeenCalled();
  });

  it('does not resend when a row already exists for the week (idempotent)', async () => {
    const { reporter, chatPost } = buildReporter({ existingRow: { week_start: '2026-07-13' } });
    const res = await reporter.maybeSend();
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('already_sent');
    expect(chatPost).not.toHaveBeenCalled();
  });

  it('sends the DM and records the week when due and unsent', async () => {
    const { reporter, weeklyRepo, chatPost } = buildReporter({});
    const res = await reporter.maybeSend();
    expect(res.sent).toBe(true);
    expect(res.weekStart).toBe('2026-07-13');
    expect(chatPost).toHaveBeenCalledTimes(1);
    expect(weeklyRepo.insert).toHaveBeenCalledWith('2026-07-13', expect.objectContaining({ weekStart: '2026-07-13' }));
  });
});
