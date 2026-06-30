import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { NotionApiClient, PageBlock } from '../../connectors/notion/client.js';
import { NotionApiError } from '../../connectors/notion/client.js';
import { FINDING_AREAS, FINDING_SEVERITIES, FlcReviewParseError } from '../../flc/flc-review-service.js';
import type { Finding, ReviewInput } from '../../flc/flc-review-service.js';
import { AnthropicCapacityExhausted } from '../../llm/resilient-claude.js';
import { logger } from '../../logger.js';

/**
 * `/review-flc` — review an FLC's Notion page against the Gantri review standard
 * and (optionally) post selected findings back as block-level Notion comments.
 *
 * Usable in ANY conversation/DM (no `decideCommandChannel` gating). Review-only:
 * the only write action is posting comments the user explicitly selects.
 */

export interface ReviewFlcDeps {
  notion: NotionApiClient;
  /** Runs the LLM review. Injected so tests can stub it. */
  review: (input: ReviewInput) => Promise<Finding[]>;
  /** Slack WebClient (= app.client) used to post + edit the result message. */
  slack: WebClient;
}

interface ReviewState {
  pageId: string;
  url: string;
  findings: Finding[];
  blocks: PageBlock[];
  channel: string;
}

const SEVERITY_EMOJI: Record<string, string> = {
  'Must Fix': '🔴',
  'Should Fix': '🟡',
  Suggestion: '🔵',
};

// v1 has no DB — keep the latest reviews in memory, keyed by the result
// message ts, with a small cap so a long-lived process can't leak.
const MAX_REVIEWS = 100;

// Slack rejects a message with more than 50 blocks. Each finding is one section;
// cap how many we render so the intro, severity headers, optional overflow note,
// and the Post button always fit under the ceiling.
const MAX_FINDING_SECTIONS = 42;

class ReviewStore {
  private readonly map = new Map<string, ReviewState>();

  set(ts: string, state: ReviewState): void {
    if (this.map.size >= MAX_REVIEWS) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(ts, state);
  }

  get(ts: string): ReviewState | undefined {
    return this.map.get(ts);
  }
}

const AREA_OPTIONS = FINDING_AREAS.map((a) => ({
  text: { type: 'plain_text' as const, text: a },
  value: a,
}));

export function buildReviewModal(): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: 'review_flc_submit',
    title: { type: 'plain_text', text: 'Review an FLC' },
    submit: { type: 'plain_text', text: 'Review' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'url_block',
        label: { type: 'plain_text', text: 'FLC Notion link' },
        element: {
          type: 'plain_text_input',
          action_id: 'url_input',
          placeholder: { type: 'plain_text', text: 'https://www.notion.so/…' },
        },
      },
      {
        type: 'input',
        block_id: 'areas_block',
        optional: true,
        label: { type: 'plain_text', text: 'Areas to review' },
        element: {
          type: 'checkboxes',
          action_id: 'areas_input',
          // All areas pre-selected — the full review is the default action.
          initial_options: AREA_OPTIONS,
          options: AREA_OPTIONS,
        },
      },
    ],
  };
}

interface ViewState {
  state?: { values?: Record<string, Record<string, ViewElementState>> };
}
interface ViewElementState {
  type?: string;
  value?: string;
  selected_options?: Array<{ value: string }>;
}

export function parseReviewSubmission(view: ViewState): { url: string; areas: string[] } {
  const values = view.state?.values ?? {};
  const url = (values.url_block?.url_input?.value ?? '').trim();
  const areas = (values.areas_block?.areas_input?.selected_options ?? []).map((o) => o.value);
  return { url, areas };
}

/** Collect the checked finding ids from a message/view state values blob. */
export function collectSelectedIds(
  values: Record<string, Record<string, ViewElementState>> | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const block of Object.values(values ?? {})) {
    for (const action of Object.values(block ?? {})) {
      if (action?.type === 'checkboxes' && Array.isArray(action.selected_options)) {
        for (const opt of action.selected_options) {
          if (opt?.value) ids.add(opt.value);
        }
      }
    }
  }
  return ids;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Map a finding's anchor snippet to the page block whose text contains it.
 * Handles the standard's `start…end` selection form. Returns null when nothing
 * matches (caller falls back to a page-level comment).
 */
