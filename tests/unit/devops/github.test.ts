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

  it('resolveRef returns a branch name unchanged (no lookup)', async () => {
    const fetchMock = vi.fn();
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    expect(await gh.resolveRef('porter', 'feat/as-1-x')).toBe('feat/as-1-x');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolveRef looks up a PR number and a PR URL to its head branch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ head: { ref: 'feat/as-2215-x' } }));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    expect(await gh.resolveRef('porter', '5180')).toBe('feat/as-2215-x');
    expect(await gh.resolveRef('porter', 'https://github.com/gantri/porter/pull/5180')).toBe('feat/as-2215-x');
    expect(fetchMock.mock.calls[0][0] as string).toBe('https://api.github.com/repos/gantri/porter/pulls/5180');
  });

  it('resolveRef throws when the PR is not found', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    await expect(gh.resolveRef('porter', '999')).rejects.toThrow(/PR #999 not found/);
  });
});
