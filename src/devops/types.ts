export type JobKind = 'preview' | 'deploy';
export type JobTarget = 'backend' | 'frontend' | 'fullstack';
export type FrontendRepo = 'mantle' | 'core' | 'made';

export type JobStatus =
  | 'pending'
  | 'backend_running'
  | 'frontend_running'
  | 'ready'
  | 'failed'
  | 'torn_down';

export interface JobSpec {
  backend?: { ref: string; slug: string; url?: string };
  frontend?: { repo: FrontendRepo; ref: string; url?: string };
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
