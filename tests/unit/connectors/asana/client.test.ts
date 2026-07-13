import { describe, it, expect, vi } from 'vitest';
import { AsanaApiClient, AsanaApiError } from '../../../../src/connectors/asana/client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('AsanaApiClient auth + core', () => {
  it('attaches Authorization: Bearer header on every request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const client = new AsanaApiClient({ accessToken: 'pat_abc', fetchImpl });
    await client.getProjectTasks('123', 'name');
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer pat_abc');
    expect(opts.headers.Accept).toBe('application/json');
  });

  it('passes opt_fields + limit in the query string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    await client.getProjectTasks('123', 'name,completed');
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/projects/123/tasks');
    expect(String(url)).toContain('limit=100');
    expect(String(url)).toMatch(/opt_fields=name(%2C|,)completed/);
  });

  it('getCurrentUser hits /users/me and returns data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { gid: '9', name: 'Danny' } }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const me = await client.getCurrentUser();
    expect(me).toEqual({ gid: '9', name: 'Danny' });
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/users/me');
  });

  it('getTaskStories hits /tasks/{gid}/stories', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ gid: 's1', resource_subtype: 'comment_added', text: 'hi' }],
    }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const stories = await client.getTaskStories('42', 'text');
    expect(stories.length).toBe(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/tasks/42/stories');
  });
});

describe('AsanaApiClient pagination', () => {
  it('follows next_page.offset until exhausted', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ gid: '1' }], next_page: { offset: 'OFF1', path: '', uri: '' } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ gid: '2' }], next_page: null }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const tasks = await client.getProjectTasks('123', 'name');
    expect(tasks.map((t) => t.gid)).toEqual(['1', '2']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // First call has no offset; second carries the offset token.
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain('offset=');
    expect(String(fetchImpl.mock.calls[1][0])).toContain('offset=OFF1');
  });

  it('stops after a page with no next_page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [{ gid: 'x' }] }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    const tasks = await client.getProjectTasks('123', 'name');
    expect(tasks.length).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('AsanaApiClient error + retry', () => {
  it('throws AsanaApiError on 401 with status + body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: 'Not Authorized' }] }, 401));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl });
    await expect(client.getCurrentUser()).rejects.toBeInstanceOf(AsanaApiError);
    try {
      await client.getCurrentUser();
    } catch (e) {
      expect((e as AsanaApiError).status).toBe(401);
      expect((e as AsanaApiError).body).toEqual({ errors: [{ message: 'Not Authorized' }] });
    }
  });

  it('retries once on 429 then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: { gid: '9', name: 'Danny' } }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl, retryDelayMs: 1 });
    const me = await client.getCurrentUser();
    expect(me.name).toBe('Danny');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries once on 5xx then throws if still failing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    const client = new AsanaApiClient({ accessToken: 'tok', fetchImpl, retryDelayMs: 1 });
    await expect(client.getCurrentUser()).rejects.toBeInstanceOf(AsanaApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});
