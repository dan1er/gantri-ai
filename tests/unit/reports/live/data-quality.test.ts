import { describe, it, expect } from 'vitest';
import { computeDataQuality } from '../../../../src/reports/live/data-quality.js';

describe('computeDataQuality', () => {
  it('emits no warnings when steps return real data and no errors', () => {
    const r = computeDataQuality(
      { partner_perf: { totals: { actions: 174, revenue: 68113.6 }, partners: [{ name: 'Capital One' }] } },
      [],
    );
    expect(r.warnings).toEqual([]);
  });

  it('flags all_steps_empty when every step has zeros + empty arrays', () => {
    const r = computeDataQuality(
      { partner_perf: { totals: { actions: 0, revenue: 0, payout: 0 }, partners: [], partnerCount: 0 } },
      [],
    );
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].code).toBe('all_steps_empty');
  });

  it('flags step_errors when any step errored', () => {
    const r = computeDataQuality(
      {},
      [{ stepId: 's1', tool: 'impact.partner_performance', code: 'IMPACT_API_ERROR', message: '400' }],
    );
    expect(r.warnings.some((w) => w.code === 'step_errors')).toBe(true);
  });

  it('flags partial_empty when some but not all steps are empty', () => {
    const r = computeDataQuality(
      {
        full: { totals: { actions: 100 }, rows: [{ x: 1 }] },
        empty: { totals: { actions: 0 }, rows: [], count: 0 },
      },
      [],
    );
    expect(r.warnings.some((w) => w.code === 'partial_empty')).toBe(true);
    expect(r.warnings.find((w) => w.code === 'partial_empty')?.message).toContain('empty');
  });

  it('does NOT flag empty when at least one numeric is non-zero', () => {
    const r = computeDataQuality(
      { stats: { totals: { actions: 0, revenue: 1, payout: 0 }, rows: [] } },
      [],
    );
    expect(r.warnings).toEqual([]);
  });

  it('treats {ok:true} (metadata-only) as non-empty (not flagged)', () => {
    const r = computeDataQuality({ canary: { ok: true } }, []);
    expect(r.warnings).toEqual([]);
  });

  it('combines step_errors and all_steps_empty when both apply', () => {
    const r = computeDataQuality(
      { partner_perf: { totals: { actions: 0 }, partners: [] } },
      [{ stepId: 'partner_perf', tool: 'impact.partner_performance', code: 'X', message: 'fail' }],
    );
    // step_errors short-circuits all_steps_empty (empty is implied by the error).
    expect(r.warnings.some((w) => w.code === 'step_errors')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'all_steps_empty')).toBe(false);
  });
});
