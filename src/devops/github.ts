export type RunState = 'running' | 'success' | 'failed';

/**
 * Extract the PR number from a deploy tag. Accepts the current date-first format
 * `deploy-<YYYY.MM.DD>-<pr>` and the legacy pr-first `deploy-<pr>-<YYYY.MM.DD>`
 * so old tags still parse during/after the rename.
 */
export function prFromTag(tag: string): number | null {
  const m =
    tag.match(/^deploy-\d{4}\.\d{2}\.\d{2}-(\d+)$/) ?? tag.match(/^deploy-(\d+)-\d{4}\.\d{2}\.\d{2}$/);
  return m ? Number(m[1]) : null;
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

  /** Open PRs for a repo, most-recently-updated first (for the picker). */
  async listOpenPRs(repo: string, limit = 30): Promise<{ number: number; title: string; url: string; head: string }[]> {
    const res = await this.fetch(
      `${this.base(repo)}/pulls?state=open&per_page=${limit}&sort=updated&direction=desc`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`list PRs failed: ${res.status}`);
    const body = (await res.json()) as { number: number; title: string; html_url: string; head: { ref: string } }[];
    return body.map((p) => ({ number: p.number, title: p.title, url: p.html_url, head: p.head.ref }));
  }

  /**
   * `deploy-*` tags for a repo, newest COMMIT first (for the /deploy picker).
   * Ordered by the tag's commit date, not the PR number — a PR can be merged
   * out of numeric order (a low number merged late), so PR number is not a
   * reliable proxy for "what is newer / already shipped".
   */
  async listDeployTags(repo: string, limit = 25): Promise<{ tag: string; sha: string; pr: number | null; committedAt: string }[]> {
    const res = await this.fetch(`${this.base(repo)}/git/matching-refs/tags/deploy-`, { headers: this.headers() });
    if (!res.ok) throw new Error(`list tags failed: ${res.status}`);
    const body = (await res.json()) as { ref: string; object: { sha: string } }[];
    const withMeta = await Promise.all(
      body.map(async (r) => {
        const tag = r.ref.replace('refs/tags/', '');
        const sha = r.object.sha;
        let committedAt = '';
        try {
          const c = await this.fetch(`${this.base(repo)}/commits/${sha}`, { headers: this.headers() });
          if (c.ok) committedAt = ((await c.json()) as { commit?: { committer?: { date?: string } } })?.commit?.committer?.date ?? '';
        } catch {
          // leave empty — tag sorts last, still selectable
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