export function findAnchorBlock(anchor: string, blocks: PageBlock[]): PageBlock | null {
  const a = norm(anchor);
  if (!a) return null;

  // 1) Whole anchor appears verbatim in a block.
  const whole = blocks.find((b) => norm(b.text).includes(a));
  if (whole) return whole;

  // 2) `start…end` / `start...end` form: both ends present in one block.
  const parts = anchor
    .split(/…|\.\.\./)
    .map((p) => norm(p))
    .filter((p) => p.length > 0);
  if (parts.length >= 2) {
    const start = parts[0];
    const end = parts[parts.length - 1];
    const both = blocks.find((b) => {
      const t = norm(b.text);
      return t.includes(start) && t.includes(end);
    });
    if (both) return both;
  }

  // 3) Fall back to the longest distinctive part.
  for (const p of [...parts].sort((x, y) => y.length - x.length)) {
    if (p.length < 6) continue;
    const m = blocks.find((b) => norm(b.text).includes(p));
    if (m) return m;
  }

  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function severityOrder(findings: Finding[]): Map<string, Finding[]> {
  const grouped = new Map<string, Finding[]>();
  for (const sev of FINDING_SEVERITIES) grouped.set(sev, []);
  for (const f of findings) {
    const bucket = grouped.get(f.severity) ?? grouped.get('Suggestion')!;
    bucket.push(f);
  }
  return grouped;
}

/** Render the findings as a Block Kit message with a checkbox per finding. */
export function renderFindingsBlocks(findings: Finding[], ts: string, url: string): unknown[] {
  if (findings.length === 0) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:white_check_mark: *FLC review* — no findings in the selected areas. <${url}|This FLC> looks good. 🎉`,
        },
      },
    ];
  }

  const grouped = severityOrder(findings);
  const counts = FINDING_SEVERITIES.map((s) => `${grouped.get(s)!.length} ${s}`).join(', ');
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:mag: *FLC review* — ${findings.length} finding${findings.length === 1 ? '' : 's'} (${counts}). All pre-selected — untick any you don't want, then *Post selected as comments* on <${url}|the FLC>.`,
      },
    },
    { type: 'divider' },
  ];

  // Each finding is its own section so the FULL text is visible (3000-char cap),
  // with a checkboxes accessory for selection (a checkbox option's own text is
  // limited to ~75 chars, so the message can't live there). Slack caps a message
  // at 50 blocks — budget the finding sections so headers + button always fit.
  let shown = 0;
  let omitted = 0;
  for (const sev of FINDING_SEVERITIES) {
    const group = grouped.get(sev)!;
    if (group.length === 0) continue;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${SEVERITY_EMOJI[sev]} *${sev}* (${group.length})` },
    });
    for (const f of group) {
      if (shown >= MAX_FINDING_SECTIONS) {
        omitted += 1;
        continue;
      }
      const heading = `*${f.area}*${f.section ? ` — _${f.section}_` : ''}`;
      const option = { text: { type: 'plain_text', text: 'Post' }, value: f.id };
      blocks.push({
        type: 'section',
        block_id: `finding_${f.id}`,
        text: { type: 'mrkdwn', text: truncate(`${heading}\n${f.message}`, 2900) },
        accessory: {
          type: 'checkboxes',
          action_id: `finding_select_${f.id}`,
          options: [option],
          // Pre-selected — posting is opt-out: untick what you don't want.
          initial_options: [option],
        },
      });
      shown += 1;
    }
  }

  if (omitted > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_+${omitted} more finding${omitted === 1 ? '' : 's'} not shown (Slack message limit) — re-run with fewer areas to see ${omitted === 1 ? 'it' : 'them'}._`,
        },
      ],
    });
  }

  blocks.push({
    type: 'actions',
    block_id: 'review_actions',
    elements: [
      {
        type: 'button',
        action_id: 'review_flc_post',
        text: { type: 'plain_text', text: 'Post selected as comments' },
        style: 'primary',
        value: ts,
      },
    ],
  });

  return blocks;
}

