import { describe, it, expect } from 'vitest';
import { slugFromRef, backendUrl } from '../../../src/devops/slug.js';

describe('slugFromRef', () => {
  it('extracts the AS ticket, lowercased', () => {
    expect(slugFromRef('feat/AS-2215-cool-thing')).toBe('as-2215');
    expect(slugFromRef('AS-2215')).toBe('as-2215');
  });

  it('falls back to a dns-safe slug of the branch tail', () => {
    expect(slugFromRef('feature/Cool_Thing!!')).toBe('cool-thing');
    expect(slugFromRef('bugfix/weird   spaces')).toBe('weird-spaces');
  });

  it('never returns an empty slug', () => {
    expect(slugFromRef('---')).toBe('preview');
  });
});

describe('backendUrl', () => {
  it('builds the deterministic preview URL', () => {
    expect(backendUrl('as-2215')).toBe('https://as-2215.api.preview.gantri.com');
  });
});
