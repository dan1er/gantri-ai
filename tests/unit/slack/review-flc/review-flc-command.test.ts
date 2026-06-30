import { describe, it, expect, vi } from 'vitest';
import type { App } from '@slack/bolt';
import {
  registerReviewFlcCommand,
  buildReviewModal,
  parseReviewSubmission,
  renderFindingsBlocks,
  findAnchorBlock,
  collectSelectedIds,
} from '../../../../src/slack/review-flc/review-flc-command.js';
import type { Finding } from '../../../../src/flc/flc-review-service.js';

// A stub Bolt app that captures registered handlers so tests can invoke them.
function makeApp() {
  const handlers: Record<string, (args: unknown) => Promise<void>> = {};
  const app = {
    command: (name: string, fn: (args: unknown) => Promise<void>) => {
      handlers[`command:${name}`] = fn;
    },
    view: (name: string, fn: (args: unknown) => Promise<void>) => {
      handlers[`view:${name}`] = fn;
    },
    action: (name: string, fn: (args: unknown) => Promise<void>) => {
      handlers[`action:${name}`] = fn;
    },
  } as unknown as App;
  return { app, handlers };
}

function makeDeps() {
  const notion = {
    resolvePageId: vi.fn().mockReturnValue('pageid32'),
    getPageMarkdown: vi.fn(),
    createBlockComment: vi.fn().mockResolvedValue(undefined),
    createPageComment: vi.fn().mockResolvedValue(undefined),
  };
  const slack = {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: '111.222' }),
      update: vi.fn().mockResolvedValue({}),
      postEphemeral: vi.fn().mockResolvedValue({}),
    },
  };
  const review = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { deps: { notion, slack, review } as any, notion, slack, review };
}

const F = (over: Partial<Finding>): Finding => ({
  id: 'F1',
  severity: 'Must Fix',
  area: 'Functional',
  section: 'Overview',
  anchor: 'the gap',
  message: 'lead with the user',
  ...over,
});