interface PostOutcome {
  finding: Finding;
  status: 'block' | 'page' | 'failed';
  error?: string;
}

export function renderPostResultBlocks(url: string, outcomes: PostOutcome[]): unknown[] {
  const posted = outcomes.filter((o) => o.status === 'block' || o.status === 'page');
  const fellBack = outcomes.filter((o) => o.status === 'page');
  const failed = outcomes.filter((o) => o.status === 'failed');

  const header = `:speech_balloon: Posted ${posted.length} comment${posted.length === 1 ? '' : 's'} on <${url}|the FLC>` +
    (failed.length ? ` · ${failed.length} failed` : '') +
    (fellBack.length ? ` · ${fellBack.length} at page level` : '') +
    '.';

  const lines: string[] = outcomes.map((o) => {
    const label = `*${o.finding.area}*${o.finding.section ? ` — ${o.finding.section}` : ''}`;
    if (o.status === 'block') return `✓ ${label}`;
    if (o.status === 'page') return `↪︎ ${label} _(couldn't anchor to a block — posted at page level)_`;
    return `✗ ${label} _(failed: ${o.error ?? 'unknown error'})_`;
  });

  return [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    { type: 'section', text: { type: 'mrkdwn', text: truncate(lines.join('\n'), 2900) } },
  ];
}

function describeReviewFailure(err: unknown): string {
  if (err instanceof NotionApiError) {
    if (err.status === 401 || err.status === 403 || err.status === 404) {
      return ":lock: I can't open that Notion page. Double-check the link, and make sure the page (or its space) is shared with the reviewer integration, then try again.";
    }
    return `:warning: I couldn't read that Notion page (error ${err.status}). Nothing was posted.`;
  }
  if (err instanceof AnthropicCapacityExhausted) {
    return ':warning: The review engine is overloaded right now. Nothing was posted — give it a minute and run `/review-flc` again.';
  }
  if (err instanceof FlcReviewParseError) {
    return ":warning: I reviewed the FLC but couldn't make sense of the result. Nothing was posted — please run `/review-flc` again.";
  }
  return ':warning: Something went wrong running the review. Nothing was posted — please try again.';
}

