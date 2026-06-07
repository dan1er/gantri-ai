import type { FrontendRepo } from './types.js';

const PROJECT_BY_REPO: Record<FrontendRepo, string> = {
  mantle: 'marketplace',
  core: 'factoryos',
  made: 'made',
};

// The build-time API-URL var differs per app (the frontend bakes it in).
const API_URL_VAR: Record<FrontendRepo, string> = {
  mantle: 'NEXT_PUBLIC_API_URL',
  core: 'REACT_APP_API_URL',
  made: 'VITE_API_URL',
};

function sanitizeBranch(ref: string): string {
  return ref.replace(/^.*\//, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

export interface VercelClientDeps {
  token: string;
  teamId: string;
  fetch?: typeof fetch;
}

/**
 * Minimal Vercel client for the dev-ops orchestrator. Structurally satisfies
 * the provisioner's `VercelReader`.
 */
export class VercelClient {
  private readonly fetch: typeof fetch;
  constructor(private readonly deps: VercelClientDeps) {
    this.fetch = deps.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.deps.token}`, 'Content-Type': 'application/json' };
  }

  private async project(repo: FrontendRepo): Promise<{ id: string; repoId: number; name: string }> {
    const name = PROJECT_BY_REPO[repo];
    const res = await this.fetch(`https://api.vercel.com/v9/projects/${name}?teamId=${this.deps.teamId}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`vercel project ${name} lookup failed: ${res.status}`);
    const body = (await res.json()) as { id: string; link?: { repoId?: number } };
    return { id: body.id, repoId: body.link?.repoId ?? 0, name };
  }

  /** Frontend-only: the branch's existing preview (built against staging). No wiring. */
  previewUrlForBranch(repo: FrontendRepo, ref: string): Promise<string> {
    return Promise.resolve(`https://${PROJECT_BY_REPO[repo]}-git-${sanitizeBranch(ref)}-gantri.vercel.app`);
  }

  /**
   * Full-stack: point the frontend branch at the backend preview by setting the
   * branch-scoped API-URL env var, then trigger a rebuild (the URL is baked at
   * build time, so a redeploy is required). Returns the stable branch URL, which
   * the new build will serve once it's ready.
   */
  async wireAndRedeploy(repo: FrontendRepo, ref: string, backendUrl: string): Promise<string> {
    const { id, repoId, name } = await this.project(repo);
    const branch = sanitizeBranch(ref);

    const envRes = await this.fetch(`https://api.vercel.com/v10/projects/${id}/env?upsert=true&teamId=${this.deps.teamId}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        key: API_URL_VAR[repo],
        value: backendUrl,
        type: 'plain',
        target: ['preview'],
        gitBranch: branch,
      }),
    });
    if (!envRes.ok) throw new Error(`vercel env set failed: ${envRes.status}`);

    const depRes = await this.fetch(`https://api.vercel.com/v13/deployments?teamId=${this.deps.teamId}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name, project: id, gitSource: { type: 'github', ref, repoId } }),
    });
    if (!depRes.ok) throw new Error(`vercel redeploy failed: ${depRes.status}`);

    return `https://${name}-git-${branch}-gantri.vercel.app`;
  }
}
