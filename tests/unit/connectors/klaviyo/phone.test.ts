import { describe, it, expect } from 'vitest';
import { normalizeToE164 } from '../../../../src/connectors/klaviyo/phone.js';

describe('normalizeToE164', () => {
  it.each([
    ['+1 415 555 0100', '+14155550100'],
    ['(415) 555-0100', '+14155550100'],
    ['415-555-0100', '+14155550100'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeToE164(input)).toBe(expected);
  });

  it.each([
    ['not-a-phone'],
    [''],
    ['   '],
    ['12'],
  ])('returns null for invalid: %s', (input) => {
    expect(normalizeToE164(input)).toBeNull();
  });
});
