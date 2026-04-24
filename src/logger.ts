import pino from 'pino';
import { loadEnv } from './config/env.js';

const env = loadEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'gantri-ai-bot' },
  redact: {
    paths: [
      '*.authorization',
      '*.access_token',
      '*.access_token_encrypted',
      'password',
      'email',
      'SLACK_BOT_TOKEN',
      'SLACK_SIGNING_SECRET',
      'ANTHROPIC_API_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ],
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = typeof logger;
