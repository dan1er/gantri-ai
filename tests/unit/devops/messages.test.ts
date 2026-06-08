import { describe, it, expect } from 'vitest';
import { renderJobBlocks } from '../../../src/devops/messages.js';
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
