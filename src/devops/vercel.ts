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

const PROD_DOMAIN: Record<FrontendRepo, string> = {
  mantle: 'https://www.gantri.com',
  core: 'https://admin.gantri.com',
  made: 'https://made.gantri.com',
};

function sanitizeBranch(ref: string): string {
  // Match Vercel's git-branch alias: keep the WHOLE branch, just lowercase and
  // turn non-alphanumerics into '-' (feat/x -> feat-x). Do NOT strip the path
  // prefix — that yields a branch the repo doesn't have.
  return ref.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
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
  async wireAndRedeploy(repo: FrontendRepo, ref: string, backendUrl: string): Promise<{ url: string; deploymentUrl?: string }> {
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
        gitBranch: ref, // the REAL branch — Vercel 400s on a branch the repo doesn't have
      }),
    });
    if (!envRes.ok) throw new Error(`vercel env set failed: ${envRes.status}`);

    const depRes = await this.fetch(`https://api.vercel.com/v13/deployments?teamId=${this.deps.teamId}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name, project: id, gitSource: { type: 'github', ref, repoId } }),
    });
    if (!depRes.ok) throw new Error(`vercel redeploy failed: ${depRes.status}`);
    const dep = (await depRes.json()) as { inspectorUrl?: string; url?: string };
    // The Vercel dashboard page for the deployment (build logs / status).
    const deploymentUrl = dep.inspectorUrl ?? (dep.url ? `https://${dep.url}` : undefined);

    return { url: `https://${name}-git-${branch}-gantri.vercel.app`, deploymentUrl };
  }

  prodUrl(repo: FrontendRepo): string {
    return PROD_DOMAIN[repo];
  }

  /** Production-target deploy of a ref (tag/commit) — built with prod env vars, not yet aliased. */
  async deployToProd(repo: FrontendRepo, ref: string): Promise<{ projectId: string; deploymentId: string; inspectorUrl?: string }> {
    const { id, repoId, name } = await this.project(repo);
    const res = await this.fetch(`https://api.vercel.com/v13/deployments?teamId=${this.deps.teamId}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ name, project: id, target: 'production', gitSource: { type: 'github', ref, repoId } }),
    });
    if (!res.ok) throw new Error(`vercel prod deploy failed: ${res.status}`);
    const dep = (await res.json()) as { id?: string; uid?: string; inspectorUrl?: string };
    return { projectId: id, deploymentId: dep.id ?? dep.uid ?? '', inspectorUrl: dep.inspectorUrl };
  }

  async deploymentState(deploymentId: string): Promise<'building' | 'ready' | 'error'> {
    const res = await this.fetch(`https://api.vercel.com/v13/deployments/${deploymentId}?teamId=${this.deps.teamId}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`vercel deployment get failed: ${res.status}`);
    const body = (await res.json()) as { readyState?: string; status?: string };
    const s = body.readyState ?? body.status ?? '';
    if (s === 'READY') return 'ready';
    if (s === 'ERROR' || s === 'CANCELED') return 'error';
    return 'building';
  }

  /** Alias a ready production deployment to the prod domain(s). */
  async promoteToProd(projectId: string, deploymentId: string): Promise<void> {
    const res = await this.fetch(
      `https://api.vercel.com/v10/projects/${projectId}/promote/${deploymentId}?teamId=${this.deps.teamId}`,
      { method: 'POST', headers: this.headers() },
    );
    if (res.ok) return;
    // A target=production deployment can become production on its own (auto
    // domain assignment); the explicit promote then 409s with "already the
    // current production deployment" — that's success, not a failure.
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (/already the current production deployment/i.test(body.error?.message ?? '')) return;
    }
    throw new Error(`vercel promote failed: ${res.status}`);
  }
}
