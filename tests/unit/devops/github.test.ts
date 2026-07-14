import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GithubDispatcher, prFromTag, PR_DIFF_MAX_CHARS } from '../../../src/devops/github.js';

function textResponse(text: string, status = 200) {
  return { ok: status < 300, status, text: async () => text } as Response;
}

describe('prFromTag', () => {
  it('parses the date-first format (PR last)', () => {
    expect(prFromTag('deploy-2026.06.09-5180')).toBe(5180);
  });
  it('parses the timestamped date-first format (PR last)', () => {
    expect(prFromTag('deploy-2026.06.09.15.54.07-5180')).toBe(5180);
  });
  it('still parses the legacy pr-first format', () => {
    expect(prFromTag('deploy-5180-2026.06.09')).toBe(5180);
  });
  it('returns null for an unparseable tag', () => {
    expect(prFromTag('deploy-weird')).toBeNull();
    expect(prFromTag('v2026.06.09')).toBeNull();
  });
});

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

  it('resolveRef returns a branch unchanged + a tree link (no lookup)', async () => {
    const fetchMock = vi.fn();
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    expect(await gh.resolveRef('porter', 'feat/as-1-x')).toEqual({
      ref: 'feat/as-1-x', link: 'https://github.com/gantri/porter/tree/feat/as-1-x',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolveRef looks up a PR number and a PR URL to its head branch + PR link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      head: { ref: 'feat/as-2215-x' }, html_url: 'https://github.com/gantri/porter/pull/5180',
    }));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    expect(await gh.resolveRef('porter', '5180')).toEqual({
      ref: 'feat/as-2215-x', link: 'https://github.com/gantri/porter/pull/5180',
    });
    expect(await gh.resolveRef('porter', 'https://github.com/gantri/porter/pull/5180')).toEqual({
      ref: 'feat/as-2215-x', link: 'https://github.com/gantri/porter/pull/5180',
    });
    expect(fetchMock.mock.calls[0][0] as string).toBe('https://api.github.com/repos/gantri/porter/pulls/5180');
  });

  it('resolveRef throws when the PR is not found', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    await expect(gh.resolveRef('porter', '999')).rejects.toThrow(/PR #999 not found/);
  });

  it('ensureBranch is a no-op when the branch already exists', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ref: 'refs/heads/preview-as-1' }, 200));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    await gh.ensureBranch('mantle', 'preview-as-1');
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the existence check
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/gantri/mantle/git/ref/heads/preview-as-1');
  });

  it('ensureBranch creates the branch off the trunk HEAD when missing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'Not Found' }, 404))        // existence check: missing
      .mockResolvedValueOnce(jsonResponse({ default_branch: 'master' }))          // repo → default branch
      .mockResolvedValueOnce(jsonResponse({ object: { sha: 'abc123' } }))         // trunk ref → sha
      .mockResolvedValueOnce(jsonResponse({}, 201));                              // create ref
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    await gh.ensureBranch('mantle', 'preview-as-1');
    const createCall = fetchMock.mock.calls[3];
    expect(createCall[0]).toBe('https://api.github.com/repos/gantri/mantle/git/refs');
    expect(JSON.parse((createCall[1] as RequestInit).body as string)).toEqual({
      ref: 'refs/heads/preview-as-1', sha: 'abc123',
    });
  });

  it('ensureBranch tolerates a 422 race on create', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({ default_branch: 'main' }))
      .mockResolvedValueOnce(jsonResponse({ object: { sha: 'deadbeef' } }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Reference already exists' }, 422));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    await expect(gh.ensureBranch('core', 'preview-as-2')).resolves.toBeUndefined();
  });

  it('listOpenPRs returns head sha and body for the re-check', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([
      { number: 7, title: 'Fix', html_url: 'https://github.com/gantri/mantle/pull/7', body: 'links app.asana.com/0/1/2', head: { ref: 'feat/x', sha: 'sha7' } },
    ]));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    const prs = await gh.listOpenPRs('mantle');
    expect(prs[0]).toEqual({
      number: 7, title: 'Fix', url: 'https://github.com/gantri/mantle/pull/7',
      head: 'feat/x', sha: 'sha7', body: 'links app.asana.com/0/1/2',
    });
  });

  it('listOpenPRs coerces a null body to an empty string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([
      { number: 8, title: 'No body', html_url: 'u', body: null, head: { ref: 'b', sha: 's' } },
    ]));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    const prs = await gh.listOpenPRs('mantle');
    expect(prs[0].body).toBe('');
  });

  it('prDiff requests the diff media type and returns an untruncated small diff', async () => {
    const diff = 'diff --git a/x b/x\n+line';
    const fetchMock = vi.fn().mockResolvedValue(textResponse(diff));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    const out = await gh.prDiff('porter', 5180);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/gantri/porter/pulls/5180');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Accept: 'application/vnd.github.diff' });
    expect(out).toEqual({ diff, truncated: false });
  });

  it('prDiff truncates an oversized diff and marks it', async () => {
    const huge = 'x'.repeat(PR_DIFF_MAX_CHARS + 5000);
    const fetchMock = vi.fn().mockResolvedValue(textResponse(huge));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    const out = await gh.prDiff('porter', 1);
    expect(out.truncated).toBe(true);
    expect(out.diff.length).toBeGreaterThan(PR_DIFF_MAX_CHARS);
    expect(out.diff.startsWith('x'.repeat(PR_DIFF_MAX_CHARS))).toBe(true);
    expect(out.diff).toContain('truncated');
  });

  it('prDiff throws on a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('Not Found', 404));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    await expect(gh.prDiff('porter', 9)).rejects.toThrow(/get PR diff porter#9 failed: 404/);
  });

  it('deleteBranch DELETEs the ref and tolerates a 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 404));
    const gh = new GithubDispatcher({ token: 't', owner: 'gantri', fetch: fetchMock });
    await gh.deleteBranch('mantle', 'preview-as-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/gantri/mantle/git/refs/heads/preview-as-1');
    expect((init as RequestInit).method).toBe('DELETE');
  });

});