export function registerReviewFlcCommand(app: App, deps: ReviewFlcDeps): void {
  const store = new ReviewStore();

  // Slash command -> open the review modal. No channel/role gating (v1).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.command('/review-flc', async ({ ack, body, client }: any) => {
    await ack();
    const channel = body.channel_id as string;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: { ...buildReviewModal(), private_metadata: JSON.stringify({ channel }) },
    });
  });

  // Modal submit -> validate, then run the review.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.view('review_flc_submit', async ({ ack, body, view }: any) => {
    const { url, areas } = parseReviewSubmission(view);

    const errors: Record<string, string> = {};
    let pageId = '';
    if (!url) {
      errors.url_block = 'Paste the FLC Notion link.';
    } else {
      try {
        pageId = deps.notion.resolvePageId(url);
      } catch {
        errors.url_block = "That doesn't look like a Notion page link.";
      }
    }
    if (areas.length === 0) {
      errors.areas_block = 'Pick at least one area to review.';
    }
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors });
      return;
    }

    await ack();

    let channel = body.user?.id as string;
    try {
      const meta = JSON.parse(view.private_metadata || '{}') as { channel?: string };
      if (meta.channel) channel = meta.channel;
    } catch {
      // keep the fallback (the user's id opens a DM-style target)
    }

    await runReview(deps, store, {
      pageId,
      url,
      areas,
      channel,
      userId: body.user?.id ?? 'unknown',
    });
  });

  // "Post selected as comments" -> post each checked finding as a comment.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.action('review_flc_post', async ({ ack, body }: any) => {
    await ack();
    const ts: string | undefined = body.container?.message_ts ?? body.message?.ts;
    const channel: string | undefined = body.channel?.id ?? body.container?.channel_id;
    const state = ts ? store.get(ts) : undefined;

    if (!state || !ts || !channel) {
      await postEphemeral(deps, channel, body.user?.id, 'That review has expired — run `/review-flc` again.');
      return;
    }

    const selectedIds = collectSelectedIds(body.state?.values);
    const selected = state.findings.filter((f) => selectedIds.has(f.id));
    if (selected.length === 0) {
      await postEphemeral(deps, channel, body.user?.id, 'Tick at least one finding to post.');
      return;
    }

    const outcomes: PostOutcome[] = [];
    for (const finding of selected) {
      const block = findAnchorBlock(finding.anchor, state.blocks);
      try {
        if (block) {
          await deps.notion.createBlockComment(block.blockId, finding.message);
          outcomes.push({ finding, status: 'block' });
        } else {
          await deps.notion.createPageComment(state.pageId, finding.message);
          outcomes.push({ finding, status: 'page' });
        }
      } catch (err) {
        outcomes.push({
          finding,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const posted = outcomes.filter((o) => o.status !== 'failed').length;
    const failed = outcomes.filter((o) => o.status === 'failed').length;
    logger.info(
      { action: 'comment', posted, failed, by: body.user?.id },
      '[REVIEW-FLC] action:comment',
    );

    await deps.slack.chat
      .update({
        channel,
        ts,
        text: `Posted ${posted} comment(s)`,
        blocks: renderPostResultBlocks(state.url, outcomes) as never,
      })
      .catch((err: unknown) =>
        logger.warn({ err: String((err as Error)?.message ?? err) }, '[REVIEW-FLC] result update failed'),
      );
  });
}

async function runReview(
  deps: ReviewFlcDeps,
  store: ReviewStore,
  args: { pageId: string; url: string; areas: string[]; channel: string; userId: string },
): Promise<void> {
  logger.info(
    { action: 'request', user: args.userId, url: args.url, areas: args.areas },
    '[REVIEW-FLC] action:request',
  );

  const posted = await deps.slack.chat.postMessage({
    channel: args.channel,
    text: '🔍 Reviewing the FLC against the Gantri standard…',
  });
  const ts = posted.ts as string | undefined;

  try {
    const { markdown, blocks } = await deps.notion.getPageMarkdown(args.pageId);
    const findings = await deps.review({ pageMarkdown: markdown, areas: args.areas });

    if (ts) {
      store.set(ts, {
        pageId: args.pageId,
        url: args.url,
        findings,
        blocks,
        channel: args.channel,
      });
      await deps.slack.chat.update({
        channel: args.channel,
        ts,
        text: `FLC review — ${findings.length} finding(s)`,
        blocks: renderFindingsBlocks(findings, ts, args.url) as never,
      });
    }
    logger.info({ action: 'complete', findings: findings.length }, '[REVIEW-FLC] action:complete');
  } catch (err) {
    const reason =
      err instanceof NotionApiError
        ? `notion_${err.status}`
        : err instanceof AnthropicCapacityExhausted
          ? 'engine_exhausted'
          : err instanceof FlcReviewParseError
            ? 'malformed_output'
            : 'unknown';
    logger.warn(
      { action: 'fail', reason, err: err instanceof Error ? err.message : String(err) },
      '[REVIEW-FLC] action:fail',
    );
    const message = describeReviewFailure(err);
    if (ts) {
      await deps.slack.chat
        .update({ channel: args.channel, ts, text: message, blocks: undefined })
        .catch(() => {});
    } else {
      await deps.slack.chat.postMessage({ channel: args.channel, text: message }).catch(() => {});
    }
  }
}

async function postEphemeral(
  deps: ReviewFlcDeps,
  channel: string | undefined,
  user: string | undefined,
  text: string,
): Promise<void> {
  if (!channel || !user) return;
  await deps.slack.chat.postEphemeral({ channel, user, text }).catch(() => {});
}