describe('pure helpers', () => {
  it('buildReviewModal has a url input + 5 pre-selected area checkboxes', () => {
    const view = buildReviewModal();
    const json = JSON.stringify(view);
    expect(view.callback_id).toBe('review_flc_submit');
    expect(json).toContain('url_input');
    expect(json).toContain('areas_input');
    for (const a of ['Functional', 'Technical', 'Testing', 'Operational', 'Security']) {
      expect(json).toContain(a);
    }
    // all areas initial-selected
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const areasBlock = (view.blocks as any[]).find((b) => b.block_id === 'areas_block');
    expect(areasBlock.element.initial_options).toHaveLength(5);
  });

  it('parseReviewSubmission reads url + selected areas', () => {
    const view = {
      state: {
        values: {
          url_block: { url_input: { value: ' https://notion.so/x ' } },
          areas_block: {
            areas_input: { selected_options: [{ value: 'Functional' }, { value: 'Security' }] },
          },
        },
      },
    };
    expect(parseReviewSubmission(view)).toEqual({
      url: 'https://notion.so/x',
      areas: ['Functional', 'Security'],
    });
  });

  it('collectSelectedIds gathers checked finding ids across blocks', () => {
    const values = {
      findings_0_0: { finding_select_0_0: { type: 'checkboxes', selected_options: [{ value: 'F1' }] } },
      findings_1_0: {
        finding_select_1_0: { type: 'checkboxes', selected_options: [{ value: 'F3' }, { value: 'F4' }] },
      },
      url_block: { url_input: { type: 'plain_text_input', value: 'x' } },
    };
    expect([...collectSelectedIds(values)].sort()).toEqual(['F1', 'F3', 'F4']);
  });

  it('findAnchorBlock matches whole anchor and start…end form', () => {
    const blocks = [
      { blockId: 'b1', text: 'The reviewer only sees pages explicitly shared with it.' },
      { blockId: 'b2', text: 'Maximum 5 reviews per member per 10 minutes here.' },
    ];
    expect(findAnchorBlock('explicitly shared', blocks)?.blockId).toBe('b1');
    expect(findAnchorBlock('Maximum 5…10 minutes here', blocks)?.blockId).toBe('b2');
    expect(findAnchorBlock('nothing matches zzz', blocks)).toBeNull();
  });

  it('renderFindingsBlocks renders a checkbox per finding + a post button', () => {
    const blocks = renderFindingsBlocks([F({ id: 'F1' }), F({ id: 'F2', severity: 'Suggestion' })], '111.222', 'http://x');
    const json = JSON.stringify(blocks);
    expect(json).toContain('F1');
    expect(json).toContain('F2');
    expect(json).toContain('checkboxes');
    expect(json).toContain('review_flc_post');
  });

  it('pre-selects every finding checkbox by default (opt-out posting)', () => {
    const blocks = renderFindingsBlocks(
      [F({ id: 'F1' }), F({ id: 'F2', severity: 'Suggestion' }), F({ id: 'F3', severity: 'Should Fix' })],
      '111.222',
      'http://x',
    );
    let checkboxCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (node: any): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === 'object') {
        if (node.type === 'checkboxes') {
          checkboxCount += 1;
          expect(Array.isArray(node.initial_options)).toBe(true);
          expect(node.initial_options).toHaveLength(node.options.length);
        }
        for (const v of Object.values(node)) walk(v);
      }
    };
    walk(blocks);
    expect(checkboxCount).toBeGreaterThan(0);
  });

  it('keeps every checkbox option text + description under Slack’s 150-char limit', () => {
    // Long real-world findings must not blow Slack's per-option limit (otherwise
    // the whole message is rejected with invalid_blocks and the review fails).
    const long = 'x'.repeat(400);
    const blocks = renderFindingsBlocks([F({ id: 'F1', message: long, section: long })], '111.222', 'http://x');
    const optionTexts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (node: any): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === 'object') {
        if (node.type === 'checkboxes' && Array.isArray(node.options)) {
          for (const opt of node.options) {
            if (opt?.text?.text) optionTexts.push(opt.text.text);
            if (opt?.description?.text) optionTexts.push(opt.description.text);
          }
        }
        for (const v of Object.values(node)) walk(v);
      }
    };
    walk(blocks);
    expect(optionTexts.length).toBeGreaterThan(0);
    for (const t of optionTexts) expect(t.length).toBeLessThanOrEqual(150);
  });

  it('renderFindingsBlocks shows a clean-bill message when there are no findings', () => {
    const blocks = renderFindingsBlocks([], '1.1', 'http://x');
    expect(JSON.stringify(blocks)).not.toContain('review_flc_post');
    expect(JSON.stringify(blocks)).toContain('no findings');
  });
});

