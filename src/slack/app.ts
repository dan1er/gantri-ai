import pkg from '@slack/bolt';
import type { HandlerDeps } from './handlers.js';
import { createDmHandler, createMentionHandler } from './handlers.js';
import { loadEnv } from '../config/env.js';

const { App, ExpressReceiver } = pkg;

export function buildSlackApp(deps: HandlerDeps) {
  const env = loadEnv();
  const receiver = new ExpressReceiver({
    signingSecret: env.SLACK_SIGNING_SECRET,
    endpoints: '/slack/events',
  });
  const app = new App({
    token: env.SLACK_BOT_TOKEN,
    receiver,
  });

  app.event('message', createDmHandler(deps));
  app.event('app_mention', createMentionHandler());

  return { app, receiver };
}
