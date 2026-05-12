import { describe, it, expect } from 'vitest';
import { detectLanguage, friendlyCapacityMessage } from '../../../src/llm/friendly-error.js';

describe('detectLanguage', () => {
  it('detects Spanish via diacritics (ñ)', () => {
    expect(detectLanguage('mañana hablamos')).toBe('es');
  });

  it('detects Spanish via inverted punctuation (¿, ¡)', () => {
    expect(detectLanguage('¿cuánto gastamos?')).toBe('es');
    expect(detectLanguage('¡eso es genial!')).toBe('es');
  });

  it('detects Spanish via accented vowels', () => {
    expect(detectLanguage('cómo está el cliente')).toBe('es');
  });

  it('detects Spanish via function-word frequency (no diacritics needed)', () => {
    // "que" + "es" = 2 distinct Spanish tokens → flagged.
    expect(detectLanguage('dime que es lo que paso')).toBe('es');
  });

  it('returns English for plain English queries', () => {
    expect(detectLanguage('how much did we spend on marketing')).toBe('en');
    expect(detectLanguage('show me orders from last week')).toBe('en');
  });

  it('returns English for empty / whitespace-only input', () => {
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage('   ')).toBe('en');
  });

  it('returns English for short queries with no Spanish signal', () => {
    expect(detectLanguage('hi')).toBe('en');
    expect(detectLanguage('thanks')).toBe('en');
  });

  it('does NOT trigger on a single bilingual word inside English text', () => {
    // "que" alone isn't enough — needs ≥2 distinct Spanish tokens.
    expect(detectLanguage('the word que sometimes appears in english copy')).toBe('en');
  });

  it('handles non-string input gracefully', () => {
    expect(detectLanguage(null as any)).toBe('en');
    expect(detectLanguage(undefined as any)).toBe('en');
    expect(detectLanguage(123 as any)).toBe('en');
  });
});

describe('friendlyCapacityMessage', () => {
  it('renders in Spanish when the user spoke Spanish', () => {
    const msg = friendlyCapacityMessage('¿cuánto gastamos en mayo?');
    expect(msg).toMatch(/Anthropic está saturada/);
    expect(msg).toMatch(/DMear a Danny/);
    expect(msg).not.toMatch(/Anthropic is overloaded/);
  });

  it('renders in English when the user spoke English', () => {
    const msg = friendlyCapacityMessage('how much did we spend in May');
    expect(msg).toMatch(/Anthropic is overloaded/);
    expect(msg).toMatch(/DM Danny/);
    expect(msg).not.toMatch(/saturada/);
  });

  it('falls back to English on empty/missing input', () => {
    expect(friendlyCapacityMessage('')).toMatch(/Anthropic is overloaded/);
    expect(friendlyCapacityMessage(undefined as any)).toMatch(/Anthropic is overloaded/);
  });
});
