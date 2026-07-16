import { describe, it, expect } from 'vitest';
import { renderJobBlocks, renderJobDetailBlocks, deployRollbackActions, e2eLocalConfig, carriedOverNote } from '../../../src/devops/messages.js';
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

  const fullstackReady: Job = {
    ...baseJob, target: 'fullstack', status: 'ready',
    spec: {
      backend: { ref: 'feat/as-9', slug: 'as-9', url: 'https://as-9.preview.api.gantri.com', link: 'https://github.com/gantri/porter/tree/feat/as-9' },
      frontends: [
        { repo: 'mantle', ref: 'preview-as-9', url: 'https://marketplace-git-preview-as-9-gantri.vercel.app', autoBranch: true },
        { repo: 'core', ref: 'feat/real', url: 'https://factoryos-git-feat-real-gantri.vercel.app' },
      ],
    },
  };

  it('keeps the main message compact: one links line, no Source/Deployment detail', () => {
    const text = JSON.stringify(renderJobBlocks(fullstackReady));
    expect(text).toContain('https://marketplace-git-preview-as-9-gantri.vercel.app');
    expect(text).not.toContain('Source');            // detail lives in the thread
    expect(text).not.toContain('auto branch off trunk');
  });

  it('threads the verbose breakdown via renderJobDetailBlocks (incl. auto-branch hint)', () => {
    const text = JSON.stringify(renderJobDetailBlocks(fullstackReady));
    expect(text).toContain('Source');
    expect(text).toContain('API → https://as-9.preview.api.gantri.com/api');
    expect(text).toContain('auto branch off trunk'); // the auto one is annotated
    // the non-auto frontend should not carry the hint (only one occurrence total)
    expect(text.match(/auto branch off trunk/g)).toHaveLength(1);
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

describe('deploy rendering', () => {
  it('renders the deploy as a single line — components inline, no buttons in main', () => {
    const blocks = renderJobBlocks(deployJob) as any[];
    expect(blocks).toHaveLength(1);
    const text = blocks[0].text.text as string;
    expect(text).toContain('Deployed to production');
    expect(text).toContain('<https://api.gantri.com|Porter> ✅');
    expect(JSON.stringify(blocks)).not.toContain('deploy_rollback'); // lives in the thread
  });

  it('deployRollbackActions builds the threaded button with a confirm naming the previous deploy', () => {
    const text = JSON.stringify(deployRollbackActions(deployJob));
    expect(text).toContain('deploy_rollback');
    expect(text).toContain('Rollback backend');
    expect(text).toContain('deploy-5196-2026.06.08'); // the rollback target, inside the confirm dialog
    expect(text).toContain('Roll back production?');
  });

  it('no rollback action when there is no previous deploy', () => {
    const job = { ...deployJob, spec: { deployBackend: { ...deployJob.spec.deployBackend!, prevDeployTag: undefined } } };
    expect(deployRollbackActions(job)).toBeNull();
  });

  it('no rollback action on a failed deploy', () => {
    const job = { ...deployJob, status: 'failed' as const, error: 'boom' };
    expect(deployRollbackActions(job)).toBeNull();
  });

  it('no rollback action on a frontend-only deploy (no backend)', () => {
    const job: Job = {
      ...deployJob,
      spec: { deployFrontends: [{ repo: 'mantle', tag: 'deploy-1203-2026.06.08', sha: 's', pr: 1203, url: 'https://www.gantri.com' }] },
    };
    expect(deployRollbackActions(job)).toBeNull();
  });
});

describe('carriedOverNote', () => {
  const withCarried = (carriedOver?: string[], kind: Job['kind'] = 'deploy'): Job => ({
    ...deployJob, kind,
    spec: { ...deployJob.spec, carriedOver },
  });

  it('renders the header, the fragments, and the footer', () => {
    const note = carriedOverNote(withCarried([
      '*Porter*:\n    • deploy-x-5209',
      '*Marketplace*:\n    • deploy-y-1203',
    ]))!;
    expect(note).toContain('Also shipping with this deploy');
    expect(note).toContain('deploy-x-5209');
    expect(note).toContain('deploy-y-1203');
    expect(note).toContain('Acknowledged at confirm time');
  });

  it('returns null when there is no carried-over list', () => {
    expect(carriedOverNote(withCarried(undefined))).toBeNull();
    expect(carriedOverNote(withCarried([]))).toBeNull();
  });

  it('returns null for a non-deploy job even if a list is present', () => {
    expect(carriedOverNote(withCarried(['*Porter*:\n    • deploy-x-5209'], 'preview'))).toBeNull();
  });

  it('truncates when the joined fragments overflow the Slack section limit', () => {
    const huge = Array.from({ length: 50 }, (_v, i) => `*Repo${i}*:\n` + '    • deploy-x '.repeat(60));
    const note = carriedOverNote(withCarried(huge))!;
    expect(note.length).toBeLessThanOrEqual(3000);
    expect(note).toContain('…list truncated');
    expect(note).toContain('Acknowledged at confirm time'); // footer survives the cut
  });
});
