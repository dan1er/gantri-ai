export type RunState = 'running' | 'success' | 'failed';

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

  /** `deploy-*` tags for a repo, newest PR first (for the /deploy picker). */
  async listDeployTags(repo: string, limit = 25): Promise<{ tag: string; sha: string; pr: number | null }[]> {
    const res = await this.fetch(`${this.base(repo)}/git/matching-refs/tags/deploy-`, { headers: this.headers() });
    if (!res.ok) throw new Error(`list tags failed: ${res.status}`);
    const body = (await res.json()) as { ref: string; object: { sha: string } }[];
    return body
      .map((r) => {
        const tag = r.ref.replace('refs/tags/', '');
        const pr = Number(tag.match(/^deploy-(\d+)-/)?.[1] ?? '') || null;
        return { tag, sha: r.object.sha, pr };
      })
      .sort((a, b) => (b.pr ?? 0) - (a.pr ?? 0))
      .slice(0, limit);
  }
}
