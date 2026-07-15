import { describe, it, expect, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
  renderCodeReviewRequest,
  ReviewRequestNotifier,
  type CodeReviewRequestArgs,
  type ReviewRequestPr,
} from '../../../../../src/connectors/asana/tier/review-request.js';

const PERMALINK = 'https://app.asana.com/0/1210754051061529/9999999999';

function pr(repo: string, number: number): ReviewRequestPr {
  return { repo, number, url: `https://github.com/gantri/${repo}/pull/${number}` };
}

function args(over: Partial<CodeReviewRequestArgs> = {}): CodeReviewRequestArgs {
  return {
    taskName: 'Fix checkout total',
    permalink: PERMALINK,
    tier: 'T2',
    nonUiLane: false,
    prs: [pr('porter', 5285)],
    ...over,
  };
}

describe('renderCodeReviewRequest', () => {
  it('renders a single backend PR', () => {
    expect(renderCodeReviewRequest(args())).toBe(
      `🔎 Code review needed (backend): <https://github.com/gantri/porter/pull/5285|porter#5285> — Fix checkout total (${PERMALINK}) · Tier T2`,
    );
  });

  it('tags a made-engine-api PR as backend too', () => {
    const msg = renderCodeReviewRequest(args({ prs: [pr('made-engine-api', 42)], tier: 'T1' }));
    expect(msg).toContain('(backend)');
    expect(msg).toContain('<https://github.com/gantri/made-engine-api/pull/42|made-engine-api#42>');
  });

  it('renders a single frontend PR (mantle)', () => {
    const msg = renderCodeReviewRequest(args({ prs: [pr('mantle', 1230)], tier: 'T1' }));
    expect(msg).toBe(
      `🔎 Code review needed (frontend): <https://github.com/gantri/mantle/pull/1230|mantle#1230> — Fix checkout total (${PERMALINK}) · Tier T1`,
    );
  });

  it('tags Core / made / gantri-components as frontend', () => {
    for (const repo of ['core', 'made', 'gantri-components']) {
      expect(renderCodeReviewRequest(args({ prs: [pr(repo, 1)] }))).toContain('(frontend)');
    }
  });

  it('lists PRs on both sides with a "backend + frontend" tag', () => {
    const msg = renderCodeReviewRequest(args({ prs: [pr('porter', 5285), pr('mantle', 1230)], tier: 'T2' }));
    expect(msg).toBe(
      `🔎 Code review needed (backend + frontend): <https://github.com/gantri/porter/pull/5285|porter#5285>, <https://github.com/gantri/mantle/pull/1230|mantle#1230> — Fix checkout total (${PERMALINK}) · Tier T2`,
    );
  });

  it('appends the Non-UI Lane suffix only when the flag is set', () => {
    const withFlag = renderCodeReviewRequest(args({ nonUiLane: true }));
    expect(withFlag).toContain(' · Non-UI Lane: binding engineering gate (extra reviewer)');
    expect(withFlag.endsWith('· Non-UI Lane: binding engineering gate (extra reviewer)')).toBe(true);
    expect(renderCodeReviewRequest(args({ nonUiLane: false }))).not.toContain('Non-UI Lane');
  });

  it('renders the no-PR description-fallback form', () => {
    expect(renderCodeReviewRequest(args({ prs: [], tier: 'T1' }))).toBe(
      `🔎 Code review needed: Fix checkout total (${PERMALINK}) · Tier T1 — no PR linked on the ticket yet`,
    );
  });

  it('appends the Non-UI Lane suffix to the no-PR form too', () => {
    expect(renderCodeReviewRequest(args({ prs: [], tier: 'T1', nonUiLane: true }))).toBe(
      `🔎 Code review needed: Fix checkout total (${PERMALINK}) · Tier T1 — no PR linked on the ticket yet · Non-UI Lane: binding engineering gate (extra reviewer)`,
    );
  });
});

describe('ReviewRequestNotifier — failure-soft post', () => {
  it('posts to the configured channel and returns true', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true });
    const slack = { chat: { postMessage } } as unknown as WebClient;
    const notifier = new ReviewRequestNotifier({ slack, channelId: 'C-SOFTWARE' });

    const ok = await notifier.post(args());

    expect(ok).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C-SOFTWARE',
      text: renderCodeReviewRequest(args()),
    });
  });

  it('returns false (never throws) when Slack rejects', async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error('channel_not_found'));
    const slack = { chat: { postMessage } } as unknown as WebClient;
    const notifier = new ReviewRequestNotifier({ slack, channelId: 'C-SOFTWARE' });

    await expect(notifier.post(args())).resolves.toBe(false);
  });
});
