import { describe, it, expect } from 'vitest';
import { formatCell } from '../../../src/reports/formatters.js';

describe('formatCell', () => {
  it('currency_dollars formats with $ and 2 decimals', () => {
    expect(formatCell(1234.5, 'currency_dollars')).toBe('$1,234.50');
    expect(formatCell(0, 'currency_dollars')).toBe('$0.00');
    expect(formatCell(null, 'currency_dollars')).toBe('—');
  });

  it('integer formats with thousands sep', () => {
    expect(formatCell(1234567, 'integer')).toBe('1,234,567');
    expect(formatCell(0, 'integer')).toBe('0');
  });

  it('percent multiplies by 100 and adds %', () => {
    expect(formatCell(0.1234, 'percent')).toBe('12.3%');
  });

  it('admin_order_link renders Slack mrkdwn link', () => {
    expect(formatCell(53981, 'admin_order_link'))
      .toBe('<http://admin.gantri.com/orders/53981|#53981>');
  });

  it('datetime_pt formats ISO timestamp as YYYY-MM-DD HH:MM PT wall-clock', () => {
    expect(formatCell('2026-04-20T01:22:03.775Z', 'datetime_pt')).toBe('2026-04-19 18:22');
  });

  it('date_pt formats ISO timestamp as YYYY-MM-DD PT', () => {
    expect(formatCell('2026-04-20T01:22:03.775Z', 'date_pt')).toBe('2026-04-19');
  });

  it('returns "—" for null/undefined regardless of format', () => {
    expect(formatCell(undefined, 'datetime_pt')).toBe('—');
    expect(formatCell(null, 'admin_order_link')).toBe('—');
  });

  it('falls through to String() when no format is specified', () => {
    expect(formatCell('hello', undefined)).toBe('hello');
    expect(formatCell(42, undefined)).toBe('42');
  });
});
