import { describe, it, expect } from 'vitest';
import { resolveDateMacro, substituteDateMacros } from '../../../../src/reports/live/date-macros.js';

// Wednesday Apr 22 2026, 18:00 UTC = 11:00 AM PT — well past midnight in PT.
const WED_APR_22 = new Date('2026-04-22T18:00:00Z');
// Saturday Apr 25 2026, 03:00 UTC = Friday Apr 24 8pm PT — verifies the PT
// calendar boundary differs from UTC.
const FRI_NIGHT_PT = new Date('2026-04-25T03:00:00Z');

describe('resolveDateMacro — base names', () => {
  it('resolves $DATE:today in PT', () => {
    expect(resolveDateMacro('$DATE:today', WED_APR_22)).toBe('2026-04-22');
  });
  it('uses the PT calendar date even when UTC has rolled forward', () => {
    // Friday 8pm PT, even though UTC is already Saturday.
    expect(resolveDateMacro('$DATE:today', FRI_NIGHT_PT)).toBe('2026-04-24');
  });
  it('resolves $DATE:yesterday', () => {
    expect(resolveDateMacro('$DATE:yesterday', WED_APR_22)).toBe('2026-04-21');
  });
  it('resolves $DATE:this_monday', () => {
    expect(resolveDateMacro('$DATE:this_monday', WED_APR_22)).toBe('2026-04-20');
  });
  it('resolves $DATE:last_monday', () => {
    expect(resolveDateMacro('$DATE:last_monday', WED_APR_22)).toBe('2026-04-13');
  });
  it('resolves $DATE:monday_2w_ago', () => {
    expect(resolveDateMacro('$DATE:monday_2w_ago', WED_APR_22)).toBe('2026-04-06');
  });
  it('resolves $DATE:last_sunday', () => {
    expect(resolveDateMacro('$DATE:last_sunday', WED_APR_22)).toBe('2026-04-19');
  });
  it('resolves $DATE:sunday_2w_ago', () => {
    expect(resolveDateMacro('$DATE:sunday_2w_ago', WED_APR_22)).toBe('2026-04-12');
  });
});

describe('resolveDateMacro — offsets', () => {
  it('today-7d for same DOW last week', () => {
    expect(resolveDateMacro('$DATE:today-7d', WED_APR_22)).toBe('2026-04-15');
  });
  it('today-14d for same DOW two weeks ago', () => {
    expect(resolveDateMacro('$DATE:today-14d', WED_APR_22)).toBe('2026-04-08');
  });
  it('this_monday+6d returns Sunday of current week', () => {
    expect(resolveDateMacro('$DATE:this_monday+6d', WED_APR_22)).toBe('2026-04-26');
  });
});

describe('resolveDateMacro — passthrough', () => {
  it('returns non-macro strings unchanged', () => {
    expect(resolveDateMacro('2026-04-22', WED_APR_22)).toBe('2026-04-22');
    expect(resolveDateMacro('hello', WED_APR_22)).toBe('hello');
  });
  it('returns non-string values unchanged', () => {
    expect(resolveDateMacro(42, WED_APR_22)).toBe(42);
    expect(resolveDateMacro(null, WED_APR_22)).toBe(null);
  });
  it('passes through unknown bases (lets downstream validation catch them)', () => {
    expect(resolveDateMacro('$DATE:tomorrow', WED_APR_22)).toBe('$DATE:tomorrow');
  });
});

describe('substituteDateMacros — recursive', () => {
  it('walks objects and replaces macros wherever they appear', () => {
    const args = {
      dateRange: { start: '$DATE:this_monday', end: '$DATE:today' },
      compareTo: { start: '$DATE:last_monday', end: '$DATE:today-7d' },
      tags: ['$DATE:yesterday', 'literal-string'],
      pageSize: 30,
    };
    expect(substituteDateMacros(args, WED_APR_22)).toEqual({
      dateRange: { start: '2026-04-20', end: '2026-04-22' },
      compareTo: { start: '2026-04-13', end: '2026-04-15' },
      tags: ['2026-04-21', 'literal-string'],
      pageSize: 30,
    });
  });

  it('replaces embedded macros inside prose / descriptions', () => {
    const description = '3-Week Sales Snapshot · This WTD (`$DATE:this_monday`–`$DATE:today`) · Last Week (`$DATE:last_monday`–`$DATE:last_sunday`)';
    expect(resolveDateMacro(description, WED_APR_22)).toBe(
      '3-Week Sales Snapshot · This WTD (`2026-04-20`–`2026-04-22`) · Last Week (`2026-04-13`–`2026-04-19`)',
    );
  });

  it('walks ui blocks and substitutes inside text-block markdown', () => {
    const ui = [
      { type: 'text', markdown: 'WTD: `$DATE:this_monday` to `$DATE:today`' },
      { type: 'kpi', label: 'Today is $DATE:today', value: 'foo' },
    ];
    expect(substituteDateMacros(ui, WED_APR_22)).toEqual([
      { type: 'text', markdown: 'WTD: `2026-04-20` to `2026-04-22`' },
      { type: 'kpi', label: 'Today is 2026-04-22', value: 'foo' },
    ]);
  });
});
