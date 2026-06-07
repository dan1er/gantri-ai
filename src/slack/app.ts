import pkg from '@slack/bolt';
import type { HandlerDeps, FileSharedDeps } from './handlers.js';
import { createDmHandler, createMentionHandler, handleFileShared } from './handlers.js';
import { loadEnv } from '../config/env.js';

const { App, ExpressReceiver } = pkg;

export function buildSlackApp(deps: HandlerDeps & {
  fileSharedDeps: FileSharedDeps;
  registerExtra?: (app: InstanceType<typeof App>) => void;
}) {
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
  // file_shared fires when a user uploads a file. The handler narrows to DMs +
  // CSV + admin/marketing role, then routes to klaviyo.import_profiles.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.event('file_shared', async ({ event }: { event: any }) => {
    await handleFileShared({
      event: {
        channel_id: event.channel_id,
        user_id: event.user_id,
        file_id: event.file_id,
      },
      deps: deps.fileSharedDeps,
    });
  });

  deps.registerExtra?.(app);
  return { app, receiver };
}
