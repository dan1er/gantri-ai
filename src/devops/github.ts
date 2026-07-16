export type RunState = 'running' | 'success' | 'failed';

/** Character budget for a fetched PR diff. Above this the diff is truncated with
 *  a marker so the delivery-tier re-check keeps a bounded, cheap LLM payload. */
export const PR_DIFF_MAX_CHARS = 50_000;
const PR_DIFF_TRUNCATION_MARKER = `\n\n[... diff truncated at ${PR_DIFF_MAX_CHARS} chars ...]`;

/**
 * Extract the PR number from a deploy tag. Accepts the current timestamp-first
 * format `deploy-<YYYY.MM.DD[.HH.MM.SS]>-<pr>` (date, optionally with time) and
 * the legacy pr-first `deploy-<pr>-<YYYY.MM.DD>` so old tags still parse.
 */
export function prFromTag(tag: string): number | null {
  const m =
    tag.match(/^deploy-[\d.]+-(\d+)$/) ?? tag.match(/^deploy-(\d+)-\d{4}\.\d{2}\.\d{2}$/);
  return m ? Number(m[1]) : null;
}

/**
 * Sortable ISO-like timestamp derived from a deploy tag's NAME. Tags are
 * bot-authored at merge time, so the embedded timestamp IS the merge time —
 * the ordering the /deploy picker needs — and, unlike a commits-API lookup,
 * it cannot fail. Date-only formats tie-break same-day tags by PR number,
 * encoded as fractional seconds so plain string comparison still orders them.
 * Returns '' for a name with no recognizable timestamp.
 */
