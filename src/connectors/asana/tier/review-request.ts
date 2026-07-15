import type { WebClient } from '@slack/web-api';
import type { DeliveryTier } from '../board-config.js';
import { logger } from '../../../logger.js';

/**
 * The code-review request the Code-Review authoritative pass posts to the software
 * Slack channel the first time it classifies a ticket. It pings reviewers with the
 * PR(s), the ticket, the final tier, and — when the classification carries the
 * Non-UI Lane flag — the binding engineering-gate note.
 *
 * The renderer is a pure, deterministic function of its inputs (no LLM, no I/O), so
 * the wording is auditable and cheap to test. The poster wraps the Slack call and is
 * failure-soft: a post error is logged and reported as `false`, never thrown, so a
 * Slack outage never fails the classification pass.
 */

/** Repos whose PRs are a BACKEND review; everything else is frontend. */
const BACKEND_REPOS: ReadonlySet<string> = new Set(['porter', 'made-engine-api']);

/** The suffix appended when the classification carries the `non_ui_lane` flag. */
const NON_UI_LANE_SUFFIX = ' · Non-UI Lane: binding engineering gate (extra reviewer)';

/** One PR to list in the request. */
export interface ReviewRequestPr {
  /** Repo name as it appears in the GitHub URL (e.g. `porter`, `mantle`). */
  repo: string;
  number: number;
  /** Canonical PR URL. */
  url: string;
}

export interface CodeReviewRequestArgs {
  /** The ticket name. */
  taskName: string;
  /** Asana permalink to the ticket. */
  permalink: string;
  /** The final (authoritative) tier. */
  tier: DeliveryTier;
  /** True when the classification carries the `non_ui_lane` flag. */
  nonUiLane: boolean;
  /** The PR(s) the ticket links, or empty for the no-PR description fallback. */
  prs: ReviewRequestPr[];
}

/** True when a repo's PR is a backend review. */
function isBackendRepo(repo: string): boolean {
  return BACKEND_REPOS.has(repo.toLowerCase());
}

/** The `(backend)` / `(frontend)` / `(backend + frontend)` tag for a set of PRs. */
function sideTag(prs: ReviewRequestPr[]): string {
  const hasBackend = prs.some((p) => isBackendRepo(p.repo));
  const hasFrontend = prs.some((p) => !isBackendRepo(p.repo));
  if (hasBackend && hasFrontend) return 'backend + frontend';
  return hasBackend ? 'backend' : 'frontend';
}

/** A Slack link (`<url|repo#number>`) for a PR. */
function prLink(pr: ReviewRequestPr): string {
  return `<${pr.url}|${pr.repo}#${pr.number}>`;
}

/**
 * Render the plain single-line Slack message. With PR(s): a side-tagged header, the
 * PR link(s), the ticket, and the tier. Without a PR (the description-fallback
 * classification): the ticket, the tier, and a note that no PR is linked yet. The
 * Non-UI Lane suffix is appended in either case when the flag is present.
 */
export function renderCodeReviewRequest(args: CodeReviewRequestArgs): string {
  const { taskName, permalink, tier, nonUiLane, prs } = args;
  const laneSuffix = nonUiLane ? NON_UI_LANE_SUFFIX : '';

  if (prs.length === 0) {
    return `🔎 Code review needed: ${taskName} (${permalink}) · Tier ${tier} — no PR linked on the ticket yet${laneSuffix}`;
  }

  const links = prs.map(prLink).join(', ');
  return `🔎 Code review needed (${sideTag(prs)}): ${links} — ${taskName} (${permalink}) · Tier ${tier}${laneSuffix}`;
}

/** Posts a code-review request; returns whether the post succeeded (failure-soft). */
export interface ReviewRequestPoster {
  post(args: CodeReviewRequestArgs): Promise<boolean>;
}

export interface ReviewRequestNotifierDeps {
  slack: WebClient;
  /** The software Slack channel id (`SOFTWARE_CHANNEL_ID`). */
  channelId: string;
}

/**
 * Posts the code-review request to the software Slack channel. Failure-soft: a Slack
 * error is logged and returned as `false` (never thrown), so the caller leaves the
 * per-task dedupe flag unset and retries on the next check.
 */
export class ReviewRequestNotifier implements ReviewRequestPoster {
  constructor(private readonly deps: ReviewRequestNotifierDeps) {}

  async post(args: CodeReviewRequestArgs): Promise<boolean> {
    const text = renderCodeReviewRequest(args);
    try {
      await this.deps.slack.chat.postMessage({ channel: this.deps.channelId, text });
      return true;
    } catch (err) {
      logger.warn(
        { channel: this.deps.channelId, err: err instanceof Error ? err.message : String(err) },
        'code_review_request_post_failed',
      );
      return false;
    }
  }
}
