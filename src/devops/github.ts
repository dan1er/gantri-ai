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
}
