import { describe, it, expect } from 'vitest';
import { renderOutput } from '../../../src/reports/block-renderer.js';
import type { OutputSpec } from '../../../src/reports/plan-types.js';

describe('renderOutput', () => {
  const aliasMap = {
    late: {
      rows: [
        { id: 53107, customer: 'Haworth Inc', daysLate: 5, total: 240.5 },
        { id: 53245, customer: 'Lumens Inc', daysLate: 2, total: 99.0 },
      ],
    },
    spend: { total: 12345 },
  };

  it('renders a header block', () => {
    const out: OutputSpec = { blocks: [{ type: 'header', text: 'Daily report' }] };
    const r = renderOutput(out, aliasMap);
    expect(r.text).toContain('*Daily report*');
    expect(r.attachments).toEqual([]);
  });

  it('renders a text block with ${alias.path} interpolation', () => {
    const out: OutputSpec = {
      blocks: [{ type: 'text', text: 'Total spend was ${spend.total} dollars.' }],
    };
    const r = renderOutput(out, aliasMap);
    expect(r.text).toContain('Total spend was 12345 dollars.');
  });

  it('renders a table as an aligned ASCII code block', () => {
    const out: OutputSpec = {
      blocks: [
        {
          type: 'table',
          from: 'late.rows',
          columns: [
            { header: 'Order', field: 'id', format: 'admin_order_link' },
            { header: 'Customer', field: 'customer' },
            { header: 'Days late', field: 'daysLate', format: 'integer' },
            { header: 'Total', field: 'total', format: 'currency_dollars' },
          ],
        },
      ],
    };
    const r = renderOutput(out, aliasMap);
    expect(r.text).toContain('```');
    expect(r.text).toContain('<http://admin.gantri.com/orders/53107|#53107>');
    expect(r.text).toContain('Haworth Inc');
    expect(r.text).toContain('$240.50');
  });

  it('emits a CSV attachment for csv_attachment blocks', () => {
    const out: OutputSpec = {
      blocks: [
        { type: 'csv_attachment', from: 'late.rows', filename: 'late.csv' },
      ],
    };
    const r = renderOutput(out, aliasMap);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].filename).toBe('late.csv');
    expect(r.attachments[0].content).toContain('id,customer,daysLate,total');
    expect(r.attachments[0].content).toContain('53107,Haworth Inc,5,240.5');
  });

  it('renders all blocks in order separated by blank lines', () => {
    const out: OutputSpec = {
      blocks: [
        { type: 'header', text: 'A' },
        { type: 'text', text: 'B' },
      ],
    };
    const r = renderOutput(out, aliasMap);
    expect(r.text).toBe('*A*\n\nB');
  });
});
