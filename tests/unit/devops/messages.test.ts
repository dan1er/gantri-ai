import { describe, it, expect } from 'vitest';
import { renderJobBlocks, e2eLocalConfig } from '../../../src/devops/messages.js';
import type { Job } from '../../../src/devops/types.js';

const baseJob: Job = {
  id: 'j1', kind: 'preview', target: 'backend', status: 'backend_running',
  spec: { backend: { ref: 'feat/as-2215', slug: 'as-2215' } },
  requestedBy: 'U1', channelId: 'C1', messageTs: null, runId: 5,
  error: null, createdAt: 't', updatedAt: 't',
};

describe('renderJobBlocks', () => {
  it('shows a building backend with the requester', () => {
    const blocks = renderJobBlocks(baseJob);
    const text = JSON.stringify(blocks);
    expect(text).toContain('<@U1>');
    expect(text).toContain('as-2215');
    expect(text).toContain('⏳');
  });

  it('shows the URL and a Tear down button when ready', () => {
    const blocks = renderJobBlocks({
      ...baseJob, status: 'ready',
      spec: { backend: { ref: 'feat/as-2215', slug: 'as-2215', url: 'https://as-2215.preview.api.gantri.com' } },
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('https://as-2215.preview.api.gantri.com');
    expect(text).toContain('Tear down');
    expect(text).toContain('preview_teardown');
  });

  it('shows the error when failed', () => {
    const blocks = renderJobBlocks({ ...baseJob, status: 'failed', error: 'boom' });
    expect(JSON.stringify(blocks)).toContain('boom');
  });
});

const deployJob: Job = {
  id: 'd1', kind: 'deploy', target: 'backend', status: 'ready',
  spec: { deployBackend: { tag: 'deploy-5198-2026.06.08', sha: 's', pr: 5198, url: 'https://api.gantri.com', prevDeployTag: 'deploy-5196-2026.06.08' } },
  requestedBy: 'U1', channelId: 'C1', messageTs: 'ts', runId: 9,
  error: null, createdAt: 't', updatedAt: 't',
};

describe('e2eLocalConfig', () => {
  const readyFullstack: Job = {
    id: 'p1', kind: 'preview', target: 'fullstack', status: 'ready',
    spec: {
      backend: { ref: 'feat/as-1', slug: 'as-1', url: 'https://as-1.preview.api.gantri.com' },
      frontends: [
        { repo: 'mantle', ref: 'feat/as-1', url: 'https://marketplace-git-feat-as-1-gantri.vercel.app' },
        { repo: 'core', ref: 'feat/other', url: 'https://factoryos-git-feat-other-gantri.vercel.app' },
      ],
    },
    requestedBy: 'U1', channelId: 'C1', messageTs: 'ts', runId: 9, error: null, createdAt: 't', updatedAt: 't',
  };

  it('builds the env + tunnel block for a ready preview with a backend', () => {
    const cfg = e2eLocalConfig(readyFullstack)!;
    expect(cfg).toContain('E2E_TARGET=preview');
    expect(cfg).toContain('PORTER_API_URL=https://as-1.preview.api.gantri.com');
    expect(cfg).toContain('MARKETPLACE_BASE_URL=https://marketplace-git-feat-as-1-gantri.vercel.app');
    expect(cfg).toContain('FACTORYOS_BASE_URL=https://factoryos-git-feat-other-gantri.vercel.app');
    expect(cfg).toContain('PORTER_STAGING_DB_HOST=localhost');
    expect(cfg).toContain('PORTER_STAGING_DB_SSL=false');
    expect(cfg).toContain('preview-db-tunnel.sh as-1'); // tunnel keyed off the backend slug
  });

  it('returns null for a frontend-only preview (no preview API/DB)', () => {
    const fe: Job = { ...readyFullstack, target: 'frontend', spec: { frontends: [{ repo: 'mantle', ref: 'x', url: 'https://u' }] } };
    expect(e2eLocalConfig(fe)).toBeNull();
  });

  it('returns null until the preview is ready', () => {
    expect(e2eLocalConfig({ ...readyFullstack, status: 'backend_running', spec: { backend: { ref: 'feat/as-1', slug: 'as-1' } } })).toBeNull();
  });
});

describe('renderJobBlocks — deploy rollback button', () => {
  it('shows a Rollback backend button with a confirm dialog naming the previous deploy when ready', () => {
    const text = JSON.stringify(renderJobBlocks(deployJob));
    expect(text).toContain('deploy_rollback');
    expect(text).toContain('Rollback backend');
    expect(text).toContain('deploy-5196-2026.06.08'); // the rollback target, inside the confirm dialog
    expect(text).toContain('Roll back production?');
  });

  it('hides the rollback button when there is no previous deploy', () => {
    const job = { ...deployJob, spec: { deployBackend: { ...deployJob.spec.deployBackend!, prevDeployTag: undefined } } };
    expect(JSON.stringify(renderJobBlocks(job))).not.toContain('deploy_rollback');
  });

  it('hides the rollback button on a failed deploy', () => {
    const job = { ...deployJob, status: 'failed' as const, error: 'boom' };
    expect(JSON.stringify(renderJobBlocks(job))).not.toContain('deploy_rollback');
  });

  it('hides the rollback button on a frontend-only deploy (no backend)', () => {
    const job: Job = {
      ...deployJob,
      spec: { deployFrontends: [{ repo: 'mantle', tag: 'deploy-1203-2026.06.08', sha: 's', pr: 1203, url: 'https://www.gantri.com' }] },
    };
    expect(JSON.stringify(renderJobBlocks(job))).not.toContain('deploy_rollback');
  });
});
