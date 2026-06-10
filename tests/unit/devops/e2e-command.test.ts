import { describe, it, expect, vi } from 'vitest';
import { advanceE2eJob } from '../../../src/devops/e2e-provisioner.js';
import { buildE2eModal, parseE2eSubmission, loadAreas } from '../../../src/slack/devops/e2e-command.js';
import { renderJobBlocks } from '../../../src/devops/messages.js';
import type { Job } from '../../../src/devops/types.js';

const e2eJob: Job = {
  id: 'e1', kind: 'e2e', target: 'suite', status: 'pending',
  spec: { e2eRun: { project: 'marketplace', scope: 'smoke', area: 'Marketplace · Checkout' } },
  requestedBy: 'U1', channelId: 'C1', messageTs: 'ts', runId: null,
  error: null, createdAt: 't', updatedAt: 't', idlePingedAt: null,
};

describe('advanceE2eJob', () => {
  it('pending → creates a Qase run, dispatches qase-trigger with the options, moves to e2e_running', async () => {
    const gh = { dispatch: vi.fn().mockResolvedValue(undefined) } as any;
    const qase = { createRun: vi.fn().mockResolvedValue(777), completeRun: vi.fn(), runUrl: vi.fn() } as any;
    const patch = await advanceE2eJob(e2eJob, { gh, qase });
    expect(qase.createRun).toHaveBeenCalledWith('Slack /e2e · marketplace · smoke · Marketplace · Checkout');
    expect(gh.dispatch).toHaveBeenCalledWith('gantri-e2e', 'qase-trigger.yml', 'main', {
      marker: 'e1', project: 'marketplace', scope: 'smoke',
      include_long_running: 'false', area: 'Marketplace · Checkout', qase_run_id: '777',
    });
    expect(patch.status).toBe('e2e_running');
    expect(patch.spec?.e2eRun?.qaseRunId).toBe(777);
  });

  it('defaults area to "(all areas)" and passes grep/long-running through', async () => {
    const gh = { dispatch: vi.fn().mockResolvedValue(undefined) } as any;
    const job: Job = {
      ...e2eJob,
      spec: { e2eRun: { project: 'madeOs', scope: 'all', includeLongRunning: true, grepOverride: 'Wizard' } },
    };
    await advanceE2eJob(job, { gh });
    expect(gh.dispatch).toHaveBeenCalledWith('gantri-e2e', 'qase-trigger.yml', 'main', {
      marker: 'e1', project: 'madeOs', scope: 'all',
      include_long_running: 'true', area: '(all areas)', grep_override: 'Wizard',
    });
  });

  it('e2e_running resolves the run id, then completes the Qase run on success', async () => {
    const running: Job = { ...e2eJob, status: 'e2e_running', spec: { e2eRun: { ...e2eJob.spec.e2eRun!, qaseRunId: 777 } } };
    const gh = {
      findRunByMarker: vi.fn().mockResolvedValue(55),
      getRunState: vi.fn().mockResolvedValue('success'),
    } as any;
    const qase = { completeRun: vi.fn().mockResolvedValue(undefined) } as any;
    expect((await advanceE2eJob(running, { gh, qase })).runId).toBe(55);
    const done = await advanceE2eJob({ ...running, runId: 55 }, { gh, qase });
    expect(done.status).toBe('ready');
    expect(qase.completeRun).toHaveBeenCalledWith(777);
  });

  it('marks the job failed (and still closes the Qase run) when the workflow fails', async () => {
    const running: Job = { ...e2eJob, status: 'e2e_running', runId: 55, spec: { e2eRun: { ...e2eJob.spec.e2eRun!, qaseRunId: 777 } } };
    const gh = { getRunState: vi.fn().mockResolvedValue('failed') } as any;
    const qase = { completeRun: vi.fn().mockResolvedValue(undefined) } as any;
    const patch = await advanceE2eJob(running, { gh, qase });
    expect(patch.status).toBe('failed');
    expect(qase.completeRun).toHaveBeenCalledWith(777);
  });
});

describe('e2e modal', () => {
  it('has project/scope/area/extras/grep inputs and the submit callback', () => {
    const view = buildE2eModal();
    expect(view.callback_id).toBe('e2e_run_submit');
    const text = JSON.stringify(view);
    for (const id of ['project_input', 'scope_input', 'area_input', 'long_input', 'grep_input']) {
      expect(text).toContain(id);
    }
  });

  it('parseE2eSubmission maps the view state, dropping "(all areas)" and empties', () => {
    const v = {
      state: {
        values: {
          project_block: { project_input: { selected_option: { value: 'factoryOs' } } },
          scope_block: { scope_input: { selected_option: { value: 'regression' } } },
          area_block: { area_input: { selected_option: { value: '(all areas)' } } },
          long_block: { long_input: { selected_options: [{ value: 'long' }] } },
          grep_block: { grep_input: { value: '  ' } },
        },
      },
    };
    expect(parseE2eSubmission(v as any)).toEqual({ project: 'factoryOs', scope: 'regression', includeLongRunning: true });
  });
});

describe('loadAreas', () => {
  it('parses the AUTO-GENERATED block from qase-trigger.yml', async () => {
    const yml = [
      'options:',
      '  # AUTO-GENERATED-AREAS-START',
      "  - '(all areas)'",
      "  - 'Marketplace · Checkout'",
      "  - 'Made · Concepts'",
      '  # AUTO-GENERATED-AREAS-END',
    ].join('\n');
    const gh = { fileText: vi.fn().mockResolvedValue(yml) } as any;
    expect(await loadAreas(gh)).toEqual(['Marketplace · Checkout', 'Made · Concepts']);
  });
});

describe('renderJobBlocks (e2e)', () => {
  it('renders options + links and the passed headline', () => {
    const job: Job = {
      ...e2eJob, status: 'ready', runId: 55,
      spec: { e2eRun: { ...e2eJob.spec.e2eRun!, qaseRunId: 777 } },
    };
    const text = JSON.stringify(renderJobBlocks(job));
    expect(text).toContain('E2E run passed');
    expect(text).toContain('Marketplace · Checkout');
    expect(text).toContain('actions/runs/55');
    expect(text).toContain('run/GANTRI/dashboard/777');
  });
});
