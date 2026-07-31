import { describe, it, expect, vi } from 'vitest';
import { advanceCronJob } from '../../../src/devops/cron-provisioner.js';
import {
  buildCronModal, parseCronSubmission, loadCronjobs,
  normalizeCronQuery, matchCronEntry, suggestCrons,
} from '../../../src/slack/devops/cron-command.js';
import { renderJobBlocks } from '../../../src/devops/messages.js';
import type { Job } from '../../../src/devops/types.js';

const cronJob: Job = {
  id: 'c1', kind: 'cron', target: 'cron', status: 'pending',
  spec: { cronRun: { environment: 'staging', cronjob: 'send-gift-cards' } },
  requestedBy: 'U1', channelId: 'C1', messageTs: 'ts', runId: null,
  error: null, createdAt: 't', updatedAt: 't', idlePingedAt: null,
};

describe('advanceCronJob', () => {
  it('pending → dispatches run-cron.yml with env + cron + marker', async () => {
    const gh = { dispatch: vi.fn().mockResolvedValue(undefined) } as any;
    const patch = await advanceCronJob(cronJob, { gh });
    expect(gh.dispatch).toHaveBeenCalledWith('porter', 'run-cron.yml', 'master', {
      environment: 'staging', cronjob: 'send-gift-cards', job_id: 'c1',
    });
    expect(patch.status).toBe('backend_running');
  });

  it('preview run dispatches with the preview_slug input', async () => {
    const gh = { dispatch: vi.fn().mockResolvedValue(undefined) } as any;
    const previewCron: Job = {
      ...cronJob, spec: { cronRun: { environment: 'preview', cronjob: 'post-created-order-actions', previewSlug: 'as-2306' } },
    };
    await advanceCronJob(previewCron, { gh });
    expect(gh.dispatch).toHaveBeenCalledWith('porter', 'run-cron.yml', 'master', {
      environment: 'preview', cronjob: 'post-created-order-actions', preview_slug: 'as-2306', job_id: 'c1',
    });
  });

  it('resolves the run id then reports success/failure', async () => {
    const running: Job = { ...cronJob, status: 'backend_running' };
    const gh = {
      findRunByMarker: vi.fn().mockResolvedValue(42),
      getRunState: vi.fn().mockResolvedValueOnce('success').mockResolvedValueOnce('failed'),
    } as any;
    expect((await advanceCronJob(running, { gh })).runId).toBe(42);
    expect((await advanceCronJob({ ...running, runId: 42 }, { gh })).status).toBe('ready');
    const failed = await advanceCronJob({ ...running, runId: 42 }, { gh });
    expect(failed.status).toBe('failed');
  });
});

describe('cron modal', () => {
  it('defaults to staging and rotates the cron block id per environment', () => {
    const v = buildCronModal();
    expect(JSON.stringify(v)).toContain('"value":"staging"');
    expect(JSON.stringify(v)).toContain('cron_block_staging');
    expect(JSON.stringify(buildCronModal('production'))).toContain('cron_block_production');
  });

  it('parseCronSubmission finds the rotated cron block by prefix', () => {
    const v = {
      state: {
        values: {
          env_block: { cron_env_input: { selected_option: { value: 'production' } } },
          cron_block_production: { cron_name_input: { selected_option: { value: 'send-gift-cards' } } },
        },
      },
    };
    expect(parseCronSubmission(v as any)).toEqual({ environment: 'production', cronjob: 'send-gift-cards' });
  });

  it('preview env adds a preview-target picker and offers all three environments', () => {
    const text = JSON.stringify(buildCronModal('preview'));
    expect(text).toContain('cron_preview_input'); // the preview-target picker block
    expect(text).toContain('cron_block_preview');
    expect(text).toContain('"value":"preview"');
    expect(text).toContain('"value":"staging"');
    expect(text).toContain('"value":"production"');
    // staging modal has no preview picker
    expect(JSON.stringify(buildCronModal('staging'))).not.toContain('cron_preview_input');
  });

  it('parseCronSubmission carries the preview slug', () => {
    const v = {
      state: {
        values: {
          env_block: { cron_env_input: { selected_option: { value: 'preview' } } },
          preview_block: { cron_preview_input: { selected_option: { value: 'as-2306' } } },
          cron_block_preview: { cron_name_input: { selected_option: { value: 'post-created-order-actions' } } },
        },
      },
    };
    expect(parseCronSubmission(v as any)).toEqual({
      environment: 'preview', cronjob: 'post-created-order-actions', previewSlug: 'as-2306',
    });
  });
});