describe('command handlers', () => {
  it('opens the modal with the invoking channel in private_metadata', async () => {
    const { app, handlers } = makeApp();
    const { deps } = makeDeps();
    registerReviewFlcCommand(app, deps);

    const ack = vi.fn();
    const open = vi.fn().mockResolvedValue({});
    await handlers['command:/review-flc']({
      ack,
      body: { channel_id: 'C42', trigger_id: 'TRIG', user_id: 'U1' },
      client: { views: { open } },
    });

    expect(ack).toHaveBeenCalled();
    const view = open.mock.calls[0][0].view;
    expect(view.callback_id).toBe('review_flc_submit');
    expect(JSON.parse(view.private_metadata)).toEqual({ channel: 'C42' });
  });

  it('rejects submit with a missing url', async () => {
    const { app, handlers } = makeApp();
    const { deps, notion } = makeDeps();
    registerReviewFlcCommand(app, deps);

    const ack = vi.fn();
    await handlers['view:review_flc_submit']({
      ack,
      body: { user: { id: 'U1' } },
      view: {
        private_metadata: '{}',
        state: {
          values: {
            url_block: { url_input: { value: '' } },
            areas_block: { areas_input: { selected_options: [{ value: 'Functional' }] } },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: { url_block: expect.any(String) },
    });
    expect(notion.getPageMarkdown).not.toHaveBeenCalled();
  });

  it('rejects submit with zero areas selected', async () => {
    const { app, handlers } = makeApp();
    const { deps } = makeDeps();
    registerReviewFlcCommand(app, deps);

    const ack = vi.fn();
    await handlers['view:review_flc_submit']({
      ack,
      body: { user: { id: 'U1' } },
      view: {
        private_metadata: '{}',
        state: {
          values: {
            url_block: { url_input: { value: 'https://notion.so/x' } },
            areas_block: { areas_input: { selected_options: [] } },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: { areas_block: expect.any(String) },
    });
  });

  it('runs the review and edits the message with rendered findings', async () => {
    const { app, handlers } = makeApp();
    const { deps, notion, slack, review } = makeDeps();
    notion.getPageMarkdown.mockResolvedValue({
      markdown: '# FLC body',
      blocks: [{ blockId: 'b1', text: 'overview sentence here' }],
    });
    review.mockResolvedValue([F({ id: 'F1' })]);
    registerReviewFlcCommand(app, deps);

    const ack = vi.fn();
    await handlers['view:review_flc_submit']({
      ack,
      body: { user: { id: 'U1' } },
      view: {
        private_metadata: JSON.stringify({ channel: 'C42' }),
        state: {
          values: {
            url_block: { url_input: { value: 'https://notion.so/x' } },
            areas_block: { areas_input: { selected_options: [{ value: 'Functional' }] } },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalledWith();
    expect(review).toHaveBeenCalledWith({ pageMarkdown: '# FLC body', areas: ['Functional'] });
    expect(slack.chat.postMessage).toHaveBeenCalled();
    const update = slack.chat.update.mock.calls[0][0];
    expect(update.channel).toBe('C42');
    expect(update.ts).toBe('111.222');
    expect(JSON.stringify(update.blocks)).toContain('review_flc_post');
  });

  it('posts selected findings as comments (block + page fallback) and reports results', async () => {
    const { app, handlers } = makeApp();
    const { deps, notion, slack, review } = makeDeps();
    notion.getPageMarkdown.mockResolvedValue({
      markdown: '# FLC body',
      blocks: [{ blockId: 'b1', text: 'the unique overview sentence here' }],
    });
    const f1 = F({ id: 'F1', anchor: 'unique overview', message: 'fix the overview' });
    const f2 = F({ id: 'F2', anchor: 'no such phrase zzz', message: 'page level note' });
    review.mockResolvedValue([f1, f2]);
    registerReviewFlcCommand(app, deps);

    // First run the review to populate the in-memory store keyed by ts.
    await handlers['view:review_flc_submit']({
      ack: vi.fn(),
      body: { user: { id: 'U1' } },
      view: {
        private_metadata: JSON.stringify({ channel: 'C42' }),
        state: {
          values: {
            url_block: { url_input: { value: 'https://notion.so/x' } },
            areas_block: { areas_input: { selected_options: [{ value: 'Functional' }] } },
          },
        },
      },
    });

    // Now click "Post selected as comments" with both findings checked.
    const ack = vi.fn();
    await handlers['action:review_flc_post']({
      ack,
      body: {
        user: { id: 'U1' },
        channel: { id: 'C42' },
        container: { message_ts: '111.222' },
        state: {
          values: {
            findings_0_0: {
              finding_select_0_0: {
                type: 'checkboxes',
                selected_options: [{ value: 'F1' }, { value: 'F2' }],
              },
            },
          },
        },
      },
    });

    expect(ack).toHaveBeenCalled();
    expect(notion.createBlockComment).toHaveBeenCalledWith('b1', 'fix the overview');
    expect(notion.createPageComment).toHaveBeenCalledWith('pageid32', 'page level note');
    // The result message is the last update on the same ts.
    const lastUpdate = slack.chat.update.mock.calls.at(-1)![0];
    expect(lastUpdate.ts).toBe('111.222');
    expect(JSON.stringify(lastUpdate.blocks)).toContain('Posted');
  });

  it('tells the user when the review has expired (no stored state)', async () => {
    const { app, handlers } = makeApp();
    const { deps, slack } = makeDeps();
    registerReviewFlcCommand(app, deps);

    const ack = vi.fn();
    await handlers['action:review_flc_post']({
      ack,
      body: {
        user: { id: 'U1' },
        channel: { id: 'C42' },
        container: { message_ts: 'unknown.ts' },
        state: { values: {} },
      },
    });
    expect(slack.chat.postEphemeral).toHaveBeenCalled();
  });
});
