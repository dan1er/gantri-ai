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
  autoBranch?: boolean;    // ref is a throwaway branch the bot created off trunk (delete on teardown)
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
  error?: string;          // set when this component's deploy failed (retriable)
  // Per-frontend E2E gate: each frontend runs its own project's smoke in
  // parallel with its build, then promotes once green — fully independent.
  e2eRunId?: number | null;     // its gantri-e2e GitHub Actions run
  e2eQaseRunId?: number | null; // its Qase TestOps run
  e2eDispatched?: boolean;
  e2ePassed?: boolean;          // undefined = testing, true = green, false = blocked
  // Backend only: the deploy-<pr>-<date> tag that was live in prod BEFORE this
  // deploy — captured at job creation. Rolling back = re-promoting it through the
  // same prod-deploy path. Also shown in the thread as the manual fallback.
  prevDeployTag?: string;
}

export interface JobSpec {
  // `attempt` bumps on each backend refresh so the re-dispatched workflow run
  // carries a unique marker (job_id#N) — otherwise findRunByMarker could latch
  // onto the original, now-completed run and report success without re-provisioning.
  backend?: { ref: string; slug: string; url?: string; link?: string; attempt?: number };
  // A single backend preview can fan out to 1–3 frontends at once.
  frontends?: Frontend[];
  // Deploy jobs (kind = 'deploy') ship tags to production.
  deployBackend?: DeployItem;
  deployFrontends?: DeployItem[];
  // Pre-deploy E2E gate config (deploy jobs). Absent = skipped (no gate). The
  // per-frontend run state lives on each DeployItem (e2e*).
  e2e?: { scope: 'smoke' | 'both' };
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
  // When the bot last pinged the requester that this (ready backend) preview is
  // idle. NULL = never pinged; the first reminder fires ~1h after creation.
  idlePingedAt: string | null;
}

export const TERMINAL_STATUSES: readonly JobStatus[] = ['ready', 'failed', 'torn_down'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