describe('/cron <name> shorthand', () => {
  const crons = [
    { name: 'post-created-order-actions', display: 'Post created order actions' },
    { name: 'post-shipped-order-actions', display: 'Post shipped order actions' },
    { name: 'send-gift-cards', display: 'Send gift cards', description: 'Emails gift cards' },
    { name: 'calc-usage-discarded-inv', display: 'Calculate usage & discarded inventories' },
  ];

  it('normalizes spaces and underscores to the k8s name shape', () => {
    expect(normalizeCronQuery('  Post Created Order Actions ')).toBe('post-created-order-actions');
    expect(normalizeCronQuery('send_gift_cards')).toBe('send-gift-cards');
  });

  it('matches on the k8s name or the display name', () => {
    expect(matchCronEntry(crons, 'post-created-order-actions')?.name).toBe('post-created-order-actions');
    expect(matchCronEntry(crons, 'Send gift cards')?.name).toBe('send-gift-cards');
  });

  it('refuses partial matches so a near-miss never fires on production', () => {
    expect(matchCronEntry(crons, 'post-created')).toBeUndefined();
    expect(matchCronEntry(crons, 'gift')).toBeUndefined();
  });

  it('offers close matches for an unresolved name', () => {
    expect(suggestCrons(crons, 'post').map((c) => c.name)).toEqual([
      'post-created-order-actions', 'post-shipped-order-actions',
    ]);
    expect(suggestCrons(crons, 'nothing-like-this')).toEqual([]);
  });
});

describe('loadCronjobs', () => {
  it('parses names + labels from base + prod overlay, honoring display-name annotations', async () => {
    const base = [
      '---', 'apiVersion: batch/v1', 'kind: CronJob', 'metadata:', '  name: alpha-cron',
      '  annotations:', '    gantri.com/display-name: "Alpha (curated)"',
      '    gantri.com/description: "Does the alpha thing nightly"',
      '---', 'kind: CronJob', 'metadata:', '  name: send-gift-cards',
    ].join('\n');
    const prod = ['---', 'kind: CronJob', 'metadata:', '  name: prod-only-cron'].join('\n');
    const gh = {
      fileText: vi.fn().mockImplementation((_r: string, path: string) =>
        Promise.resolve(path.includes('prod') ? prod : base)),
    } as any;
    const staging = await loadCronjobs(gh, 'staging');
    expect(staging).toEqual([
      { name: 'alpha-cron', display: 'Alpha (curated)', description: 'Does the alpha thing nightly' },
      { name: 'send-gift-cards', display: 'Send gift cards' }, // humanized fallback, no description
    ]);
    const production = await loadCronjobs(gh, 'production');
    expect(production.map((c) => c.name)).toEqual(['alpha-cron', 'prod-only-cron', 'send-gift-cards']);
  });
});

describe('renderJobBlocks (cron)', () => {
  it('renders the cron, env badge, and workflow link', () => {
    const job: Job = { ...cronJob, status: 'ready', runId: 77, spec: { cronRun: { environment: 'production', cronjob: 'send-gift-cards' } } };
    const text = JSON.stringify(renderJobBlocks(job));
    expect(text).toContain('Cron run completed');
    expect(text).toContain('send-gift-cards');
    expect(text).toContain('production');
    expect(text).toContain('porter/actions/runs/77');
  });

  it('leads with the display name and shows the description when annotated', () => {
    const job: Job = {
      ...cronJob, status: 'backend_running',
      spec: { cronRun: { environment: 'staging', cronjob: 'send-gift-cards', display: 'Send gift cards', description: 'Emails gift cards on their scheduled send date' } },
    };
    const text = JSON.stringify(renderJobBlocks(job));
    expect(text).toContain('*Send gift cards* (`send-gift-cards`)');
    expect(text).toContain('Emails gift cards on their scheduled send date');
  });

  it('shows the preview badge with the target slug', () => {
    const job: Job = {
      ...cronJob, status: 'backend_running',
      spec: { cronRun: { environment: 'preview', cronjob: 'post-created-order-actions', previewSlug: 'as-2306' } },
    };
    const text = JSON.stringify(renderJobBlocks(job));
    expect(text).toContain('preview');
    expect(text).toContain('as-2306');
  });
});
