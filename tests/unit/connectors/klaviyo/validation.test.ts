import { describe, it, expect } from 'vitest';
import { validateBatch } from '../../../../src/connectors/klaviyo/validation.js';

describe('validateBatch', () => {
  it('passes a clean batch', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'a@x.com' },
      { rowIndex: 2, email: 'b@y.com', phone: '+14155550100' },
    ], { channels: ['email'] });
    expect(r.valid.length).toBe(2);
    expect(r.invalid).toEqual([]);
    expect(r.valid[1].phone_e164).toBe('+14155550100');
  });

  it('flags invalid emails', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'gertrude@@gmail.com' },
    ], { channels: ['email'] });
    expect(r.invalid.length).toBe(1);
    expect(r.invalid[0].reason).toContain('invalid email');
  });

  it('flags duplicates case-insensitively', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'alice@x.com' },
      { rowIndex: 2, email: 'ALICE@X.COM' },
    ], { channels: ['email'] });
    expect(r.valid.length).toBe(1);
    expect(r.invalid.length).toBe(1);
    expect(r.invalid[0].reason).toContain('duplicate of row 1');
  });

  it('requires phone when channels includes sms', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'a@x.com', phone: '+14155550100' },
      { rowIndex: 2, email: 'b@y.com' },
    ], { channels: ['email', 'sms'] });
    expect(r.valid.length).toBe(1);
    expect(r.invalid[0].reason).toContain('phone required');
  });

  it('flags unparseable phone', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'a@x.com', phone: 'not-a-phone' },
    ], { channels: ['email'] });
    expect(r.invalid[0].reason).toContain('invalid phone');
  });

  it('flags malformed consented_at', () => {
    const r = validateBatch([
      { rowIndex: 1, email: 'a@x.com', consented_at: 'yesterday' },
    ], { channels: ['email'] });
    expect(r.invalid[0].reason).toContain('not ISO 8601');
  });
});
