import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

describe('loadEnv', () => {
  const validEnv = {
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ANTHROPIC_API_KEY: 'sk-ant-xxx',
    SLACK_BOT_TOKEN: 'xoxb-xxx',
    SLACK_SIGNING_SECRET: 'secret',
  };

  it('parses required vars and defaults optional ones', () => {
    const env = loadEnv(validEnv);
    expect(env.SUPABASE_URL).toBe('https://abc.supabase.co');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DEBUG_FULL_LOGS).toBe(false);
    expect(env.PORT).toBe(3000);
  });

  it('throws when a required var is missing', () => {
    const { SUPABASE_URL: _, ...partial } = validEnv;
    expect(() => loadEnv(partial)).toThrow(/SUPABASE_URL/);
  });

  it('coerces DEBUG_FULL_LOGS=true (string) to boolean true', () => {
    const env = loadEnv({ ...validEnv, DEBUG_FULL_LOGS: 'true' });
    expect(env.DEBUG_FULL_LOGS).toBe(true);
  });
});