export function timestampFromTag(tag: string): string {
  const full = tag.match(/^deploy-(\d{4})\.(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})-\d+$/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}T${full[4]}:${full[5]}:${full[6]}Z`;
  const dateFirst = tag.match(/^deploy-(\d{4})\.(\d{2})\.(\d{2})-(\d+)$/);
  const prFirst = tag.match(/^deploy-(\d+)-(\d{4})\.(\d{2})\.(\d{2})$/);
  const parts = dateFirst
    ? [dateFirst[1], dateFirst[2], dateFirst[3], dateFirst[4]]
    : prFirst
      ? [prFirst[2], prFirst[3], prFirst[4], prFirst[1]]
      : null;
  if (!parts) return '';
  const [y, m, d, pr] = parts;
  return `${y}-${m}-${d}T00:00:00.${pr.padStart(6, '0').slice(-6)}Z`;
}

export interface GithubDispatcherDeps {
  token: string;
  owner: string;
  fetch?: typeof fetch;
}

export class GithubDispatcher {
  private readonly fetch: typeof fetch;
  constructor(private readonly deps: GithubDispatcherDeps) {
    this.fetch = deps.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.deps.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  private base(repo: string): string {
    return `https://api.github.com/repos/${this.deps.owner}/${repo}`;
  }

  /** The GitHub org/owner these requests target (GITHUB_OWNER). Exposed so the
   *  delivery-tier authoritative pass can accept a PR link under ANY repo owned by
   *  this org, not just the configured sweep list. */
  get owner(): string {
    return this.deps.owner;
  }

  async dispatch(
    repo: string, workflow: string, ref: string, inputs: Record<string, string>,
  ): Promise<void> {
    const res = await this.fetch(
      `${this.base(repo)}/actions/workflows/${workflow}/dispatches`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify({ ref, inputs }) },
    );
    if (!res.ok) throw new Error(`workflow dispatch failed: ${res.status}`);
  }

  async findRunByMarker(repo: string, workflow: string, jobId: string): Promise<number | null> {
    const res = await this.fetch(
      `${this.base(repo)}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=20`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`list runs failed: ${res.status}`);
    const body = (await res.json()) as { workflow_runs: { id: number; name?: string }[] };
    const run = body.workflow_runs.find((r) => (r.name ?? '').includes(jobId));
    return run?.id ?? null;
  }

  async getRunState(repo: string, runId: number): Promise<RunState> {
    const res = await this.fetch(`${this.base(repo)}/actions/runs/${runId}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`get run failed: ${res.status}`);
    const body = (await res.json()) as { status: string; conclusion: string | null };
    if (body.status !== 'completed') return 'running';
    return body.conclusion === 'success' ? 'success' : 'failed';
  }

  /**
   * Resolve user input to a real git branch ref + a human link for `repo`.
   * Accepts a branch name, a bare PR number, or a full PR URL (…/pull/123); for
   * a PR it looks up the head branch and links to the PR, for a branch it links
   * to the branch tree.
   */
  async resolveRef(repo: string, input: string): Promise<{ ref: string; link: string }> {
    const trimmed = input.trim();
    const repoUrl = `https://github.com/${this.deps.owner}/${repo}`;
    const fromUrl = trimmed.match(/\/pull\/(\d+)/)?.[1];
    const prNumber = fromUrl ?? (/^\d+$/.test(trimmed) ? trimmed : null);
    if (!prNumber) return { ref: trimmed, link: `${repoUrl}/tree/${trimmed}` };
    const res = await this.fetch(`${this.base(repo)}/pulls/${prNumber}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`PR #${prNumber} not found in ${repo} (${res.status})`);
    const body = (await res.json()) as { head?: { ref?: string }; html_url?: string };
    if (!body.head?.ref) throw new Error(`PR #${prNumber} has no head branch`);
    return { ref: body.head.ref, link: body.html_url ?? `${repoUrl}/pull/${prNumber}` };
  }

  /** Open PRs for a repo, most-recently-updated first (for the picker AND the
   *  delivery-tier PR re-check, which needs the head sha for dedupe and the body
   *  to find the linked Asana task). */
  async listOpenPRs(
    repo: string,
    limit = 30,
  ): Promise<{ number: number; title: string; url: string; head: string; sha: string; body: string }[]> {
    const res = await this.fetch(
      `${this.base(repo)}/pulls?state=open&per_page=${limit}&sort=updated&direction=desc`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`list PRs failed: ${res.status}`);
    const body = (await res.json()) as {
      number: number; title: string; html_url: string; body: string | null; head: { ref: string; sha: string };
    }[];
    return body.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.html_url,
      head: p.head.ref,
      sha: p.head.sha,
      body: p.body ?? '',
    }));
  }

  /**
   * A single PR by number (open OR merged), with the same shape as `listOpenPRs`
   * plus its `state`/`merged` flags. The delivery-tier authoritative pass uses
   * this to diff a PR the TICKET links directly (in its notes/comments/Notes-for-QA
   * subtask) instead of only PRs the open-PR scan happens to surface — a merged PR
   * is invisible to that scan but still fully diffable here. Returns `null` on 404
   * (a stale/typo link) so the caller degrades to the open-PR scan rather than
   * failing the task. Dedupe stays `(repo, number, head.sha)`.
   */
  async getPr(
    repo: string,
    number: number,
  ): Promise<
    | { number: number; title: string; url: string; head: string; sha: string; body: string; state: string; merged: boolean }
    | null
  > {
    const res = await this.fetch(`${this.base(repo)}/pulls/${number}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`get PR ${repo}#${number} failed: ${res.status}`);
    const p = (await res.json()) as {
      number: number; title: string; html_url: string; body: string | null;
      head: { ref: string; sha: string }; state: string; merged?: boolean;
    };
    return {
      number: p.number,
      title: p.title,
      url: p.html_url,
      head: p.head.ref,
      sha: p.head.sha,
      body: p.body ?? '',
      state: p.state,
      merged: p.merged ?? false,
    };
  }

  /**
   * Unified diff for a PR (GitHub `diff` media type). Truncated to a bounded
   * character budget with an explicit marker so a huge PR stays a cheap LLM
   * payload — the delivery-tier re-check reads at most `PR_DIFF_MAX_CHARS`.
   */
  async prDiff(repo: string, number: number): Promise<{ diff: string; truncated: boolean }> {
    const res = await this.fetch(`${this.base(repo)}/pulls/${number}`, {
      headers: { ...this.headers(), Accept: 'application/vnd.github.diff' },
    });
    if (!res.ok) throw new Error(`get PR diff ${repo}#${number} failed: ${res.status}`);
    const full = await res.text();
    if (full.length <= PR_DIFF_MAX_CHARS) return { diff: full, truncated: false };
    return { diff: full.slice(0, PR_DIFF_MAX_CHARS) + PR_DIFF_TRUNCATION_MARKER, truncated: true };
  }

  /**
   * `deploy-*` tags for a repo, newest first (for the /deploy picker).
   * Ordered by merge time — a PR can be merged out of numeric order (a low
   * number merged late), so PR number is not a reliable proxy for "what is
   * newer / already shipped". Merge time comes from the timestamp embedded in
   * the tag name (tags are bot-authored at merge time); the commits API is
   * only a fallback for names with no parseable timestamp, so a GitHub
   * degradation can't silently blank every date and disable the
   * already-shipped filter downstream.
   */
  async listDeployTags(repo: string, limit = 25): Promise<{ tag: string; sha: string; pr: number | null; committedAt: string }[]> {
    const res = await this.fetch(`${this.base(repo)}/git/matching-refs/tags/deploy-`, { headers: this.headers() });
    if (!res.ok) throw new Error(`list tags failed: ${res.status}`);
    const body = (await res.json()) as { ref: string; object: { sha: string } }[];
    const withMeta = await Promise.all(
      body.map(async (r) => {
        const tag = r.ref.replace('refs/tags/', '');
        const sha = r.object.sha;
        let committedAt = timestampFromTag(tag);
        if (!committedAt) {
          try {
            const c = await this.fetch(`${this.base(repo)}/commits/${sha}`, { headers: this.headers() });
            if (c.ok) committedAt = ((await c.json()) as { commit?: { committer?: { date?: string } } })?.commit?.committer?.date ?? '';
          } catch {
            // leave empty — tag sorts last, still selectable
          }
        }
        return { tag, sha, pr: prFromTag(tag), committedAt };
      }),
    );
    return withMeta.sort((a, b) => b.committedAt.localeCompare(a.committedAt)).slice(0, limit);
  }

  /** Most recent workflow_dispatch run for a workflow (poll a dispatched run that has no marker). */
  async findLatestRun(repo: string, workflow: string): Promise<number | null> {
    const res = await this.fetch(
      `${this.base(repo)}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=1`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`list runs failed: ${res.status}`);
    const body = (await res.json()) as { workflow_runs: { id: number }[] };
    return body.workflow_runs[0]?.id ?? null;
  }

  /** Raw text content of a file at a ref (GitHub contents API, raw accept). */
  async fileText(repo: string, path: string, ref = 'HEAD'): Promise<string> {
    const res = await this.fetch(`${this.base(repo)}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
      headers: { ...this.headers(), Accept: 'application/vnd.github.raw+json' },
    });
    if (!res.ok) throw new Error(`get ${repo}/${path} failed: ${res.status}`);
    return res.text();
  }

  /** The repo's default (trunk) branch name, e.g. `master`/`main`. */
  async defaultBranch(repo: string): Promise<string> {
    const res = await this.fetch(this.base(repo), { headers: this.headers() });
    if (!res.ok) throw new Error(`get repo ${repo} failed: ${res.status}`);
    const body = (await res.json()) as { default_branch?: string };
    if (!body.default_branch) throw new Error(`repo ${repo} has no default branch`);
    return body.default_branch;
  }

  /**
   * Ensure a throwaway branch exists, created off the repo's trunk HEAD. Used to
   * give a backend-only preview a real, non-production frontend branch to wire
   * (a preview-target env override never applies to the production trunk).
   * Idempotent: if the branch already exists, leaves it as-is.
   */
  async ensureBranch(repo: string, branch: string): Promise<void> {
    const head = await this.fetch(`${this.base(repo)}/git/ref/heads/${branch}`, { headers: this.headers() });
    if (head.ok) return; // already exists — reuse
    const trunk = await this.defaultBranch(repo);
    const trunkRef = await this.fetch(`${this.base(repo)}/git/ref/heads/${trunk}`, { headers: this.headers() });
    if (!trunkRef.ok) throw new Error(`get ${repo} trunk ref failed: ${trunkRef.status}`);
    const sha = ((await trunkRef.json()) as { object?: { sha?: string } }).object?.sha;
    if (!sha) throw new Error(`${repo} trunk ${trunk} has no sha`);
    const created = await this.fetch(`${this.base(repo)}/git/refs`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
    // 422 = ref already exists (raced); treat as success.
    if (!created.ok && created.status !== 422) throw new Error(`create branch ${repo}/${branch} failed: ${created.status}`);
  }

  /** Delete a branch (best-effort; used to clean up an auto-created preview branch on teardown). */
  async deleteBranch(repo: string, branch: string): Promise<void> {
    const res = await this.fetch(`${this.base(repo)}/git/refs/heads/${branch}`, {
      method: 'DELETE', headers: this.headers(),
    });
    if (!res.ok && res.status !== 404 && res.status !== 422) {
      throw new Error(`delete branch ${repo}/${branch} failed: ${res.status}`);
    }
  }
}
