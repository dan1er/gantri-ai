export type JobKind = 'preview' | 'deploy';
export type JobTarget = 'backend' | 'frontend' | 'fullstack';
export type FrontendRepo = 'mantle' | 'core' | 'made';

export type JobStatus =
  | 'pending'
  | 'e2e_running'
  | 'backend_running'
  | 'frontend_running'
  | 'ready'
  | 'failed'
  | 'torn_down';

export interface Frontend {
  repo: FrontendRepo;
  ref: string;
  url?: string;            // stable git-branch preview URL
  deploymentUrl?: string;  // the specific Vercel deployment that was triggered
  link?: string;           // PR / branch source link
}

export interface DeployItem {
  repo?: FrontendRepo;     // absent = backend (porter)
  tag: string;
  sha: string;
  pr: number | null;
  url?: string;            // prod URL once shipped
  deploymentUrl?: string;  // Vercel inspector (frontend)
  deploymentId?: string;   // frontend poll handle
  projectId?: string;      // frontend promote handle
}

export interface JobSpec {
  backend?: { ref: string; slug: string; url?: string; link?: string };
  // A single backend preview can fan out to 1–3 frontends at once.
  frontends?: Frontend[];
  // Deploy jobs (kind = 'deploy') ship tags to production.
  deployBackend?: DeployItem;
  deployFrontends?: DeployItem[];
  // Pre-deploy E2E gate (deploy jobs). Absent = skipped. Dispatches gantri-e2e
  // qase-trigger (→ a Qase run) for the deployed frontend's project.
  e2e?: {
    scope: 'smoke' | 'both';
    project?: string;          // gantri-e2e Playwright project (marketplace/factoryOs/madeOs)
    runId?: number | null;     // the GitHub Actions run
    qaseRunId?: number | null; // the Qase TestOps run the bot created up front
    passed?: boolean;
    dispatched?: boolean;      // guards against re-dispatch on a failed state update
  };
}

export interface Job {
  id: string;
  kind: JobKind;
  target: JobTarget;
  status: JobStatus;
  spec: JobSpec;
  requestedBy: string;
  channelId: string;
  messageTs: string | null;
  runId: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const TERMINAL_STATUSES: readonly JobStatus[] = ['ready', 'failed', 'torn_down'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
