import type { WebClient } from '@slack/web-api';
import type { RenderedAttachment } from './block-renderer.js';
import { markdownToSlackBlocks } from '../orchestrator/formatter.js';
import { logger } from '../logger.js';

export interface DeliverReportInput {
  client: WebClient;
  slackUserId: string;
  deliveryChannel: string; // 'dm' or 'channel:Cxxxx'
  text: string;
  attachments: RenderedAttachment[];
  botToken: string;
  /** Footer line shown in the rendered message (e.g. status + duration). */
  footer?: string;
}

/**
 * Resolve the target channel:
 *   - 'dm'        -> open a DM with slackUserId and post there.
 *   - 'channel:C…' -> post to that channel directly.
 * Returns the channel id used.
 */
export async function deliverReport(input: DeliverReportInput): Promise<{ channel: string; ts: string }> {
  const channel = await resolveChannel(input);
  const blocks = markdownToSlackBlocks(input.text, { footer: input.footer });
  const post = await input.client.chat.postMessage({
    channel,
    text: input.text.slice(0, 200),
    blocks,
  });
  if (!post.ok || !post.ts) {
    throw new Error(`chat.postMessage failed: ${post.error ?? 'unknown'}`);
  }
  for (const att of input.attachments) {
    try {
      await uploadFile({ token: input.botToken, channel, threadTs: post.ts, filename: att.filename, content: att.content });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), filename: att.filename }, 'report attachment upload failed');
    }
  }
  return { channel, ts: post.ts };
}

async function resolveChannel(input: DeliverReportInput): Promise<string> {
  if (input.deliveryChannel.startsWith('channel:')) {
    return input.deliveryChannel.slice('channel:'.length);
  }
  // open DM
  const open = await input.client.conversations.open({ users: input.slackUserId });
  if (!open.ok || !open.channel?.id) {
    throw new Error(`conversations.open failed: ${open.error ?? 'unknown'}`);
  }
  return open.channel.id;
}

async function uploadFile(p: { token: string; channel: string; threadTs: string; filename: string; content: string }): Promise<void> {
  const bytes = Buffer.byteLength(p.content, 'utf8');
  const step1 = await fetch(
    `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(p.filename)}&length=${bytes}`,
    { headers: { authorization: `Bearer ${p.token}` } },
  ).then((r) => r.json() as Promise<{ ok: boolean; upload_url?: string; file_id?: string; error?: string }>);
  if (!step1.ok || !step1.upload_url || !step1.file_id) {
    throw new Error(`getUploadURLExternal failed: ${step1.error ?? 'unknown'}`);
  }
  const step2 = await fetch(step1.upload_url, {
    method: 'POST',
    body: p.content,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
  if (!step2.ok) {
    throw new Error(`upload POST returned HTTP ${step2.status}`);
  }
  const step3 = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      files: [{ id: step1.file_id, title: p.filename }],
      channel_id: p.channel,
      thread_ts: p.threadTs,
    }),
  }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);
  if (!step3.ok) {
    throw new Error(`completeUploadExternal failed: ${step3.error ?? 'unknown'}`);
  }
}
