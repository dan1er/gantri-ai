// Ensures required env vars exist for modules that call loadEnv().
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key';
process.env.ANTHROPIC_API_KEY ??= 'test-ant';
process.env.SLACK_BOT_TOKEN ??= 'xoxb-test';
process.env.SLACK_SIGNING_SECRET ??= 'test-sig';
process.env.LOG_LEVEL ??= 'silent';
