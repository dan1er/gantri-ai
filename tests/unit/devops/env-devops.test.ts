import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../src/config/env.js';

const base = {
  SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k',
  ANTHROPIC_API_KEY: 'a', SLACK_BOT_TOKEN: 'xoxb', SLACK_SIGNING_SECRET: 's',
};

describe('devops env', () => {
  it('defaults GITHUB_OWNER to gantri and keeps OPS_CHANNEL_ID/GITHUB_TOKEN optional', () => {
    const env = loadEnv(base);
    expect(env.GITHUB_OWNER).toBe('gantri');
    expect(env.OPS_CHANNEL_ID).toBeUndefined();
  });

  it('reads provided dev-ops vars', () => {
    const env = loadEnv({ ...base, OPS_CHANNEL_ID: 'C0B8XD4LSLC', GITHUB_TOKEN: 'gho_x' });
    expect(env.OPS_CHANNEL_ID).toBe('C0B8XD4LSLC');
    expect(env.GITHUB_TOKEN).toBe('gho_x');
  });
});
