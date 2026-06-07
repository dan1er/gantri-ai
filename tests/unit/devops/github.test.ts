import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GithubDispatcher } from '../../../src/devops/github.js';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body } as Response;
}

describe('GithubDispatcher', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('dispatch POSTs to the workflow dispatches endpoint with inputs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 204));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    await gh.dispatch('porter', 'preview-create.yml', 'master', { slug: 'as-1', job_id: 'j1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/gantri/porter/actions/workflows/preview-create.yml/dispatches');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      ref: 'master', inputs: { slug: 'as-1', job_id: 'j1' },
    });
  });

  it('findRunByMarker matches the run whose name contains the job id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      workflow_runs: [
        { id: 11, name: 'preview other', status: 'in_progress' },
        { id: 22, name: 'preview j1', status: 'in_progress' },
      ],
    }));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    const runId = await gh.findRunByMarker('porter', 'preview-create.yml', 'j1');
    expect(runId).toBe(22);
  });

  it('getRunState maps GitHub run status/conclusion', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'in_progress', conclusion: null }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', conclusion: 'success' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', conclusion: 'failure' }));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    expect(await gh.getRunState('porter', 22)).toBe('running');
    expect(await gh.getRunState('porter', 22)).toBe('success');
    expect(await gh.getRunState('porter', 22)).toBe('failed');
  });
});
